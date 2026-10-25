"""Review data plane: SDK-backed summaries and explicit workflow integration seams."""

from typing import Annotated
from urllib.parse import quote

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile as StarletteUploadFile

from .repository import RepositoryUnavailable, ReviewConflict, ReviewNotFound
from .imports import InvalidUpload
from .service import IntegrationPending, InvalidCursor, PostFailed, ReviewService, ReviewUpload, get_review_service

from .responses import (
    APPROVE_EXAMPLE, CREATE_EXAMPLE, CSV_EXAMPLE, GET_EXAMPLE, LIST_EXAMPLE, SSE_EXAMPLE,
    STUB_RESPONSE, ApproveReviewRequest, ApproveReviewResponse, CreateReviewResponse,
    GetReviewResponse, ListReviewResponse,
)

app = FastAPI(
    title="AfterHours review API", version="0.1.0",
    description="Create reviews and read persisted summaries/details from SpacetimeDB, with polling SSE updates. Hash-bound UI approval posts the journal through the gateway. Export remains an explicit 501 integration stub.",
)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                   allow_methods=["*"], allow_headers=["*"])

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
ALLOWED_MEDIA_TYPES = {"text/csv", "application/json", "text/plain", "application/pdf"}
Identifier = Annotated[str, Query(min_length=1, pattern=r"\S")]
Service = Annotated[ReviewService, Depends(get_review_service)]


@app.exception_handler(IntegrationPending)
async def integration_pending(_: Request, error: IntegrationPending):
    return JSONResponse(status_code=501, content={"detail": {
        "code": "NOT_IMPLEMENTED",
        "operation": error.operation,
        "message": "Backend integration is not connected yet.",
    }})


@app.exception_handler(RepositoryUnavailable)
async def repository_unavailable(_: Request, error: RepositoryUnavailable):
    return JSONResponse(status_code=503, content={"detail": {
        "code": "STORAGE_UNAVAILABLE", "message": str(error),
    }})


@app.exception_handler(InvalidCursor)
@app.exception_handler(InvalidUpload)
async def invalid_cursor(_: Request, error: InvalidCursor):
    return JSONResponse(status_code=422, content={"detail": str(error)})


@app.exception_handler(ReviewConflict)
async def review_conflict(_: Request, error: ReviewConflict):
    return JSONResponse(status_code=409, content={"detail": str(error)})


@app.exception_handler(ReviewNotFound)
async def review_not_found(_: Request, error: ReviewNotFound):
    return JSONResponse(status_code=404, content={"detail": str(error)})


@app.exception_handler(PostFailed)
async def post_failed(_: Request, error: PostFailed):
    return JSONResponse(status_code=502, content={"detail": str(error)})


@app.post(
    "/create-review", status_code=202, response_model=CreateReviewResponse,
    responses={409: {"description": "A review already exists for the accrual source entry."},
               503: {"description": "Review storage unavailable; import outcome may be uncertain."}, 202: {
        "description": "Files accepted and review created; processing continues asynchronously.",
        "content": {"application/json": {"example": CREATE_EXAMPLE}},
    }},
)
async def create_review(
    request: Request,
    files: Annotated[list[UploadFile], File(min_length=1)],
    service: Service,
):
    """Upload supporting documents and start a review in one request."""
    form = await request.form()
    if any(key != 'files' or not isinstance(value, StarletteUploadFile)
           for key, value in form.multi_items()):
        raise HTTPException(422, 'Only multipart file fields named files are supported.')
    total = 0
    for file in files:
        if file.content_type not in ALLOWED_MEDIA_TYPES:
            raise HTTPException(415, "Use CSV, JSON, plain text or selectable-text PDF files.")
        if not file.size:
            raise HTTPException(422, "Uploaded files must not be empty.")
        total += file.size
    if total > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Combined uploads must not exceed 10 MiB.")
    uploads = [ReviewUpload(file.filename or "upload", file.content_type, file.size, file.file) for file in files]
    return await run_in_threadpool(service.create_review, uploads)


@app.get(
    "/list-review", response_model=ListReviewResponse,
    responses={503: {"description": "Review storage is unavailable or returned an unsupported record."}, 200: {
        "description": "At most the requested limit (maximum 10) summaries; next_cursor is null on the last page.",
        "content": {"application/json": {"example": LIST_EXAMPLE}},
    }},
)
async def list_review(
    service: Service,
    limit: Annotated[int, Query(ge=1, le=10)] = 10,
    cursor: Annotated[str | None, Query(min_length=1, pattern=r"\S")] = None,
):
    """List review summaries with cursor pagination, up to 10 per page."""
    return await run_in_threadpool(service.list_reviews, limit=limit, cursor=cursor)


@app.get(
    "/get-review", response_model=GetReviewResponse,
    responses={503: {"description": "Review storage is unavailable."}, 200: {
        "description": "JSON snapshot by default. With live=true, polling SSE snapshot then review.updated events; each data payload follows GetReviewResponse. Resume resynchronizes current state; intermediate events are not replayed. Amounts are integer-cent strings or null while unknown.",
        "content": {
            "application/json": {"example": GET_EXAMPLE},
            "text/event-stream": {"schema": {"type": "string"}, "example": SSE_EXAMPLE},
        },
    }, 404: {"description": "Review not found."}},
)
async def get_review(
    review_id: Identifier,
    service: Service,
    live: bool = False,
    after_sequence: Annotated[str | None, Query(min_length=1, pattern=r"\S")] = None,
):
    """Get details/evidence/results; live=true will stream updates on this same route."""
    if after_sequence is not None and not live:
        raise HTTPException(422, "after_sequence requires live=true.")
    if live:
        events = await run_in_threadpool(service.stream_review, review_id, after_sequence)
        return StreamingResponse(events, media_type="text/event-stream", headers={
            'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no',
        })
    return await run_in_threadpool(service.get_review, review_id)


@app.post(
    "/approve-review", response_model=ApproveReviewResponse,
    responses={409: {"description": "Hash mismatch, blockers remain, or the proposal is not ready."},
               502: {"description": "QuickBooks rejected the journal."}, 200: {
        "description": "Human approval bound to the current proposal hash; gateway posted or found the journal.",
        "content": {"application/json": {"example": APPROVE_EXAMPLE}},
    }, 404: {"description": "Review not found."}},
)
async def approve_review(body: ApproveReviewRequest, service: Service):
    return await run_in_threadpool(service.approve_review, body.review_id, body.proposal_hash)


@app.get(
    "/export-review", response_class=Response,
    responses={**STUB_RESPONSE, 200: {
        "description": "Approved journal-entry CSV, one row per line; dollar amounts have two decimal places. Export does not post to the ledger.",
        "content": {"text/csv": {"schema": {"type": "string"}, "example": CSV_EXAMPLE}},
        "headers": {"Content-Disposition": {
            "description": "Download filename.",
            "schema": {"type": "string", "example": 'attachment; filename="review-1.csv"'},
        }},
    }, 404: {"description": "Review not found."},
       409: {"description": "No current approved correction to export, approval is stale, or blockers remain."}},
)
async def export_review(review_id: Identifier, service: Service):
    """Download the approved CSV for a review."""
    export = await run_in_threadpool(service.export_review, review_id)
    return Response(export.content, media_type="text/csv", headers={
        "Content-Disposition": f'attachment; filename="{export.filename}"',
    })


@app.get('/review-source')
async def review_source(review_id: Identifier, evidence_id: Identifier, service: Service):
    filename, media_type, data = await run_in_threadpool(service.get_source, review_id, evidence_id)
    return Response(data, media_type=media_type, headers={
        'Content-Disposition': f"inline; filename*=UTF-8''{quote(filename, safe='')}",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
    })
