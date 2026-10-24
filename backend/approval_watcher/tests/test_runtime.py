from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import timedelta
import unittest

from afterhours_approval_watcher.core import CurrentCase
from afterhours_approval_watcher.runtime import (
    MemoryMockRepository, MockMailbox, UnconfiguredRepository, poll_once,
)
from test_decisions import NOW, TOKEN, email, proposal


def repository(proposals=None, current=None):
    return MemoryMockRepository(proposals or [proposal()],
        {('demo', 7): current or CurrentCase(3, 11, 2, 'policy-v1')})


class RuntimeTests(unittest.TestCase):
    def test_repeated_poll_returns_one_receipt_and_one_decision(self):
        repo = repository()
        mailbox = MockMailbox([email()])
        self.assertEqual(poll_once(mailbox, repo, now=NOW)[0].outcome, 'APPROVED')
        self.assertEqual(poll_once(mailbox, repo, now=NOW + timedelta(minutes=1)), [])
        self.assertEqual(len(repo.audit), 1)

    def test_reused_message_id_with_changed_payload_is_not_a_duplicate_approval(self):
        repo = repository()
        repo.process(email(), now=NOW)
        changed = email(f'REJECT 11 v2 {TOKEN}')
        receipt = repo.process(changed, now=NOW)
        self.assertEqual(receipt.decision.outcome, 'MESSAGE_ID_COLLISION')
        self.assertFalse(receipt.duplicate)
        self.assertTrue(repo.process(changed, now=NOW).duplicate)
        self.assertEqual(len(repo.audit), 2)
        self.assertEqual(repo.process(replace(changed, message_id='other'), now=NOW).decision.outcome, 'CLOSED')

    def test_question_blocks_approval_until_answer_workflow_clears_it(self):
        repo = repository()
        question = email(f'QUESTION 11 v2 {TOKEN}\nWhy this amount?')
        self.assertEqual(repo.process(question, now=NOW).decision.outcome, 'QUESTION')
        self.assertEqual(repo.process(email(message_id='approval'), now=NOW).decision.outcome, 'WAITING_FOR_ANSWER')
        self.assertEqual(len(repo.audit), 2)

    def test_concurrent_conflicting_decisions_have_only_one_winner(self):
        repo = repository()
        messages = [email(message_id='approve'), email(f'REJECT 11 v2 {TOKEN}', message_id='reject')]
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = [r.decision.outcome for r in pool.map(lambda m: repo.process(m, now=NOW), messages)]
        self.assertEqual(outcomes.count('CLOSED'), 1)
        self.assertEqual(sum(o in ('APPROVED', 'REJECTED') for o in outcomes), 1)

    def test_concurrent_duplicate_deliveries_return_same_record(self):
        repo = repository()
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: repo.process(email(), now=NOW), range(20)))
        self.assertEqual(sum(not r.duplicate for r in results), 1)
        self.assertEqual(len(repo.audit), 1)
        self.assertEqual({r.decision.outcome for r in results}, {'APPROVED'})

    def test_new_message_for_decided_proposal_cannot_reverse_it(self):
        repo = repository()
        repo.process(email(f'REJECT 11 v2 {TOKEN}'), now=NOW)
        self.assertEqual(repo.process(email(message_id='later'), now=NOW).decision.outcome, 'CLOSED')

    def test_old_proposal_does_not_approve_new_case_revision(self):
        repo = repository(current=CurrentCase(4, 12, 3, 'policy-v1'))
        self.assertEqual(repo.process(email(), now=NOW).decision.outcome, 'STALE')

    def test_invalid_sender_does_not_consume_request(self):
        repo = repository()
        self.assertEqual(repo.process(email(authenticated_sender=None), now=NOW).decision.outcome, 'INVALID')
        self.assertEqual(repo.process(email(message_id='valid'), now=NOW).decision.outcome, 'APPROVED')

    def test_unknown_proposal_is_retried_only_by_explicit_new_message(self):
        repo = repository()
        unknown = email(f'APPROVE 900 v1 {TOKEN}')
        self.assertEqual(repo.process(unknown, now=NOW).decision.outcome, 'UNKNOWN_PROPOSAL')
        self.assertTrue(repo.process(unknown, now=NOW).duplicate)

    def test_poll_failure_is_not_marked_processed(self):
        repo = repository()
        class Unavailable:
            def process(self, message, *, now):
                raise ConnectionError('unavailable')
        with self.assertRaises(ConnectionError):
            poll_once(MockMailbox([email()]), Unavailable(), now=NOW)
        self.assertEqual(poll_once(MockMailbox([email()]), repo, now=NOW)[0].outcome, 'APPROVED')

    def test_unconfigured_repository_never_claims_success(self):
        with self.assertRaisesRegex(RuntimeError, 'not configured'):
            UnconfiguredRepository().process(email(), now=NOW)

    def test_conflicting_duplicate_proposal_fixture_is_rejected(self):
        with self.assertRaises(ValueError):
            repository([proposal(), proposal(content_sha256='c' * 64)])


if __name__ == '__main__':
    unittest.main()
