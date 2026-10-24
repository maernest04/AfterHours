"""At-least-once polling and in-process MOCK state; no accounting mutations."""
from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
import hashlib
import json
from threading import RLock
from typing import Mapping, Protocol, Sequence

from .core import CurrentCase, Decision, Email, Proposal, evaluate, parse_command


@dataclass(frozen=True)
class Receipt:
    decision: Decision
    duplicate: bool = False


class Mailbox(Protocol):
    def poll(self) -> Sequence[Email]:
        """Return at-least-once envelopes; authenticated_sender is provider-owned metadata."""
        ...


class ApprovalRepository(Protocol):
    def process(self, message: Email, *, now: datetime) -> Receipt:
        """Atomically dedupe, load current authority, evaluate, audit and apply a decision.

        A real implementation MUST use a transaction/reducer with current case,
        proposal, policy, request, reviewer authorization and message uniqueness
        checks. Pure evaluate() output is never sufficient write authorization.
        Only APPROVED/REJECTED may change decision status; neither posts/exports.
        QUESTION sets an unanswered-question flag; APPROVE must remain blocked
        until the authoritative answer workflow explicitly clears that flag.
        Commit receipt + status together; duplicates return the original receipt.
        A reused (company, message ID) with changed content must never change status.
        Raise on unavailable authority/storage; never acknowledge an uncommitted write.
        """
        ...


class UnconfiguredRepository:
    def process(self, message: Email, *, now: datetime) -> Receipt:
        raise RuntimeError('Authoritative approval persistence and reviewer authentication are not configured')


class MockMailbox:
    """Explicit synthetic envelopes; no network or external mail access."""
    def __init__(self, messages: Sequence[Email]):
        self.messages = list(messages)

    def poll(self) -> Sequence[Email]:
        return tuple(self.messages)


def _fingerprint(message: Email) -> str:
    payload = json.dumps(asdict(message), sort_keys=True, default=lambda value: value.isoformat())
    return hashlib.sha256(payload.encode()).hexdigest()


class MemoryMockRepository:
    """Single-process demo adapter. Every state change is lost when it exits."""
    def __init__(self, proposals: Sequence[Proposal],
                 current_cases: Mapping[tuple[str, int], CurrentCase]):
        self._lock = RLock()
        self._proposals: dict[tuple[str, int, int], Proposal] = {}
        for proposal in proposals:
            key = (proposal.company_id, proposal.proposal_id, proposal.version)
            if key in self._proposals:
                raise ValueError('duplicate proposal identity/version in mock fixture')
            self._proposals[key] = proposal
        self._current = dict(current_cases)
        self._message_hash: dict[tuple[str, str], str] = {}
        self._receipts: dict[tuple[str, str, str], Decision] = {}

    @property
    def audit(self) -> tuple[Decision, ...]:
        with self._lock:
            return tuple(self._receipts.values())

    def process(self, message: Email, *, now: datetime) -> Receipt:
        digest = _fingerprint(message)
        identity = (message.company_id, message.message_id)
        receipt_key = (*identity, digest)
        with self._lock:
            existing = self._receipts.get(receipt_key)
            if existing is not None:
                return Receipt(existing, duplicate=True)
            prior_hash = self._message_hash.get(identity)
            if prior_hash is not None and prior_hash != digest:
                decision = Decision(message.message_id, message.company_id,
                                    'MESSAGE_ID_COLLISION', 'Message identity reused with changed content', now)
            else:
                command = parse_command(message.body)
                key = (message.company_id, command.proposal_id, command.version) if command else None
                proposal = self._proposals.get(key) if key else None
                current = self._current.get((proposal.company_id, proposal.case_id)) if proposal else None
                decision = evaluate(message, proposal, current=current, now=now)
                if decision.outcome in ('APPROVED', 'REJECTED') and proposal is not None:
                    self._proposals[key] = replace(proposal, status=decision.outcome)
                elif decision.outcome == 'QUESTION' and proposal is not None:
                    self._proposals[key] = replace(proposal, pending_question=True)
            self._message_hash.setdefault(identity, digest)
            self._receipts[receipt_key] = decision
            return Receipt(decision)


def poll_once(mailbox: Mailbox, repository: ApprovalRepository, *,
              now: datetime | None = None) -> list[Decision]:
    """Repeated snapshots are safe when repository implementations honor their contract."""
    decisions = []
    for message in mailbox.poll():
        receipt = repository.process(message, now=now or datetime.now(timezone.utc))
        if not receipt.duplicate:
            decisions.append(receipt.decision)
    return decisions
