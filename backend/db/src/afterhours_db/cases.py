"""Case imports and evidence reads through service-authorized views and reducers."""
from __future__ import annotations

import re
from uuid import uuid4

from .documents import AfterHoursDB
from .parsers import parse_accrual, parse_invoices, parse_ledger, parse_timesheet

PARSEABLE = {'text/csv', 'application/json', 'text/plain'}


def find_case_by_idempotency_key(db: AfterHoursDB, key: str) -> dict | None:
    return next((row for row in db.client.query('SELECT * FROM cases_view')
                 if row['idempotency_key'] == key), None)


def get_case(db: AfterHoursDB, case_id: int) -> dict | None:
    return next((row for row in db.client.query('SELECT * FROM cases_view') if row['id'] == case_id), None)


def list_cases(db: AfterHoursDB, *, state: str | None = None) -> list[dict]:
    return sorted((row for row in db.client.query('SELECT * FROM cases_view')
                   if state is None or row['state'] == state), key=lambda row: row['id'])


def list_jobs(db: AfterHoursDB, case_id: int) -> list[dict]:
    return sorted((row for row in db.client.query('SELECT * FROM jobs_view')
                   if row['case_id'] == case_id), key=lambda row: row['id'])


def list_facts(db: AfterHoursDB, case_id: int) -> list[dict]:
    """Return CODE and AGENT facts for the case's current input revision."""
    case = get_case(db, case_id)
    if case is None:
        return []
    return sorted((row for row in db.client.query('SELECT * FROM facts_view')
                   if row['case_id'] == case_id and row['input_revision'] == case['input_revision']),
                  key=lambda row: row['id'])


def case_document_ids(db: AfterHoursDB, case_id: int) -> list[int]:
    return [row['document_id'] for row in db.client.query('SELECT * FROM case_documents_view')
            if row['case_id'] == case_id]


def is_awaiting_proposal(db: AfterHoursDB, case_id: int) -> bool:
    case = get_case(db, case_id)
    if case is None or case['state'] not in {'MATCHING', 'INVESTIGATING'}:
        return False
    jobs = [job for job in list_jobs(db, case_id) if job['case_revision'] == case['input_revision']]
    return bool(jobs) and all(job['status'] == 'SUCCEEDED' for job in jobs)


def _source(row: dict) -> list:
    return [row['document_id'], row['page_or_row'], row['excerpt']]


def finalize_import(db: AfterHoursDB, *, document_ids: list[int], vendor_id: str,
                    service_period_from: str, service_period_to: str, posting_period: str,
                    original_status: str, original_amount_cents: str, source_entry_id: str,
                    idempotency_key: str | None = None) -> dict:
    """Verify files, parse structured evidence, then atomically create a case.

    The trusted gateway derives original status/amount/source from accrual metadata.
    Reducers enforce document ownership, versions, duplicates and date validation.
    Reuse an explicit idempotency key when retrying an uncertain HTTP outcome.
    """
    key = idempotency_key if idempotency_key is not None else str(uuid4())
    existing = find_case_by_idempotency_key(db, key)
    if existing is not None:
        if existing['source_entry_id'] != source_entry_id:
            raise ValueError(f'idempotency_key "{key}" was used for a different import')
        return existing
    if original_status not in {'DRAFT', 'POSTED'}:
        raise ValueError('original_status must be DRAFT or POSTED')
    if not isinstance(original_amount_cents, str) or re.fullmatch(r'-?(0|[1-9][0-9]*)', original_amount_cents) is None:
        raise ValueError('original_amount_cents must be an integer-cent string')
    timesheets, invoices, ledger, facts = [], [], [], []
    for document_id in document_ids:
        # Integrity failures must abort before the reducer can commit an incomplete import.
        document, data = db.read_document(document_id)
        if document.media_type not in PARSEABLE:
            continue
        text = data.decode('utf-8-sig')
        if document.type == 'TIMESHEET':
            for row in parse_timesheet(document.id, text):
                rate = row['claimed_rate_cents']
                timesheets.append(_source(row) + [row['contractor'], row['service_date'], row['approved_minutes'],
                    {'none': []} if rate is None else {'some': rate}, row['status'], row['approved_by']])
        elif document.type == 'INVOICE':
            invoices.extend(_source(row) + [row['invoice_number'], row['contractor'], row['service_start'],
                row['service_end'], row['minutes'], row['amount_cents'], row['posting_status'], row['posted_date']]
                for row in parse_invoices(document.id, text))
        elif document.type == 'LEDGER':
            ledger.extend(_source(row) + [row['entry_id'], row['vendor_id'], row['period'], row['kind'],
                row['amount_cents'], row['status'], row['description']] for row in parse_ledger(document.id, text))
        elif document.type == 'ACCRUAL' and document.media_type == 'application/json':
            facts.extend(_source(row) + [row['field'], row['value']] for row in parse_accrual(document.id, text))
    db.client.call_reducer('finalize_import', [db.config.company_id, key, vendor_id, service_period_from,
        service_period_to, posting_period, original_status, original_amount_cents, source_entry_id,
        document_ids, timesheets, invoices, ledger, facts])
    case = find_case_by_idempotency_key(db, key)
    if case is None:
        raise RuntimeError(f'Reducer committed but case {key} is not visible')
    return case


def start_review(db: AfterHoursDB, case_id: int, expected_revision: int) -> dict:
    """Move an imported case to extraction and enqueue its first job."""
    db.client.call_reducer('start_review', [case_id, expected_revision])
    case = get_case(db, case_id)
    if case is None or case['state'] == 'IMPORTED':
        raise RuntimeError(f'Reducer committed but case {case_id} review start is not visible')
    return case
