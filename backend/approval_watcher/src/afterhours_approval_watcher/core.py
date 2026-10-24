"""Pure approval rules. Email text is untrusted; authorization is supplied separately."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hmac
import re
from typing import Literal

Outcome = Literal['APPROVED', 'REJECTED', 'QUESTION', 'MANUAL_REVIEW', 'INVALID',
                  'STALE', 'CLOSED', 'UNKNOWN_PROPOSAL', 'MESSAGE_ID_COLLISION', 'WAITING_FOR_ANSWER']
Status = Literal['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN']
_COMMAND = re.compile(r'(APPROVE|REJECT|QUESTION) ([1-9][0-9]*) v([1-9][0-9]*) ([A-Za-z0-9_-]{32,128})(?:\n([^\x00]+))?')
_ADDRESS = re.compile(r'[A-Za-z0-9.!#$%&\x27*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')


def aware(value: datetime) -> None:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError('timestamps must include a timezone')


def address(value: str) -> str:
    if not isinstance(value, str) or not _ADDRESS.fullmatch(value):
        raise ValueError('use a single bare email address, without display names')
    return value.lower()


@dataclass(frozen=True)
class Proposal:
    company_id: str
    case_id: int
    case_revision: int
    proposal_id: int
    version: int
    policy_version: str
    content_sha256: str
    request_token: str
    reviewers: tuple[str, ...]
    thread_id: str
    issued_at: datetime
    expires_at: datetime
    status: Status = 'PENDING'
    pending_question: bool = False

    def __post_init__(self) -> None:
        for value in (self.case_id, self.case_revision, self.proposal_id, self.version):
            if type(value) is not int or value < 1:
                raise ValueError('IDs, versions and revisions must be positive integers')
        if not self.company_id or not self.thread_id or not self.policy_version:
            raise ValueError('company, thread and policy version are required')
        if not re.fullmatch('[a-f0-9]{64}', self.content_sha256):
            raise ValueError('proposal content must have a server-computed SHA-256 hash')
        if not re.fullmatch('[A-Za-z0-9_-]{32,128}', self.request_token):
            raise ValueError('request token must contain 32–128 URL-safe characters')
        if not self.reviewers:
            raise ValueError('at least one authorized reviewer is required')
        object.__setattr__(self, 'reviewers', tuple(address(item) for item in self.reviewers))
        aware(self.issued_at)
        aware(self.expires_at)
        if self.expires_at <= self.issued_at:
            raise ValueError('request expiry must follow issuance')
        if type(self.pending_question) is not bool:
            raise ValueError('pending_question must be a boolean from authoritative question state')
        if self.status not in ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'):
            raise ValueError('unknown proposal decision status')


@dataclass(frozen=True)
class CurrentCase:
    """Current authority read in the same transaction as a decision write."""
    case_revision: int
    proposal_id: int
    proposal_version: int
    policy_version: str


@dataclass(frozen=True)
class Email:
    message_id: str
    company_id: str
    sender: str
    authenticated_sender: str | None
    thread_id: str
    received_at: datetime
    body: str

    def __post_init__(self) -> None:
        if not self.message_id or not self.company_id or not self.thread_id:
            raise ValueError('message identity, company and thread are required')
        aware(self.received_at)
        object.__setattr__(self, 'sender', address(self.sender))
        if self.authenticated_sender is not None:
            object.__setattr__(self, 'authenticated_sender', address(self.authenticated_sender))
        if not isinstance(self.body, str) or len(self.body) > 65536:
            raise ValueError('body must be text of at most 65536 characters')


@dataclass(frozen=True)
class Command:
    action: str
    proposal_id: int
    version: int
    token: str
    question: str | None = None


def parse_command(body: str) -> Command | None:
    """Accept only a whole-message command; never strip quoted mail or infer intent."""
    match = _COMMAND.fullmatch(body.strip().replace('\r\n', '\n'))
    if match is None:
        return None
    action, proposal_id, version, token, remainder = match.groups()
    if len(proposal_id) > 20 or len(version) > 10:
        return None
    if action == 'QUESTION':
        if not remainder or not remainder.strip():
            return None
    elif remainder is not None:
        return None
    return Command(action, int(proposal_id), int(version), token,
                   remainder.strip() if remainder else None)


@dataclass(frozen=True)
class Decision:
    message_id: str
    company_id: str
    outcome: Outcome
    reason: str
    processed_at: datetime
    case_id: int | None = None
    case_revision: int | None = None
    proposal_id: int | None = None
    proposal_version: int | None = None
    policy_version: str | None = None
    content_sha256: str | None = None
    reviewer: str | None = None
    question: str | None = None


def evaluate(message: Email, proposal: Proposal | None, *,
             current: CurrentCase | None, now: datetime) -> Decision:
    """Return a decision candidate. Persistence MUST recheck authority atomically."""
    aware(now)

    def result(outcome: Outcome, reason: str, *, bound: bool = False) -> Decision:
        fields = {}
        if bound and proposal is not None:
            fields = dict(case_id=proposal.case_id, case_revision=proposal.case_revision,
                          proposal_id=proposal.proposal_id, proposal_version=proposal.version,
                          policy_version=proposal.policy_version, content_sha256=proposal.content_sha256,
                          reviewer=message.authenticated_sender,
                          question=command.question if command else None)
        return Decision(message.message_id, message.company_id, outcome, reason, now, **fields)

    command = parse_command(message.body)
    if command is None:
        return result('MANUAL_REVIEW', 'No single explicit command; human review required')
    if proposal is None:
        return result('UNKNOWN_PROPOSAL', 'No matching proposal/request')
    if (command.proposal_id != proposal.proposal_id or command.version != proposal.version
            or message.company_id != proposal.company_id or message.thread_id != proposal.thread_id
            or not hmac.compare_digest(command.token, proposal.request_token)):
        return result('INVALID', 'Proposal, company, thread, version or request token mismatch')
    if (message.authenticated_sender is None or message.authenticated_sender != message.sender
            or message.authenticated_sender not in proposal.reviewers):
        return result('INVALID', 'Sender lacks trusted authentication or reviewer authorization')
    if not (proposal.issued_at <= message.received_at <= now < proposal.expires_at):
        return result('INVALID', 'Request expired or message timestamp outside request window')
    if current != CurrentCase(proposal.case_revision, proposal.proposal_id, proposal.version,
                              proposal.policy_version):
        return result('STALE', 'Proposal revision, identity, version or policy is no longer current')
    if proposal.status != 'PENDING':
        return result('CLOSED', 'Proposal already decided or withdrawn', bound=True)
    if command.action == 'APPROVE' and proposal.pending_question:
        return result('WAITING_FOR_ANSWER', 'Unanswered question blocks approval', bound=True)
    outcome: Outcome = {'APPROVE': 'APPROVED', 'REJECT': 'REJECTED', 'QUESTION': 'QUESTION'}[command.action]
    return result(outcome, 'Explicit authenticated reviewer command', bound=True)
