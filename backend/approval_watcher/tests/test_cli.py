from dataclasses import asdict
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from afterhours_approval_watcher.cli import JsonMockMailbox, load_mock_repository
from afterhours_approval_watcher.runtime import poll_once
from test_decisions import TOKEN, email, proposal


def fixture():
    now = datetime.now(timezone.utc)
    return {
        'mode': 'MOCK', 'schema_version': 1,
        'proposals': [asdict(proposal(issued_at=now - timedelta(hours=1), expires_at=now + timedelta(hours=1)))],
        'cases': [{'company_id': 'demo', 'case_id': 7, 'case_revision': 3,
                   'proposal_id': 11, 'proposal_version': 2, 'policy_version': 'policy-v1'}],
        'emails': [asdict(email(received_at=now))],
    }


def write_fixture(path, value):
    path.write_text(json.dumps(value, default=lambda item: item.isoformat()))


class CliTests(unittest.TestCase):
    def command(self, *args):
        return subprocess.run([sys.executable, '-m', 'afterhours_approval_watcher.cli', *args],
                              capture_output=True, text=True, timeout=5)

    def test_default_mode_fails_explicitly_without_mock_authority(self):
        result = self.command('--once')
        self.assertEqual(result.returncode, 2)
        self.assertIn('not configured', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_mock_once_runs_real_package_and_redacts_reply_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'inbox.json'
            write_fixture(path, fixture())
            result = self.command('--mock-fixture', str(path), '--once')
        self.assertEqual(result.returncode, 0, result.stderr)
        record = json.loads(result.stdout)
        self.assertEqual(record['mode'], 'MOCK')
        self.assertEqual(record['outcome'], 'APPROVED')
        self.assertEqual(record['proposal_id'], 11)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertNotIn('reviewer@example.test', result.stdout + result.stderr)

    def test_json_mailbox_notices_new_messages_and_dedupes_old_ones(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'inbox.json'
            data = fixture()
            data['emails'][0]['body'] = f'QUESTION 11 v2 {TOKEN}\nPlease explain the adjustment?'
            write_fixture(path, data)
            repo = load_mock_repository(path)
            mailbox = JsonMockMailbox(path)
            self.assertEqual(poll_once(mailbox, repo)[0].outcome, 'QUESTION')
            data['emails'].append(asdict(email(message_id='second', received_at=datetime.now(timezone.utc))))
            write_fixture(path, data)
            decisions = poll_once(mailbox, repo)
            self.assertEqual([item.outcome for item in decisions], ['WAITING_FOR_ANSWER'])
            self.assertEqual(poll_once(mailbox, repo), [])

    def test_fixture_requires_explicit_mock_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'inbox.json'
            data = fixture()
            data['mode'] = 'LIVE'
            write_fixture(path, data)
            result = self.command('--mock-fixture', str(path), '--once')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, '')

    def test_invalid_poll_intervals_fail_before_processing(self):
        for interval in ['0', '-1', 'nan', 'inf']:
            with self.subTest(interval=interval):
                result = self.command('--mock-fixture', 'unused', '--poll-seconds', interval)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, '')

    def test_duplicate_current_case_fixture_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'inbox.json'
            data = fixture()
            data['cases'].append(dict(data['cases'][0], case_revision=4))
            write_fixture(path, data)
            with self.assertRaises(ValueError):
                load_mock_repository(path)


if __name__ == '__main__':
    unittest.main()
