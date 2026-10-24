import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
import subprocess

from support import evidence_fixture, valid_output


class FactoryTests(unittest.TestCase):
    def run_script(self, body, *, timeout=10, cancel=None):
        from afterhours_agents.factory import FactoryProvider
        from afterhours_db.jobs import AGENT_OUTPUT_SCHEMA
        with tempfile.TemporaryDirectory() as folder:
            script = Path(folder) / 'fake-droid'
            script.write_text('#!/bin/sh\n' + body)
            script.chmod(0o700)
            provider = FactoryProvider(api_key='synthetic-key', model='synthetic-model',
                executable=str(script), timeout=timeout)
            return provider.generate(evidence_fixture(), AGENT_OUTPUT_SCHEMA,
                                     cancel=cancel or threading.Event())

    def test_decodes_factory_envelope_into_agent_output(self):
        payload = json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False,
                              'result': json.dumps(valid_output())})
        output = self.run_script("cat <<'JSON'\n" + payload + '\nJSON\n')
        self.assertEqual(output['proposedMatches'][0]['invoiceLineIds'], ['40'])

    def test_provider_failures_are_errors_not_matching_results(self):
        from afterhours_agents.factory import ProviderError
        for body, message in [('exit 7\n', 'code 7'), ('echo invalid-json\n', 'invalid JSON'),
                     ("echo '{\"is_error\":true,\"result\":\"failure\"}'\n", 'invalid JSON'),
                     ("echo '{\"is_error\":false,\"result\":\"```json {} ```\"}'\n", 'invalid JSON')]:
            with self.subTest(body=body), self.assertRaisesRegex(ProviderError, message):
                self.run_script(body)

    def test_timeout_and_cancellation_stop_process_promptly(self):
        from afterhours_agents.factory import ProviderError
        for mode in ('timeout', 'cancel'):
            cancel = threading.Event()
            timer = threading.Timer(0.1, cancel.set)
            if mode == 'cancel': timer.start()
            start = time.monotonic()
            try:
                with self.assertRaisesRegex(ProviderError, 'timed out' if mode == 'timeout' else 'cancelled'):
                    self.run_script('sleep 10\n', timeout=0.2 if mode == 'timeout' else 5, cancel=cancel)
                self.assertLess(time.monotonic() - start, 2)
            finally:
                timer.cancel()

    def test_child_does_not_inherit_database_credentials(self):
        from unittest.mock import patch
        with patch.dict(os.environ, {'SPACETIMEDB_SECRETS_DIR': '/private/tokens', 'UNRELATED_SECRET': 'secret'}):
            output = self.run_script('test -z "$SPACETIMEDB_SECRETS_DIR" || exit 9\n'
                'test -z "$UNRELATED_SECRET" || exit 9\n'
                'test "$FACTORY_API_KEY" = synthetic-key || exit 9\n'
                "echo '{\"is_error\":false,\"result\":\"{}\"}'\n")
        self.assertEqual(output, {})

    @unittest.skipUnless(os.getenv('AFTERHOURS_DROID_TESTS') == '1', 'requires packaged Droid CLI')
    def test_packaged_droid_allows_only_planning_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            process = subprocess.run(['droid', 'exec', '--only-tools', 'TodoWrite',
                '--disable-builtin-skills', '--list-tools', '--output-format', 'json'],
                cwd=folder, env={'PATH': os.environ['PATH'], 'HOME': folder, 'FACTORY_API_KEY': ''},
                text=True, capture_output=True, timeout=20, check=True)
            allowed = [row['id'] for row in json.loads(process.stdout) if row['currentlyAllowed']]
            self.assertEqual(allowed, ['todo_write'])

    def test_provider_passes_minimal_tool_allowlist(self):
        output = self.run_script('found=0\nwhile [ "$#" -gt 0 ]; do\n'
            'if [ "$1" = "--only-tools" ]; then shift; test "$1" = TodoWrite || exit 9; found=1; fi\n'
            'shift\ndone\ntest "$found" = 1 || exit 9\n'
            "echo '{\"is_error\":false,\"result\":\"{}\"}'\n")
        self.assertEqual(output, {})


if __name__ == '__main__':
    unittest.main()
