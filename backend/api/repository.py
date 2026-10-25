"""Service-authorized database SDK adapter for imports and review projections."""

from datetime import datetime, timedelta, timezone
import hashlib
import json
from typing import Callable, Protocol, Sequence, TYPE_CHECKING
from uuid import uuid4

from httpx import HTTPError

from .imports import ReviewImport
from .responses import CreateReviewResponse, GetReviewResponse, ReviewSummary

if TYPE_CHECKING:
    from afterhours_db import AfterHoursDB


class RepositoryUnavailable(RuntimeError):
    """The configured database cannot supply valid API records."""


class ReviewNotFound(LookupError):
    pass


class ReviewConflict(ValueError):
    pass


class ReviewRepository(Protocol):
    def list_reviews(self) -> Sequence[ReviewSummary]: ...
    def create_review(self, prepared: ReviewImport) -> CreateReviewResponse: ...
    def get_review(self, review_id: int) -> GetReviewResponse: ...


def connect_gateway() -> "AfterHoursDB":
    from afterhours_db import AfterHoursDB

    return AfterHoursDB.connect("gateway")


def _timestamp(value: int | dict) -> datetime:
    if isinstance(value, dict):
        value = value["__timestamp_micros_since_unix_epoch__"]
    return datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=int(value))


class SDKReviewRepository:
    """Open/close a gateway HTTP client per operation; never use owner credentials."""

    def __init__(self, connect: Callable[[], "AfterHoursDB"] = connect_gateway):
        self._connect = connect

    def get_source(self, review_id: int, evidence_id: str):
        """Serve original bytes only for a fact in this review's current revision."""
        from afterhours_db import get_case, list_facts
        try:
            with self._connect() as db:
                case = get_case(db, review_id)
                if case is None:
                    raise ReviewNotFound('Review not found.')
                fact = next((row for row in list_facts(db, review_id)
                             if f"fact:{row['id']}" == evidence_id), None)
                if fact is None:
                    raise ReviewNotFound('Evidence not found in the current review.')
                document, data = db.read_document(fact['document_id'])
                return document.original_filename, document.media_type, data
        except ReviewNotFound:
            raise
        except (OSError, RuntimeError, ValueError, KeyError, TypeError, HTTPError) as error:
            raise RepositoryUnavailable('Source document unavailable.') from error

    def create_review(self, prepared: ReviewImport) -> CreateReviewResponse:
        from afterhours_db import finalize_import, list_cases
        from afterhours_db.mailbox import seed_vendor_amendment_mailbox

        try:
            with self._connect() as db:
                source = prepared.metadata['source_entry_id']
                if any(row['source_entry_id'] == source for row in list_cases(db)):
                    raise ReviewConflict('A review already exists for this accrual source entry.')
                key = str(uuid4())
                documents = [db.upload_document(
                    data=document.data, original_filename=document.filename,
                    media_type=document.media_type, type=document.type,
                    source_label='review API upload', reference_id=source,
                    upload_key=f'{key}:{index}',
                ) for index, document in enumerate(prepared.documents)]
                seed_vendor_amendment_mailbox(
                    db, vendor_id=prepared.metadata['vendor_id'], message_key=f'{key}:mail:amendment',
                    amendment_document_ids=[doc.id for doc, item in zip(documents, prepared.documents)
                                            if item.type == 'AMENDMENT'])
                case = finalize_import(db, document_ids=[doc.id for doc in documents],
                                       idempotency_key=key, **prepared.metadata)
                # The persisted IMPORTED case is the durable queue; the pipeline sweeper
                # starts it independently, including after an API process restart.
                # IMPORTED records the accepted milestone; a fast sweeper can have
                # advanced the current state before finalize_import reads it back.
                return CreateReviewResponse(review_id=str(case['id']),
                    idempotency_key=case['idempotency_key'], status='IMPORTED')
        except ReviewConflict:
            raise
        except (ImportError, OSError, RuntimeError, ValueError, KeyError, TypeError, OverflowError, HTTPError) as error:
            raise RepositoryUnavailable('Review storage is unavailable.') from error

    def get_review(self, review_id: int) -> GetReviewResponse:
        from afterhours_db import get_case

        try:
            with self._connect() as db:
                # Reducers atomically update the case alongside its facts/proposal.
                # Retry if that marker changes while reading the associated views.
                for _ in range(3):
                    case = get_case(db, review_id)
                    if case is None:
                        raise ReviewNotFound('Review not found.')
                    facts = [row for row in db.client.query('SELECT * FROM facts_view')
                             if row['case_id'] == review_id and row['input_revision'] == case['input_revision']]
                    proposal = None
                    if case['current_proposal_id'] is not None:
                        proposal = next((row for row in db.client.query('SELECT * FROM proposals_view')
                                         if row['id'] == case['current_proposal_id']), None)
                        if (proposal is None or proposal['case_id'] != review_id
                                or proposal['input_revision'] != case['input_revision']):
                            raise ValueError('Current proposal is missing or stale')
                    currency = proposal['currency'] if proposal else db.settings()['currency']
                    if case == get_case(db, review_id):
                        break
                else:
                    raise RuntimeError('Review changed during snapshot')
            lines = []
            if proposal:
                lines = [dict(entry_date=proposal['entry_date'], reference_id=case['source_entry_id'],
                              currency=currency, description='', **line) for line in proposal['journal_lines']]
            result = GetReviewResponse(
                review_id=str(case['id']), status=case['state'],
                created_at=_timestamp(case['created_at']), updated_at=_timestamp(case['updated_at']),
                sequence='', input_revision=case['input_revision'], currency=currency,
                original_status=case['original_status'], original_amount_cents=case['original_amount_cents'],
                corrected_target_cents=proposal['corrected_target_cents'] if proposal else None,
                difference_cents=proposal['adjustment_cents'] if proposal else None,
                export_amount_cents=proposal['export_amount_cents'] if proposal else None,
                proposal_id=str(proposal['id']) if proposal else None,
                proposal_hash=proposal['hash'] if proposal else None,
                journal_lines=lines,
                evidence=[dict(evidence_id=f"fact:{row['id']}", document_id=str(row['document_id']),
                               page_or_row=row['page_or_row'], excerpt=row['excerpt'])
                          for row in sorted(facts, key=lambda row: row['id'])],
                history=[], blockers=case['blockers'],
            )
            canonical = json.dumps(result.model_dump(mode='json'), sort_keys=True, separators=(',', ':'))
            result.sequence = 'v1:' + hashlib.sha256(canonical.encode()).hexdigest()
            return result
        except ReviewNotFound:
            raise
        except (ImportError, OSError, RuntimeError, ValueError, KeyError, TypeError, OverflowError, HTTPError) as error:
            raise RepositoryUnavailable('Review storage is unavailable.') from error

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
