"""Review imports and persisted snapshots; export awaits email approval integration."""

import base64
import asyncio
import binascii
import re
from dataclasses import dataclass
from typing import AsyncIterator, BinaryIO, Sequence

from starlette.concurrency import run_in_threadpool

from httpx import HTTPError

from .repository import ReviewConflict, ReviewRepository, SDKReviewRepository
from .imports import prepare_import
from .responses import (
    ApproveReviewResponse, CreateReviewResponse, GetReviewResponse, ListReviewResponse,
)


class IntegrationPending(RuntimeError):
    def __init__(self, operation: str):
        self.operation = operation
        super().__init__("Backend integration is not connected yet.")


class InvalidCursor(ValueError):
    pass


class PostFailed(RuntimeError):
    pass


@dataclass(frozen=True)
class ReviewUpload:
    filename: str
    media_type: str
    size: int
    stream: BinaryIO


@dataclass(frozen=True)
class ReviewCSV:
    content: bytes
    filename: str


def _encode_cursor(review_id: int) -> str:
    return base64.urlsafe_b64encode(f"reviews:v1:{review_id}".encode()).decode().rstrip("=")


def _decode_cursor(cursor: str | None) -> int:
    if cursor is None:
        return 0
    try:
        if len(cursor) > 128:
            raise ValueError("Cursor too long")
        decoded = base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True).decode()
        prefix, version, value = decoded.split(":")
        review_id = int(value)
        if prefix != "reviews" or version != "v1" or not 0 < review_id < 2**64 or _encode_cursor(review_id) != cursor:
            raise ValueError("Invalid cursor")
        return review_id
    except (ValueError, UnicodeError, binascii.Error) as error:
        raise InvalidCursor("Invalid review cursor.") from error


class ReviewService:
    def __init__(self, repository: ReviewRepository, post_intuit=None):
        self.repository = repository
        self.post_intuit = post_intuit

    def create_review(self, files: Sequence[ReviewUpload]) -> CreateReviewResponse:
        return self.repository.create_review(prepare_import(files))

    def get_source(self, review_id: str, evidence_id: str):
        if not re.fullmatch(r'[1-9][0-9]{0,19}', review_id) or int(review_id) >= 2**64:
            raise InvalidCursor('Invalid review ID.')
        if not re.fullmatch(r'fact:[1-9][0-9]{0,19}', evidence_id):
            raise InvalidCursor('Invalid evidence ID.')
        return self.repository.get_source(int(review_id), evidence_id)

    def list_reviews(self, *, limit: int = 10, cursor: str | None = None) -> ListReviewResponse:
        if not 1 <= limit <= 10:
            raise ValueError("Limit must be between 1 and 10.")
        after_id = _decode_cursor(cursor)
        rows = sorted(self.repository.list_reviews(), key=lambda row: int(row.review_id))
        remaining = [row for row in rows if int(row.review_id) > after_id]
        page = remaining[:limit]
        return ListReviewResponse(
            items=page,
            next_cursor=_encode_cursor(int(page[-1].review_id)) if len(remaining) > limit else None,
        )

    def get_review(self, review_id: str) -> GetReviewResponse:
        if not re.fullmatch(r'[1-9][0-9]{0,19}', review_id) or int(review_id) >= 2**64:
            raise InvalidCursor('review_id must be a positive decimal case ID.')
        return self.repository.get_review(int(review_id))

    def stream_review(self, review_id: str, after_sequence: str | None = None) -> AsyncIterator[bytes]:
        if after_sequence is not None and not re.fullmatch(r'v1:[0-9a-f]{64}', after_sequence):
            raise InvalidCursor('Invalid review update cursor.')
        # Resolve not-found/storage errors before StreamingResponse sends HTTP 200.
        snapshot = self.get_review(review_id)

        async def events():
            current = snapshot
            yield f'id: {current.sequence}\nevent: snapshot\ndata: {current.model_dump_json()}\n\n'.encode()
            # This is latest-state resynchronization, not durable event replay.
            # Each poll closes its SDK connection before yielding. StreamingResponse
            # cancels this generator on disconnect; no subscription remains open.
            while True:
                await asyncio.sleep(1)
                updated = await run_in_threadpool(self.get_review, review_id)
                if updated.sequence != current.sequence:
                    current = updated
                    yield f'id: {current.sequence}\nevent: review.updated\ndata: {current.model_dump_json()}\n\n'.encode()
                else:
                    yield b': keep-alive\n\n'

        return events()

    def approve_review(self, review_id: str, proposal_hash: str) -> ApproveReviewResponse:
        if not re.fullmatch(r'[1-9][0-9]{0,19}', review_id) or int(review_id) >= 2**64:
            raise InvalidCursor('review_id must be a positive decimal case ID.')
        if not proposal_hash or not proposal_hash.strip() or len(proposal_hash) > 128:
            raise InvalidCursor('proposal_hash is required.')
        review = self.get_review(review_id)
        if review.blockers:
            raise ReviewConflict('Blockers remain; approval cannot post.')
        if not review.proposal_hash or not review.proposal_id:
            raise ReviewConflict('No current proposal to approve.')
        if proposal_hash != review.proposal_hash:
            raise ReviewConflict('proposal_hash does not match the current proposal.')
        if review.status not in {'READY_FOR_REVIEW', 'APPROVED', 'EXPORTED'}:
            raise ReviewConflict('Proposal is not ready for approval.')
        if int(review.export_amount_cents or '0') == 0:
            raise ReviewConflict('Proposal has no journal to post.')
        poster = self.post_intuit
        if poster is None:
            from afterhours_db.config import DatabaseConfig
            from afterhours_db.intuit import post_proposal
            def poster(case_id, approve_hash):
                return post_proposal(DatabaseConfig.from_env(), case_id, approve_hash)
        try:
            result = poster(int(review_id), proposal_hash)
        except (HTTPError, RuntimeError, ValueError, OSError):
            raise PostFailed('QuickBooks rejected the journal.') from None
        return ApproveReviewResponse(
            review_id=review_id, proposal_hash=proposal_hash,
            posted=bool(result.get('posted')), already_posted=bool(result.get('already_posted')),
            qbo_id=None if result.get('qbo_id') is None else str(result.get('qbo_id')),
        )

    def export_review(self, review_id: str) -> ReviewCSV:
        # TODO: require current revision/hash-bound email approval and no blockers.
        # Export must not post to the ledger or mark a correction as posted.
        raise IntegrationPending("export-review")


def get_review_service() -> ReviewService:
    """FastAPI dependency: replace with a fake repository/service in local tests."""
    return ReviewService(SDKReviewRepository())
