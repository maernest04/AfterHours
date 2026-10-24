"""Read-only agent tools bound to a worker's case and vendor.

Python methods use snake_case; their JSON results and function schemas retain the
camelCase LLM contracts. All database reads use the service-authorized views.
"""
from __future__ import annotations

from io import BytesIO
import re
from typing import TYPE_CHECKING, Any

from .cases import case_document_ids, get_case, list_facts, list_jobs

if TYPE_CHECKING:
    from .documents import AfterHoursDB

MAX_SEARCH_RESULTS = 25
SNIPPET_CHARS = 240


class ToolScopeError(ValueError):
    """Requested evidence is outside this worker job's case/vendor scope."""


def _rows(db: AfterHoursDB, view: str) -> list[dict[str, Any]]:
    # View names are internal constants, never model-supplied identifiers.
    return db.client.query(f'SELECT * FROM {view}')


def allowed_evidence_ids(db: AfterHoursDB, case_id: int | str) -> list[str]:
    """Case documents, vendor mailbox evidence, and facts at the current revision."""
    case_id = int(case_id)
    case = get_case(db, case_id)
    if case is None:
        return []
    ids = dict.fromkeys(f'doc:{id}' for id in case_document_ids(db, case_id))
    attachments = {}
    for attachment in _rows(db, 'attachments_view'):
        attachments.setdefault(attachment['email_id'], []).append(attachment['document_id'])
    for email in _rows(db, 'emails_view'):
        if email['vendor_id'] != case['vendor_id']:
            continue
        ids[f"email:{email['id']}"] = None
        for document_id in attachments.get(email['id'], []):
            ids[f'doc:{document_id}'] = None
    for fact in list_facts(db, case_id):
        ids[f"fact:{fact['id']}"] = None
    return list(ids)


def _snippet(text: str, terms: list[str]) -> str:
    flat = re.sub(r'\s+', ' ', text).strip()
    lower = flat.lower()
    hit = min((lower.index(term) for term in terms if term in lower), default=0)
    start = max(0, hit - 60)
    end = start + SNIPPET_CHARS
    return ('…' if start else '') + flat[start:end] + ('…' if end < len(flat) else '')


def _case_summary(case: dict) -> dict:
    return {
        'id': str(case['id']), 'companyId': case['company_id'],
        'vendorId': case['vendor_id'],
        'servicePeriod': {'from': case['service_period_from'], 'to': case['service_period_to']},
        'postingPeriod': case['posting_period'], 'originalStatus': case['original_status'],
        'originalAmountCents': case['original_amount_cents'], 'sourceEntryId': case['source_entry_id'],
        'inputRevision': case['input_revision'], 'state': case['state'],
        'currentProposalId': None if case['current_proposal_id'] is None else str(case['current_proposal_id']),
        'blockers': case['blockers'],
    }


def _fact_summary(fact: dict) -> dict:
    return {
        'id': str(fact['id']), 'documentId': str(fact['document_id']),
        'pageOrRow': fact['page_or_row'], 'excerpt': fact['excerpt'],
        'field': fact['field'], 'value': fact['value'],
        'validationStatus': fact['validation_status'],
        'evidenceId': f"fact:{fact['id']}", 'source': fact['source'],
    }


def _job_summary(job: dict) -> dict:
    return {
        'id': str(job['id']), 'caseId': str(job['case_id']),
        'caseRevision': job['case_revision'], 'role': job['role'],
        'status': job['status'], 'attempts': job['attempts'],
    }


class AgentTools:
    """Read-only tools whose scope is selected by the worker, never by the model."""

    def __init__(self, db: AfterHoursDB, case_id: int | str):
        self.db = db
        self.case_id = int(case_id)

    def _case(self) -> dict:
        case = get_case(self.db, self.case_id)
        if case is None:
            raise ToolScopeError(f'Case {self.case_id} is not visible to this worker')
        return case

    def evidence_ids(self) -> list[str]:
        return allowed_evidence_ids(self.db, self.case_id)

    def _vendor_emails(self) -> list[dict]:
        vendor_id = self._case()['vendor_id']
        return [email for email in _rows(self.db, 'emails_view') if email['vendor_id'] == vendor_id]

    def _attachments(self) -> dict[int, list[str]]:
        attachments: dict[int, list[str]] = {}
        for row in _rows(self.db, 'attachments_view'):
            attachments.setdefault(row['email_id'], []).append(str(row['document_id']))
        return attachments

    def search_emails(self, query: str, vendor: str | None = None,
                      date_range: dict[str, str] | None = None,
                      limit: int = 10) -> list[dict]:
        """Search vendor mail, returning bounded snippets and attachment IDs."""
        case = self._case()
        if vendor and vendor != case['vendor_id']:
            raise ToolScopeError(f"Vendor {vendor} is outside this job's scope")
        terms = query.lower().split()
        date_range = date_range or {}
        start, end = date_range.get('from'), date_range.get('to')
        matches = []
        for email in self._vendor_emails():
            sent_date = email['sent_at'][:10]
            if (start and sent_date < start) or (end and sent_date > end):
                continue
            text = f"{email['subject']}\n{email['body']}".lower()
            score = sum(term in text for term in terms)
            if not terms or score:
                matches.append((score, email))
        matches.sort(key=lambda item: (item[0], item[1]['sent_at']), reverse=True)
        attachments = self._attachments()
        return [{
            'emailId': str(email['id']), 'evidenceId': f"email:{email['id']}",
            'threadId': email['thread_id'], 'sender': email['sender'],
            'subject': email['subject'], 'sentAt': email['sent_at'],
            'snippet': _snippet(email['body'], terms),
            'attachmentDocumentIds': attachments.get(email['id'], []),
        } for _, email in matches[:max(0, min(limit, MAX_SEARCH_RESULTS))]]

    def read_email_thread(self, thread_id: str) -> list[dict]:
        """Return every scoped message in a thread, oldest first."""
        messages = [email for email in self._vendor_emails() if email['thread_id'] == thread_id]
        if not messages:
            raise ToolScopeError(f"Thread {thread_id} is outside this job's scope")
        messages.sort(key=lambda email: email['sent_at'])
        attachments = self._attachments()
        return [{
            'emailId': str(email['id']), 'evidenceId': f"email:{email['id']}",
            'sender': email['sender'], 'recipients': email['recipients'],
            'subject': email['subject'], 'sentAt': email['sent_at'], 'body': email['body'],
            'attachmentDocumentIds': attachments.get(email['id'], []),
        } for email in messages]

    def read_attachment(self, document_id: str) -> dict:
        """Read hash-verified case/vendor attachment text, preserving PDF pages."""
        if f'doc:{document_id}' not in self.evidence_ids():
            raise ToolScopeError(f"Document {document_id} is outside this job's scope")
        document, data = self.db.read_document(int(document_id))
        if document.media_type == 'application/pdf':
            from pypdf import PdfReader

            reader = PdfReader(BytesIO(data))
            text = '\n'.join(f'--- page {index} ---\n{page.extract_text() or ""}'
                             for index, page in enumerate(reader.pages, 1))
        else:
            text = data.decode('utf-8-sig', errors='replace')
        return {
            'documentId': str(document.id), 'evidenceId': f'doc:{document.id}',
            'type': document.type, 'version': document.version,
            'filename': document.original_filename, 'mediaType': document.media_type,
            'contentHash': document.content_hash, 'text': text,
        }

    def get_case_evidence(self) -> dict:
        """Return the current case evidence plus its job/result history."""
        case = self._case()

        def current(view: str) -> list[dict]:
            return [row for row in _rows(self.db, view)
                    if row['case_id'] == self.case_id and row['input_revision'] == case['input_revision']]

        document_ids = set(case_document_ids(self.db, self.case_id))
        return {
            'case': _case_summary(case),
            'documents': [{
                'documentId': str(doc.id), 'evidenceId': f'doc:{doc.id}',
                'type': doc.type, 'version': doc.version,
                'filename': doc.original_filename, 'mediaType': doc.media_type,
            } for doc_id in document_ids if (doc := self.db.get_document(doc_id)) is not None],
            'facts': [_fact_summary(fact) for fact in list_facts(self.db, self.case_id)],
            'workItems': [{
                'id': str(row['id']), 'factId': str(row['fact_id']),
                'contractor': row['contractor'], 'serviceDate': row['service_date'],
                'approvedMinutes': row['approved_minutes'], 'claimedRateCents': row['claimed_rate_cents'],
                'approvedBy': row['approved_by'],
            } for row in current('work_items_view')],
            'invoiceLines': [{
                'id': str(row['id']), 'factId': str(row['fact_id']),
                'invoiceNumber': row['invoice_number'], 'contractor': row['contractor'],
                'serviceStart': row['service_start'], 'serviceEnd': row['service_end'],
                'minutes': row['minutes'], 'amountCents': row['amount_cents'],
                'postingStatus': row['posting_status'], 'postedDate': row['posted_date'],
            } for row in current('invoice_lines_view')],
            'ledgerRecords': [{
                'id': str(row['id']), 'factId': str(row['fact_id']),
                'entryId': row['entry_id'], 'vendorId': row['vendor_id'], 'period': row['period'],
                'kind': row['kind'], 'amountCents': row['amount_cents'],
                'status': row['status'], 'description': row['description'],
            } for row in current('ledger_records_view')],
            'allocations': [{
                'id': str(row['id']), 'workItemId': str(row['work_item_id']),
                'contractId': str(row['contract_document_id']),
                'invoiceLineIds': [str(id) for id in row['invoice_line_ids']],
                'ledgerEntryIds': [str(id) for id in row['ledger_record_ids']],
                'evidenceIds': row['evidence_ids'],
            } for row in current('allocations_view')],
            'jobs': [_job_summary(job) for job in list_jobs(self.db, self.case_id)],
            'jobResults': [{
                'jobId': str(row['job_id']), 'modelRun': row['model_run'],
                'summary': row['summary'], 'unresolvedQuestions': row['unresolved_questions'],
            } for row in _rows(self.db, 'job_results_view') if row['case_id'] == self.case_id],
            'allowedEvidenceIds': self.evidence_ids(),
        }


AGENT_TOOL_SPECS = [
    {
        'name': 'searchEmails',
        'description': "Keyword search of the mock finance mailbox for this case's vendor. Returns short snippets and IDs; use readEmailThread / readAttachment for full text.",
        'input_schema': {
            'type': 'object',
            'properties': {
                'vendor': {'type': 'string', 'description': "Optional; must equal the case's vendorId"},
                'query': {'type': 'string', 'description': 'Keywords, e.g. "amendment hourly rate"'},
                'dateRange': {'type': 'object', 'properties': {'from': {'type': 'string'}, 'to': {'type': 'string'}}, 'description': 'YYYY-MM-DD bounds'},
                'limit': {'type': 'integer', 'minimum': 1, 'maximum': MAX_SEARCH_RESULTS},
            },
            'required': ['query'],
        },
    },
    {
        'name': 'readEmailThread',
        'description': 'All messages in a mailbox thread, oldest first, with attachment document IDs.',
        'input_schema': {'type': 'object', 'properties': {'threadId': {'type': 'string'}}, 'required': ['threadId']},
    },
    {
        'name': 'readAttachment',
        'description': 'Full text of a case document or vendor email attachment, by document ID.',
        'input_schema': {'type': 'object', 'properties': {'documentId': {'type': 'string'}}, 'required': ['documentId']},
    },
    {
        'name': 'getCaseEvidence',
        'description': 'The case, its documents, facts, work items, invoice lines, ledger records, allocations, jobs and allowed evidence IDs.',
        'input_schema': {'type': 'object', 'properties': {}},
    },
]
