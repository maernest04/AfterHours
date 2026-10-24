"""Typed integration seams; only summary listing has a complete implementation."""

import base64
import binascii
from dataclasses import dataclass
from typing import BinaryIO, Iterator, Sequence

from .repository import ReviewRepository, SDKReviewRepository
from .responses import CreateReviewResponse, GetReviewResponse, ListReviewResponse


class IntegrationPending(RuntimeError):
    def __init__(self, operation: str):
        self.operation = operation
        super().__init__("Backend integration is not connected yet.")


class InvalidCursor(ValueError):
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
    def __init__(self, repository: ReviewRepository):
        self.repository = repository

    def create_review(self, files: Sequence[ReviewUpload]) -> CreateReviewResponse:
        # TODO: infer trusted document types/accrual metadata, generate a server-side
        # import key, persist uploads + import, then durably schedule start_review.
        # Until the whole acceptance path exists, perform no partial writes.
        raise IntegrationPending("create-review")

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
        # TODO: join current proposal/evidence/email history with a consistent sequence.
        # A case row alone cannot represent this response faithfully.
        raise IntegrationPending("get-review")

    def stream_review(self, review_id: str, after_sequence: str | None = None) -> Iterator[bytes]:
        # TODO: consistent snapshot + resume-aware updates, with disconnect cleanup.
        # Raise before starting a stream so the client receives an actual HTTP 501.
        raise IntegrationPending("get-review")

    def export_review(self, review_id: str) -> ReviewCSV:
        # TODO: require current revision/hash-bound email approval and no blockers.
        # Export must not post to the ledger or mark a correction as posted.
        raise IntegrationPending("export-review")


def get_review_service() -> ReviewService:
    """FastAPI dependency: replace with a fake repository/service in local tests."""
    return ReviewService(SDKReviewRepository())
