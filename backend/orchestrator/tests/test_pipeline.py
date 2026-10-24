import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
import threading
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone

from afterhours_db.jobs import JobLease

from afterhours_orchestrator.pipeline import run_cycle, live_investigation_session


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
    return dict(id=case_id, state=state, input_revision=1)


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

    def test_bounded_drain_continues_to_investigation_and_stops_before_calculator(self):
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
             patch('afterhours_orchestrator.pipeline.claim_job', side_effect=lambda db, jid, *_: jid):
            first = run_cycle(db, db, case_id=1, max_jobs=1,
                              matching_provider_factory=object, investigation_session=session,
                              investigation_model_run='REPLAYED')
            self.assertEqual([j['id'] for j in first.completed_jobs], [1])
            self.assertEqual(db.jobs[1]['status'], 'QUEUED')
            second = run_cycle(db, db, case_id=1, max_jobs=2,
                               matching_provider_factory=object, investigation_session=session,
                               investigation_model_run='REPLAYED')
        self.assertEqual([j['id'] for j in second.completed_jobs], [3])
        self.assertEqual(second.blocked, [{'case_id': 1, 'stage': 'PROPOSAL'}])
        self.assertEqual(db.jobs[1]['status'], 'QUEUED')

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
