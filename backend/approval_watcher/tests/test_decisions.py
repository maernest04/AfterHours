"""Authorization and binding tests use fixed, independently specified examples."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import unittest

from afterhours_approval_watcher.core import CurrentCase, Email, Proposal, evaluate

NOW = datetime(2026, 10, 24, 12, tzinfo=timezone.utc)
TOKEN = 'a' * 32


def proposal(**changes):
    original = Proposal(
        company_id='demo', case_id=7, case_revision=3, proposal_id=11, policy_version='policy-v1',
        version=2, content_sha256='b' * 64, request_token=TOKEN,
        reviewers=('reviewer@example.test',), thread_id='request-7-v2',
        issued_at=NOW - timedelta(hours=1), expires_at=NOW + timedelta(hours=1),
        status='PENDING',
    )
    return replace(original, **changes)


def email(body=None, **changes):
    original = Email(
        message_id='message-1', company_id='demo', sender='reviewer@example.test',
        authenticated_sender='reviewer@example.test', thread_id='request-7-v2',
        received_at=NOW, body=body or f'APPROVE 11 v2 {TOKEN}',
    )
    return replace(original, **changes)


class DecisionTests(unittest.TestCase):
    def decide(self, message=None, p=None, **kwargs):
        return evaluate(message or email(), p or proposal(),
                        current=CurrentCase(case_revision=kwargs.get('revision', 3),
                            proposal_id=kwargs.get('proposal_id', 11),
                            proposal_version=kwargs.get('version', 2),
                            policy_version=kwargs.get('policy_version', 'policy-v1')), now=NOW)

    def test_exact_authenticated_approval_binds_digest_and_case_revision(self):
        result = self.decide()
        self.assertEqual(result.outcome, 'APPROVED')
        self.assertEqual(result.proposal_id, 11)
        self.assertEqual(result.proposal_version, 2)
        self.assertEqual(result.content_sha256, 'b' * 64)
        self.assertEqual(result.case_revision, 3)
        self.assertEqual(result.reviewer, 'reviewer@example.test')

    def test_rejection_changes_status_only_for_exact_command(self):
        result = self.decide(email(f'REJECT 11 v2 {TOKEN}'))
        self.assertEqual(result.outcome, 'REJECTED')

    def test_question_is_recorded_without_approval(self):
        result = self.decide(email(f'QUESTION 11 v2 {TOKEN}\nWhy was the rate changed?'))
        self.assertEqual(result.outcome, 'QUESTION')
        self.assertEqual(result.question, 'Why was the rate changed?')

    def test_unstructured_conditional_quoted_and_multiple_commands_never_approve(self):
        for body in ['Approved', 'Do not approve this', f'APPROVE 11 v2 {TOKEN}\nif legal agrees',
                     f'> APPROVE 11 v2 {TOKEN}', f'APPROVE 11 v2 {TOKEN}\nREJECT 11 v2 {TOKEN}',
                     f'QUESTION 11 v2 {TOKEN}', f'Forwarded message:\nAPPROVE 11 v2 {TOKEN}']:
            with self.subTest(body=body):
                self.assertEqual(self.decide(email(body)).outcome, 'MANUAL_REVIEW')

    def test_wrong_identity_token_thread_or_company_cannot_decide(self):
        variants = [
            email(authenticated_sender=None), email(authenticated_sender='attacker@example.test'),
            email(sender='attacker@example.test', authenticated_sender='attacker@example.test'),
            email(thread_id='other'), email(company_id='other'),
            email(f'APPROVE 11 v2 {"c" * 32}'), email(f'APPROVE 99 v2 {TOKEN}'),
            email(f'APPROVE 11 v1 {TOKEN}'),
        ]
        for message in variants:
            with self.subTest(message=message):
                self.assertEqual(self.decide(message).outcome, 'INVALID')

    def test_current_revision_and_version_must_both_match(self):
        self.assertEqual(self.decide(revision=4).outcome, 'STALE')
        self.assertEqual(self.decide(version=3).outcome, 'STALE')
        self.assertEqual(self.decide(proposal_id=12).outcome, 'STALE')
        self.assertEqual(self.decide(policy_version='policy-v2').outcome, 'STALE')

    def test_expired_premature_and_future_received_messages_cannot_decide(self):
        variants = [
            (email(), proposal(expires_at=NOW)),
            (email(received_at=NOW - timedelta(hours=2)), proposal()),
            (email(received_at=NOW + timedelta(seconds=1)), proposal()),
        ]
        for message, p in variants:
            with self.subTest(message=message, p=p):
                self.assertEqual(self.decide(message, p).outcome, 'INVALID')

    def test_terminal_decisions_are_not_overwritten(self):
        for status in ['APPROVED', 'REJECTED', 'WITHDRAWN']:
            self.assertEqual(self.decide(p=proposal(status=status)).outcome, 'CLOSED')

    def test_answered_question_snapshot_can_approve_but_unanswered_cannot(self):
        self.assertEqual(self.decide(p=proposal(pending_question=True)).outcome, 'WAITING_FOR_ANSWER')
        self.assertEqual(self.decide(p=proposal(pending_question=False)).outcome, 'APPROVED')

    def test_rejection_remains_available_when_question_is_unanswered(self):
        self.assertEqual(self.decide(email(f'REJECT 11 v2 {TOKEN}'),
                                    proposal(pending_question=True)).outcome, 'REJECTED')

    def test_missing_proposal_is_safe(self):
        result = evaluate(email(), None, current=CurrentCase(3, 11, 2, 'policy-v1'), now=NOW)
        self.assertEqual(result.outcome, 'UNKNOWN_PROPOSAL')

    def test_invalid_trusted_proposal_contract_is_rejected(self):
        for changes in [dict(version=0), dict(case_revision=0), dict(content_sha256='bad'),
                        dict(request_token='short'), dict(reviewers=()),
                        dict(issued_at=NOW.replace(tzinfo=None)), dict(expires_at=NOW - timedelta(days=1))]:
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError):
                    proposal(**changes)


if __name__ == '__main__':
    unittest.main()
