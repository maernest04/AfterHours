"""Read-only adapter for the service-authorized database SDK."""

from datetime import datetime, timedelta, timezone
from typing import Callable, Protocol, Sequence, TYPE_CHECKING

from httpx import HTTPError

from .responses import ReviewSummary

if TYPE_CHECKING:
    from afterhours_db import AfterHoursDB


class RepositoryUnavailable(RuntimeError):
    """The configured database cannot supply valid API records."""


class ReviewRepository(Protocol):
    def list_reviews(self) -> Sequence[ReviewSummary]: ...


def connect_gateway() -> "AfterHoursDB":
    from afterhours_db import AfterHoursDB

    return AfterHoursDB.connect("gateway")


def _timestamp(value: int | dict) -> datetime:
    if isinstance(value, dict):
        value = value["__timestamp_micros_since_unix_epoch__"]
    return datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=int(value))


class SDKReviewRepository:
    """Open/close one gateway HTTP client per read; never use owner credentials."""

    def __init__(self, connect: Callable[[], "AfterHoursDB"] = connect_gateway):
        self._connect = connect

    def list_reviews(self) -> list[ReviewSummary]:
        # SDK reads are synchronous. The API invokes this through its thread pool.
        try:
            from afterhours_db import list_cases

            with self._connect() as db:
                rows = list_cases(db)
            return [ReviewSummary(
                review_id=str(row["id"]), status=row["state"],
                created_at=_timestamp(row["created_at"]),
                updated_at=_timestamp(row["updated_at"]),
            ) for row in rows]
        except (ImportError, OSError, RuntimeError, ValueError, KeyError, TypeError, OverflowError, HTTPError) as error:
            # Do not return token paths, SQL, raw DB responses or credentials to clients.
            raise RepositoryUnavailable("Review storage is unavailable.") from error
