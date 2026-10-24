from contextlib import redirect_stdout
import io
import json
import unittest
from unittest.mock import MagicMock, patch

from afterhours_orchestrator.cli import main
from afterhours_orchestrator.pipeline import CycleReport


class CLITests(unittest.TestCase):
    def test_once_returns_failure_without_exposing_exception_payload(self):
        output = io.StringIO()
        with patch('afterhours_orchestrator.cli.AfterHoursDB.connect', side_effect=RuntimeError('secret')), \
             redirect_stdout(output):
            with self.assertRaises(SystemExit) as exited:
                main(['--once', '--case-id', '4'])
        self.assertEqual(exited.exception.code, 1)
        self.assertNotIn('secret', output.getvalue())

    def test_once_outputs_only_summary_and_honest_blocked_stage(self):
        report = CycleReport(started_cases=[4], blocked=[{'case_id': 4, 'stage': 'EXTRACTION'}])
        output = io.StringIO()
        with patch('afterhours_orchestrator.cli.AfterHoursDB.connect'), \
             patch('afterhours_orchestrator.cli.run_cycle', return_value=report), redirect_stdout(output):
            main(['--once', '--case-id', '4', '--max-jobs', '2'])
        result = json.loads(output.getvalue())
        self.assertEqual(result['blocked'], [{'case_id': 4, 'stage': 'EXTRACTION'}])
        self.assertEqual(result['completed_jobs'], [])

    def test_polling_reconnects_after_failure_and_shutdown_stops_loop(self):
        import threading
        stop = threading.Event()
        class PollStop:
            waits = 0

            def is_set(self):
                return stop.is_set()

            def set(self):
                stop.set()

            def wait(self, seconds):
                self.waits += 1
                if self.waits == 2:
                    stop.set()
                return stop.is_set()

        output = io.StringIO()
        db = MagicMock()
        with patch('afterhours_orchestrator.cli.threading.Event', return_value=PollStop()), \
             patch('afterhours_orchestrator.cli.AfterHoursDB.connect',
                   side_effect=[RuntimeError('disconnected'), db, db]), \
             patch('afterhours_orchestrator.cli.run_cycle', return_value=CycleReport(started_cases=[7])), \
             redirect_stdout(output):
            main([])
        self.assertEqual(json.loads(output.getvalue())['started_cases'], [7])
