"""AfterHours' project SDK for SpacetimeDB; not an official SpacetimeDB SDK."""
from .client import SpacetimeClient, SpacetimeError
from .files import FileStore, StoredFile

__all__ = ['SpacetimeClient', 'SpacetimeError', 'FileStore', 'StoredFile']
from .config import DatabaseConfig
from .documents import AfterHoursDB, Document, DocumentType, Verification

__all__ += ['DatabaseConfig', 'AfterHoursDB', 'Document', 'DocumentType', 'Verification']

from .websocket import SpacetimeConnection, ReducerError
__all__ += ['SpacetimeConnection', 'ReducerError']
from .cases import (finalize_import, start_review, get_case, list_cases, list_jobs,
                    list_facts, case_document_ids, is_awaiting_proposal)
from .mailbox import store_email
from .jobs import JobLease, AgentOutput, claim_job, heartbeat_job, complete_job, list_claimable_jobs
from .tools import AgentTools, ToolScopeError, allowed_evidence_ids, AGENT_TOOL_SPECS

__all__ += ['finalize_import', 'start_review', 'get_case', 'list_cases', 'list_jobs',
            'list_facts', 'case_document_ids', 'is_awaiting_proposal', 'store_email',
            'JobLease', 'AgentOutput', 'claim_job', 'heartbeat_job', 'complete_job',
            'list_claimable_jobs', 'AgentTools', 'ToolScopeError', 'allowed_evidence_ids', 'AGENT_TOOL_SPECS']
