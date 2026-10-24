"""Worker leases and evidence-linked results; model calls stay outside the database."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import re
from typing import TypedDict

from .cases import list_facts, list_jobs
from .documents import AfterHoursDB
from .tools import allowed_evidence_ids


class ProposedFact(TypedDict):
    documentId: str
    pageOrRow: str
    excerpt: str
    field: str
    value: str


class CandidateMatch(TypedDict):
    workItemId: str
    contractId: str
    invoiceLineIds: list[str]
    ledgerEntryIds: list[str]
    evidenceIds: list[str]


class Explanation(TypedDict):
    summary: str
    evidenceIds: list[str]


class AgentOutput(TypedDict):
    proposedFacts: list[ProposedFact]
    proposedMatches: list[CandidateMatch]
    evidenceIds: list[str]
    unresolvedQuestions: list[str]
    explanation: Explanation


def _object(properties: dict) -> dict:
    return {'type': 'object', 'additionalProperties': False,
            'required': list(properties), 'properties': properties}


STRING = {'type': 'string'}
STRINGS = {'type': 'array', 'items': STRING}
AGENT_OUTPUT_SCHEMA = _object({
    'proposedFacts': {'type': 'array', 'items': _object({
        name: STRING for name in ('documentId', 'pageOrRow', 'excerpt', 'field', 'value')})},
    'proposedMatches': {'type': 'array', 'items': _object({
        'workItemId': STRING, 'contractId': STRING, 'invoiceLineIds': STRINGS,
        'ledgerEntryIds': STRINGS, 'evidenceIds': STRINGS})},
    'evidenceIds': STRINGS,
    'unresolvedQuestions': STRINGS,
    'explanation': _object({'summary': STRING, 'evidenceIds': STRINGS}),
})


@dataclass(frozen=True)
class JobLease:
    id: int
    case_id: int
    case_revision: int
    role: str
    status: str
    attempts: int
    lease_token: str
    lease_expiry: datetime
    allowed_evidence_ids: list[str]
    facts: list[dict]
    policy_version: str
    output_schema: dict


def _timestamp(micros: int) -> datetime:
    return datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=micros)


def _job(db: AfterHoursDB, job_id: int, case_id: int) -> dict:
    job = next((job for job in list_jobs(db, case_id) if job['id'] == job_id), None)
    if job is None:
        raise LookupError(f'Job {job_id} not found for case {case_id}')
    return job


def list_claimable_jobs(db: AfterHoursDB, roles: list[str] | None = None) -> list[dict]:
    return sorted((job for job in db.client.query('SELECT * FROM jobs_view')
                   if job['status'] == 'QUEUED' and (roles is None or job['role'] in roles)),
                  key=lambda job: job['id'])


def claim_job(db: AfterHoursDB, job_id: int, case_id: int, expected_revision: int, *, evidence_ids: list[str] | None = None) -> JobLease:
    connection_id = getattr(db.client, 'connection_id', None)
    if connection_id is None:
        raise RuntimeError('Claiming jobs requires AfterHoursDB.connect("worker") and its persistent connection')
    db.client.call_reducer('claim_job', [job_id, case_id, expected_revision])
    job = _job(db, job_id, case_id)
    if job['status'] != 'RUNNING' or job['lease_connection_id'] != connection_id:
        raise RuntimeError('Job lease is not held by this connection')
    facts = [{'id': str(f['id']), 'documentId': str(f['document_id']), 'pageOrRow': f['page_or_row'],
              'excerpt': f['excerpt'], 'field': f['field'], 'value': f['value'],
              'validationStatus': f['validation_status']} for f in list_facts(db, case_id)]
    return JobLease(job['id'], job['case_id'], job['case_revision'], job['role'], job['status'],
                    job['attempts'], job['lease_token'], _timestamp(job['lease_expires_at_micros']),
                    allowed_evidence_ids(db, case_id) if evidence_ids is None else evidence_ids,
                    facts, db.settings()['policy_version'], AGENT_OUTPUT_SCHEMA)


def heartbeat_job(db: AfterHoursDB, lease: JobLease) -> datetime:
    db.client.call_reducer('heartbeat_job', [lease.id, lease.case_id, lease.case_revision, lease.lease_token])
    return _timestamp(_job(db, lease.id, lease.case_id)['lease_expires_at_micros'])


def _numeric_id(value: str, label: str) -> int:
    if not isinstance(value, str) or re.fullmatch(r'[0-9]+', value) is None:
        raise ValueError(f'{label} must be a numeric ID string')
    result = int(value)
    if result >= 2 ** 64:
        raise ValueError(f'{label} is outside u64 range')
    return result


def complete_job(db: AfterHoursDB, lease: JobLease, model_run: str, output: AgentOutput) -> dict:
    if model_run not in ('LIVE', 'REPLAYED'):
        raise ValueError('model_run must be LIVE or REPLAYED')
    facts = [[_numeric_id(f['documentId'], 'documentId'), f['pageOrRow'], f['excerpt'], f['field'], f['value']]
             for f in output['proposedFacts']]
    matches = [[_numeric_id(m['workItemId'], 'workItemId'), _numeric_id(m['contractId'], 'contractId'),
                [_numeric_id(x, 'invoiceLineId') for x in m['invoiceLineIds']],
                [_numeric_id(x, 'ledgerEntryId') for x in m['ledgerEntryIds']], m['evidenceIds']]
               for m in output['proposedMatches']]
    db.client.call_reducer('complete_job', [lease.id, lease.case_id, lease.case_revision, lease.lease_token,
        model_run, facts, matches, output['evidenceIds'], output['unresolvedQuestions'],
        output['explanation']['summary'], output['explanation']['evidenceIds']])
    return _job(db, lease.id, lease.case_id)
