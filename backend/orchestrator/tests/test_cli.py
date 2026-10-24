from contextlib import redirect_stdout
import io
import json
import unittest
from unittest.mock import MagicMock, patch

from afterhours_orchestrator.cli import main
from afterhours_orchestrator.pipeline import CycleReport


class CLITests(unittest.TestCase):
    def test_polling_carries_calculation_cursor_across_reconnection_failure(self):
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
                if self.waits == 3:
                    stop.set()
                return stop.is_set()

        cursors = []

        def cycle(*args, **kwargs):
            cursors.append(kwargs['calculation_after_case_id'])
            return CycleReport(last_calculation_case_id=2)

        db = MagicMock()
        with patch('afterhours_orchestrator.cli.threading.Event', return_value=PollStop()), \
             patch('afterhours_orchestrator.cli.AfterHoursDB.connect',
                   side_effect=[db, db, RuntimeError('disconnected'), db, db]), \
             patch('afterhours_orchestrator.cli.run_cycle', side_effect=cycle), \
             redirect_stdout(io.StringIO()):
            main([])
        self.assertEqual(cursors, [None, 2])

    def test_once_includes_persisted_proposal_amounts_without_evidence_payload(self):
        proposal = dict(id=7, case_id=4, input_revision=1, entry_date='2026-09-30',
                        corrected_target_cents='110000', adjustment_cents='10000',
                        export_amount_cents='10000', hash='proposal-hash', evidence_ids=['private-evidence'])
        output = io.StringIO()
        with patch('afterhours_orchestrator.cli.AfterHoursDB.connect'), \
             patch('afterhours_orchestrator.cli.run_cycle',
                   return_value=CycleReport(completed_proposals=[proposal])), redirect_stdout(output):
            main(['--once', '--case-id', '4'])
        result = json.loads(output.getvalue())
        self.assertEqual(result['completed_proposals'][0]['adjustment_cents'], '10000')
        self.assertEqual(result['completed_proposals'][0]['id'], 7)
        self.assertNotIn('private-evidence', output.getvalue())

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
