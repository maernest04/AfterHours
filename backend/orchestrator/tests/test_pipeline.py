import asyncio
import os
from contextlib import asynccontextmanager
from copy import deepcopy
import threading
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone

from afterhours_db.jobs import JobLease
from afterhours_db.client import SpacetimeError

from afterhours_orchestrator.pipeline import live_extraction_session, live_investigation_session, run_cycle


class Database:
    """Transport substitute: real SDK reads and start_review use these tables."""
    def __init__(self, cases, jobs=()):
        self.client = self
        self.cases, self.jobs = deepcopy(cases), deepcopy(list(jobs))
        self.fail_start = set()

    def query(self, sql):
        return deepcopy(self.cases if sql == 'SELECT * FROM cases_view' else self.jobs)

    def call_reducer(self, reducer, args):
        if reducer != 'start_review':
            raise AssertionError(f'Unexpected write: {reducer}')
        case_id, revision = args
        if case_id in self.fail_start:
            raise RuntimeError('temporary transport failure')
        case = next(c for c in self.cases if c['id'] == case_id)
        assert case['input_revision'] == revision
        assert case['state'] == 'IMPORTED'
        case['state'] = 'EXTRACTING'
        self.jobs.append(job(len(self.jobs) + 1, case_id, 'EXTRACTION'))


def case(case_id, state='IMPORTED'):
    return dict(id=case_id, state=state, input_revision=1, blockers=[],
                posting_period='2026-09', current_proposal_id=None)


def job(job_id, case_id, role, status='QUEUED'):
    return dict(id=job_id, case_id=case_id, role=role, status=status, case_revision=1)


def unavailable():
    raise RuntimeError('provider not configured')


class CycleTests(unittest.TestCase):
    def test_import_recovery_is_scoped_idempotent_and_never_fakes_extraction(self):
        db = Database([case(1), case(2)])
        first = run_cycle(db, db, case_id=2, matching_provider_factory=unavailable)
        second = run_cycle(db, db, case_id=2, matching_provider_factory=unavailable)
        self.assertEqual(first.started_cases, [2])
        self.assertEqual(second.started_cases, [])
        self.assertEqual(db.cases, [case(1), case(2, 'EXTRACTING')])
        self.assertEqual(db.jobs, [job(1, 2, 'EXTRACTION')])
        self.assertEqual(first.completed_jobs, [])
        self.assertEqual(first.errors, [])
        self.assertEqual(first.blocked, [{'case_id': 2, 'stage': 'EXTRACTION'}])

    def test_start_failure_does_not_starve_other_cases_and_retries_next_poll(self):
        db = Database([case(1), case(2)])
        db.fail_start.add(1)
        first = run_cycle(db, db)
        self.assertEqual(first.started_cases, [2])
        self.assertEqual(first.errors[0]['case_id'], 1)
        db.fail_start.clear()
        second = run_cycle(db, db)
        self.assertEqual(second.started_cases, [1])
        self.assertEqual(len(db.jobs), 2)

    def test_missing_provider_leaves_matching_queued_and_reports_no_success(self):
        db = Database([case(1, 'MATCHING')], [job(1, 1, 'MATCHING')])
        result = run_cycle(db, db, matching_provider_factory=unavailable)
        self.assertEqual(db.jobs[0]['status'], 'QUEUED')
        self.assertEqual(result.completed_jobs, [])
        self.assertEqual(len(result.errors), 1)

    def test_bounded_drain_continues_to_investigation_then_calculates(self):
        db = Database([case(1, 'MATCHING'), case(2, 'MATCHING')],
                      [job(1, 1, 'MATCHING'), job(2, 2, 'MATCHING')])

        def matching(db, provider, *, case_id, cancel):
            selected = next(j for j in db.jobs if j['case_id'] == case_id and j['role'] == 'MATCHING')
            selected['status'] = 'SUCCEEDED'
            db.jobs.append(job(3, case_id, 'INVESTIGATION'))
            return deepcopy(selected)

        async def investigation(db, lease, decide, *, model_run, timeout):
            self.assertEqual(model_run, 'REPLAYED')
            selected = next(j for j in db.jobs if j['id'] == lease)
            selected['status'] = 'SUCCEEDED'
            return deepcopy(selected)

        @asynccontextmanager
        async def session():
            yield object()

        with patch('afterhours_orchestrator.pipeline.run_matching', side_effect=matching), \
             patch('afterhours_orchestrator.pipeline.run_investigation', side_effect=investigation), \
             patch('afterhours_orchestrator.pipeline.claim_job', side_effect=lambda db, jid, *_: jid), \
             patch('afterhours_orchestrator.pipeline.build_proposal',
                   return_value={'id': 7, 'case_id': 1, 'adjustment_cents': '10000'}):
            first = run_cycle(db, db, case_id=1, max_jobs=1,
                              matching_provider_factory=object, investigation_session=session,
                              investigation_model_run='REPLAYED')
            self.assertEqual([j['id'] for j in first.completed_jobs], [1])
            self.assertEqual(db.jobs[1]['status'], 'QUEUED')
            second = run_cycle(db, db, case_id=1, max_jobs=2,
                               matching_provider_factory=object, investigation_session=session,
                               investigation_model_run='REPLAYED')
        self.assertEqual([j['id'] for j in second.completed_jobs], [3])
        self.assertEqual(second.blocked, [])
        self.assertEqual(second.completed_proposals, [{'id': 7, 'case_id': 1, 'adjustment_cents': '10000'}])
        self.assertEqual(db.jobs[1]['status'], 'QUEUED')

    def test_calculation_recovers_ready_cases_and_respects_case_scope(self):
        db = Database([case(1, 'MATCHING'), case(2, 'MATCHING')],
                      [job(1, 1, 'MATCHING', 'SUCCEEDED'), job(2, 2, 'MATCHING', 'SUCCEEDED')])
        db.cases[1]['posting_period'] = '2024-02'
        db.cases[1]['input_revision'] = 3
        db.jobs[1]['case_revision'] = 3
        calls = []

        def calculate(db, case_id, revision, *, entry_date):
            calls.append((case_id, revision, entry_date))
            db.cases[1].update(state='READY_FOR_REVIEW', current_proposal_id=7)
            return {'id': 7, 'case_id': case_id, 'input_revision': revision}

        with patch('afterhours_orchestrator.pipeline.build_proposal', side_effect=calculate):
            first = run_cycle(db, db, case_id=2)
            second = run_cycle(db, db, case_id=2)
        self.assertEqual(calls, [(2, 3, '2024-02-29')])
        self.assertEqual(first.completed_proposals, [{'id': 7, 'case_id': 2, 'input_revision': 3}])
        self.assertEqual(second.completed_proposals, [])
        self.assertEqual(db.cases[0]['state'], 'MATCHING')

    def test_no_change_result_is_not_rebuilt_on_resume(self):
        db = Database([case(1, 'INVESTIGATING')], [job(1, 1, 'INVESTIGATION', 'SUCCEEDED')])

        def calculate(db, case_id, revision, *, entry_date):
            db.cases[0].update(state='VERIFIED_NO_CHANGE', current_proposal_id=8)
            return {'id': 8, 'case_id': case_id, 'adjustment_cents': '0', 'journal_lines': []}

        with patch('afterhours_orchestrator.pipeline.build_proposal', side_effect=calculate):
            first = run_cycle(db, db)
            second = run_cycle(db, db)
        self.assertEqual(first.completed_proposals[0]['adjustment_cents'], '0')
        self.assertEqual(second.completed_proposals, [])
        self.assertEqual(db.cases[0]['state'], 'VERIFIED_NO_CHANGE')

    def test_calculation_skips_blocked_incomplete_and_existing_proposal_cases(self):
        states = ['WAITING_FOR_INPUT', 'MATCHING', 'MATCHING', 'MATCHING', 'MATCHING']
        db = Database([case(i, state) for i, state in enumerate(states, 1)],
                      [job(i, i, 'MATCHING', 'SUCCEEDED') for i in range(1, 6)])
        db.cases[1]['blockers'] = ['Missing amendment']
        db.jobs[2]['status'] = 'RUNNING'
        db.cases[3]['current_proposal_id'] = 9
        db.jobs[4]['case_revision'] = 0
        with patch('afterhours_orchestrator.pipeline.build_proposal',
                   side_effect=AssertionError('Ineligible case must not calculate')):
            report = run_cycle(db, db)
        self.assertEqual(report.completed_proposals, [])
        self.assertEqual(report.errors, [])

    def test_calculator_error_is_isolated_and_retried_on_next_poll(self):
        db = Database([case(1, 'MATCHING'), case(2, 'MATCHING')],
                      [job(1, 1, 'MATCHING', 'SUCCEEDED'), job(2, 2, 'MATCHING', 'SUCCEEDED')])
        attempts = []

        def calculate(db, case_id, revision, *, entry_date):
            attempts.append(case_id)
            if attempts == [1]:
                raise RuntimeError('private provider/storage detail')
            db.cases[case_id - 1].update(state='READY_FOR_REVIEW', current_proposal_id=case_id)
            return {'id': case_id, 'case_id': case_id}

        with patch('afterhours_orchestrator.pipeline.build_proposal', side_effect=calculate):
            first = run_cycle(db, db)
            second = run_cycle(db, db)
        self.assertEqual(first.errors, [{'case_id': 1, 'stage': 'CALCULATION', 'error': 'RuntimeError'}])
        self.assertEqual(first.blocked, [{'case_id': 1, 'stage': 'CALCULATION'}])
        self.assertEqual(first.completed_proposals, [{'id': 2, 'case_id': 2}])
        self.assertEqual(second.completed_proposals, [{'id': 1, 'case_id': 1}])
        self.assertEqual(attempts, [1, 2, 1])

    def test_committed_proposal_with_lost_response_is_not_rebuilt(self):
        db = Database([case(1, 'MATCHING')], [job(1, 1, 'MATCHING', 'SUCCEEDED')])

        def calculate(db, case_id, revision, *, entry_date):
            db.cases[0].update(state='READY_FOR_REVIEW', current_proposal_id=7)
            raise RuntimeError('response lost after commit')

        with patch('afterhours_orchestrator.pipeline.build_proposal', side_effect=calculate):
            first = run_cycle(db, db)
            second = run_cycle(db, db)
        self.assertEqual(len(first.errors), 1)
        self.assertEqual(first.completed_proposals, [])
        self.assertEqual(second.errors, [])
        self.assertEqual(second.completed_proposals, [])

    def test_calculation_attempts_are_bounded_even_when_each_fails(self):
        db = Database([case(1, 'MATCHING'), case(2, 'MATCHING')],
                      [job(1, 1, 'MATCHING', 'SUCCEEDED'), job(2, 2, 'MATCHING', 'SUCCEEDED')])
        with patch('afterhours_orchestrator.pipeline.build_proposal', side_effect=ValueError('closed period')):
            report = run_cycle(db, db, max_jobs=1)
        self.assertEqual(report.errors, [{'case_id': 1, 'stage': 'CALCULATION', 'error': 'ValueError'}])

    def test_calculation_cursor_advances_past_failures_and_wraps_without_starvation(self):
        db = Database([case(i, 'MATCHING') for i in range(1, 4)],
                      [job(i, i, 'MATCHING', 'SUCCEEDED') for i in range(1, 4)])
        attempts = []

        def calculate(db, case_id, revision, *, entry_date):
            attempts.append(case_id)
            if case_id < 3:
                raise ValueError('Closed posting period')
            db.cases[2].update(state='READY_FOR_REVIEW', current_proposal_id=7)
            return {'id': 7, 'case_id': 3}

        with patch('afterhours_orchestrator.pipeline.build_proposal', side_effect=calculate):
            first = run_cycle(db, db, max_jobs=2)
            second = run_cycle(db, db, max_jobs=2,
                               calculation_after_case_id=first.last_calculation_case_id)
        self.assertEqual(first.last_calculation_case_id, 2)
        self.assertEqual(first.completed_proposals, [])
        self.assertEqual(second.completed_proposals, [{'id': 7, 'case_id': 3}])
        self.assertEqual(attempts, [1, 2, 3, 1])
        self.assertEqual(second.last_calculation_case_id, 1)

    def test_calculation_cursor_preserves_case_scope_and_survives_empty_poll(self):
        db = Database([case(1, 'MATCHING'), case(2, 'MATCHING')],
                      [job(1, 1, 'MATCHING', 'SUCCEEDED'), job(2, 2, 'MATCHING', 'SUCCEEDED')])
        with patch('afterhours_orchestrator.pipeline.build_proposal',
                   return_value={'id': 7, 'case_id': 1}):
            scoped = run_cycle(db, db, case_id=1, calculation_after_case_id=1)
        self.assertEqual(scoped.completed_proposals, [{'id': 7, 'case_id': 1}])
        empty = run_cycle(Database([]), Database([]), calculation_after_case_id=5)
        self.assertEqual(empty.last_calculation_case_id, 5)

    def test_ready_case_runs_gateway_proposal_builder(self):
        db = Database([case(1, 'MATCHING')], [job(1, 1, 'MATCHING', 'SUCCEEDED')])
        calls = []

        def proposal_builder(database, case_id, revision, *, entry_date):
            calls.append((database, case_id, revision, entry_date))
            return {'id': 42}

        report = run_cycle(db, db, proposal_builder=proposal_builder,
                           matching_provider_factory=unavailable)
        self.assertEqual(calls, [(db, 1, 1, '2026-09-30')])
        self.assertEqual(report.completed_proposals, [{'id': 42}])
        self.assertEqual(report.errors, [])

    def test_calculator_can_be_deferred_without_changing_case_state(self):
        db = Database([case(1, 'MATCHING')], [job(1, 1, 'MATCHING', 'SUCCEEDED')])
        report = run_cycle(db, db, proposal_builder=None)
        self.assertEqual(report.completed_proposals, [])
        self.assertEqual(report.blocked, [{'case_id': 1, 'stage': 'CALCULATION'}])
        self.assertEqual(db.cases[0]['state'], 'MATCHING')

    def test_reducer_validation_failure_is_exposed_without_logging_private_payload(self):
        db = Database([case(1, 'MATCHING')], [job(1, 1, 'MATCHING', 'SUCCEEDED')])
        with patch('afterhours_orchestrator.pipeline.build_proposal',
                   side_effect=SpacetimeError(530, 'private validation payload')), \
             patch('afterhours_orchestrator.pipeline.mark_proposal_failure') as mark:
            report = run_cycle(db, db)
        mark.assert_called_once_with(db, 1, 1,
            'Deterministic proposal validation failed; check source consistency.')
        self.assertEqual(report.errors, [{'case_id': 1, 'stage': 'CALCULATION', 'error': 'SpacetimeError'}])

    def test_extraction_runs_only_with_a_session_or_bitdeer_key_and_feeds_matching(self):
        db = Database([case(1)])

        async def extraction(db, lease, decide, *, model_run, timeout):
            self.assertEqual(model_run, 'REPLAYED')
            selected = next(j for j in db.jobs if j['id'] == lease)
            selected['status'] = 'SUCCEEDED'
            db.jobs.append(job(2, selected['case_id'], 'MATCHING'))
            return deepcopy(selected)

        @asynccontextmanager
        async def session():
            yield object()

        with patch('afterhours_orchestrator.pipeline.run_extraction', side_effect=extraction),              patch('afterhours_orchestrator.pipeline.claim_job', side_effect=lambda db, jid, *_: jid),              patch('afterhours_orchestrator.pipeline.run_investigation'):
            off = run_cycle(db, db, matching_provider_factory=unavailable)
            self.assertEqual(off.blocked, [{'case_id': 1, 'stage': 'EXTRACTION'}])
            self.assertEqual(db.jobs[0]['status'], 'QUEUED')
            on = run_cycle(db, db, max_jobs=1, matching_provider_factory=unavailable,
                           extraction_session=session, extraction_model_run='REPLAYED')
        self.assertEqual([j['role'] for j in on.completed_jobs], ['EXTRACTION'])
        self.assertEqual(on.errors, [])
        self.assertEqual(on.blocked, [])
        self.assertEqual(db.jobs[1]['status'], 'QUEUED')   # MATCHING waits for the next attempt

    def test_live_extraction_requires_bitdeer_key(self):
        async def start():
            async with live_extraction_session():
                pass
        with patch.dict('os.environ', {}, clear=False):
            os.environ.pop('BITDEER_API_KEY', None)
            with self.assertRaises(ValueError):
                asyncio.run(start())

    def test_shutdown_prevents_imports_and_claims(self):
        db = Database([case(1)])
        stop = threading.Event()
        stop.set()
        report = run_cycle(db, db, stop=stop)
        self.assertEqual(report.started_cases, [])
        self.assertEqual(db.jobs, [])

    def test_bad_limits_and_provenance_fail_before_mutation(self):
        for options in ({'max_jobs': 0}, {'case_id': 0}, {'investigation_model_run': 'MOCK'}):
            db = Database([case(1)])
            with self.assertRaises(ValueError):
                run_cycle(db, db, **options)
            self.assertEqual(db.jobs, [])

    def test_investigation_shutdown_cancels_existing_worker_without_completing(self):
        db = Database([case(1, 'INVESTIGATING')], [job(1, 1, 'INVESTIGATION')])
        stop = threading.Event()
        lease = JobLease(1, 1, 1, 'INVESTIGATION', 'RUNNING', 1, 'lease',
                         datetime.now(timezone.utc) + timedelta(seconds=30), [], [], 'test', {})

        @asynccontextmanager
        async def session():
            yield object()

        async def slow(*args):
            stop.set()
            await asyncio.sleep(10)

        with patch('afterhours_orchestrator.pipeline.claim_job', return_value=lease), \
             patch('afterhours_investigation.worker.AgentTools') as tools, \
             patch('afterhours_investigation.worker.investigate', side_effect=slow), \
             patch('afterhours_investigation.worker.complete_job', side_effect=AssertionError('must not commit')):
            tools.return_value.get_case_evidence.return_value = {'case': {'inputRevision': 1}}
            result = run_cycle(db, db, stop=stop, investigation_session=session,
                               investigation_model_run='REPLAYED')
        self.assertEqual(result.completed_jobs, [])
        self.assertEqual(result.errors, [])

    def test_investigation_provider_setup_has_a_deadline_before_claim(self):
        db = Database([case(1, 'INVESTIGATING')], [job(1, 1, 'INVESTIGATION')])

        @asynccontextmanager
        async def session():
            await asyncio.sleep(0.1)
            yield object()

        result = run_cycle(db, db, investigation_session=session, investigation_timeout=0.01)
        self.assertEqual(result.completed_jobs, [])
        self.assertEqual(result.errors[0]['error'], 'TimeoutError')
        self.assertEqual(db.jobs[0]['status'], 'QUEUED')

    def test_live_investigation_requires_explicit_credentials_and_model(self):
        async def attempt():
            async with live_investigation_session():
                self.fail('Unconfigured provider must not start')

        for env in ({}, {'FACTORY_API_KEY': 'test'}, {'FACTORY_MODEL_ID': 'test'}):
            with patch.dict('os.environ', env, clear=True), self.assertRaises(ValueError):
                asyncio.run(attempt())


if __name__ == '__main__':
    unittest.main()
