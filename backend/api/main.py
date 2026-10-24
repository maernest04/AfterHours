"""MVP data-plane API stubs. Connect backend functions directly in each handler."""

from typing import Annotated, NoReturn

from fastapi import FastAPI, File, HTTPException, Query, Response, UploadFile

from .responses import (
    CREATE_EXAMPLE, CSV_EXAMPLE, GET_EXAMPLE, LIST_EXAMPLE, SSE_EXAMPLE,
    STUB_RESPONSE, CreateReviewResponse, GetReviewResponse, ListReviewResponse,
)

app = FastAPI(
    title="AfterHours review API", version="0.1.0",
    description="Success contracts are documented below. All valid requests currently return 501 until backend integration is connected.",
)

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
ALLOWED_MEDIA_TYPES = {"text/csv", "application/json", "text/plain", "application/pdf"}
Identifier = Annotated[str, Query(min_length=1, pattern=r"\S")]


def not_implemented(operation: str) -> NoReturn:
    raise HTTPException(501, detail={
        "code": "NOT_IMPLEMENTED",
        "operation": operation,
        "message": "Backend integration is not connected yet.",
    })


@app.post(
    "/create-review", status_code=202, response_model=CreateReviewResponse,
    responses={**STUB_RESPONSE, 202: {
        "description": "Files accepted and review created; processing continues asynchronously.",
        "content": {"application/json": {"example": CREATE_EXAMPLE}},
    }},
)
async def create_review(
    files: Annotated[list[UploadFile], File(min_length=1)],
):
    """Upload supporting documents and start a review in one request."""
    total = 0
    for file in files:
        if file.content_type not in ALLOWED_MEDIA_TYPES:
            raise HTTPException(415, "Use CSV, JSON, plain text or selectable-text PDF files.")
        if not file.size:
            raise HTTPException(422, "Uploaded files must not be empty.")
        total += file.size
    if total > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Combined uploads must not exceed 10 MiB.")
    # TODO: generate review_id and idempotency_key here in the data plane,
    # persist both with the uploaded files, start the review, and return both IDs.
    # The client does not supply the idempotency key.
    # Infer accrual draft/posted status from the source evidence; request clarification if unclear.
    not_implemented("create-review")


@app.get(
    "/list-review", response_model=ListReviewResponse,
    responses={**STUB_RESPONSE, 200: {
        "description": "At most the requested limit (maximum 10) summaries; next_cursor is null on the last page.",
        "content": {"application/json": {"example": LIST_EXAMPLE}},
    }},
)
async def list_review(
    limit: Annotated[int, Query(ge=1, le=10)] = 10,
    cursor: Annotated[str | None, Query(min_length=1, pattern=r"\S")] = None,
):
    """List review summaries with cursor pagination, up to 10 per page."""
    # TODO: query the database for review summaries and the next cursor.
    not_implemented("list-review")


@app.get(
    "/get-review", response_model=GetReviewResponse,
    responses={**STUB_RESPONSE, 200: {
        "description": "JSON snapshot by default. With live=true, SSE snapshot then review.updated events; each data payload follows GetReviewResponse. Amounts are integer-cent strings or null while unknown.",
        "content": {
            "application/json": {"example": GET_EXAMPLE},
            "text/event-stream": {"schema": {"type": "string"}, "example": SSE_EXAMPLE},
        },
    }, 404: {"description": "Review not found."}},
)
async def get_review(
    review_id: Identifier,
    live: bool = False,
    after_sequence: Annotated[str | None, Query(min_length=1, pattern=r"\S")] = None,
):
    """Get details/evidence/results; live=true will stream updates on this same route."""
    if after_sequence is not None and not live:
        raise HTTPException(422, "after_sequence requires live=true.")
    # TODO: return a snapshot, or snapshot + subsequent SSE updates when live=true.
    # Include email approval/rejection/question activity. Clean up on disconnect.
    not_implemented("get-review")


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
async def export_review(review_id: Identifier):
    """Download the approved CSV for a review."""
    # TODO: load the current proposal by review_id, verify its stored email approval
    # still matches its revision/hash and has no blockers, then return the CSV.
    # Reuse the existing export where possible. Export must never mark an entry posted.
    not_implemented("export-review")
