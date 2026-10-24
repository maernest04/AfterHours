"""Matching E2E: real file store, reducers, leases and allocations; replayed inference."""
import os
import threading
import time
import unittest
from uuid import uuid4

from afterhours_db import AfterHoursDB
from afterhours_db.cases import get_case, list_jobs, is_awaiting_proposal
from afterhours_db.tools import AgentTools
from support import ReplayProvider


@unittest.skipUnless(os.getenv('AFTERHOURS_LIVE_TESTS') == '1', 'requires local database')
class WorkerE2ETests(unittest.TestCase):
    def test_all_scenarios_persist_expected_matches_and_handoffs(self):
        from afterhours_agents.fixtures import seed_matching_cases
        from afterhours_agents.worker import run_once
        cases = seed_matching_cases(f'matching-e2e-{uuid4().hex[:8]}')
        for scenario, case_id in cases.items():
            with self.subTest(scenario=scenario), AfterHoursDB.connect('worker') as db:
                result = run_once(db, ReplayProvider(scenario), case_id=case_id)
                self.assertEqual(result['status'], 'SUCCEEDED')
                evidence = AgentTools(db, case_id).get_case_evidence()
                allocations = evidence['allocations']
                self.assertEqual(len(allocations), 0 if scenario == 'conflicting_contract' else 2)
                self.assertEqual(evidence['jobResults'][-1]['modelRun'], 'REPLAYED')
                for allocation in allocations:
                    work = next(w for w in evidence['workItems'] if w['id'] == allocation['workItemId'])
                    contract = next(d for d in evidence['documents'] if d['documentId'] == allocation['contractId'])
                    self.assertEqual(contract['type'], 'AMENDMENT' if
                        scenario == 'amendment' and work['serviceDate'] == '2026-09-20' else 'CONTRACT')
                    matched_ledger = next(r for r in evidence['ledgerRecords'] if
                                          r['id'] == allocation['ledgerEntryIds'][0])
                    self.assertEqual(matched_ledger['entryId'], evidence['case']['sourceEntryId'])
                    invoice_count = 0 if scenario == 'no_invoice' or (
                        scenario == 'ambiguous_invoice' and work['serviceDate'] == '2026-09-20') else 1
                    self.assertEqual(len(allocation['invoiceLineIds']), invoice_count)
                    if invoice_count:
                        invoice = next(r for r in evidence['invoiceLines'] if r['id'] == allocation['invoiceLineIds'][0])
                        self.assertEqual(invoice['postingStatus'], 'POSTED' if work['serviceDate'] == '2026-09-10' else 'UNPOSTED')
                investigates = scenario in {'missing_amendment', 'ambiguous_invoice', 'conflicting_contract'}
                self.assertEqual(get_case(db, case_id)['state'], 'INVESTIGATING' if investigates else 'MATCHING')
                self.assertEqual(is_awaiting_proposal(db, case_id), not investigates)
                self.assertEqual([j['role'] for j in list_jobs(db, case_id) if j['status'] == 'QUEUED'],
                                 ['INVESTIGATION'] if investigates else [])
                self.assertIsNone(run_once(db, ReplayProvider(scenario), case_id=case_id))
                self.assertEqual(len(AgentTools(db, case_id).get_case_evidence()['allocations']), len(allocations))

    def test_invalid_output_never_persists_and_failed_heartbeat_cancels(self):
        from unittest.mock import patch
        from afterhours_agents.fixtures import seed_matching_cases
        from afterhours_agents.worker import run_once, LeaseLost
        cases = seed_matching_cases(f'matching-failure-{uuid4().hex[:6]}')

        class Invalid(ReplayProvider):
            def generate(self, *args, **kwargs):
                result = super().generate(*args, **kwargs)
                result['proposedMatches'][0]['workItemId'] = '999999999'
                return result

        with AfterHoursDB.connect('worker') as db:
            with self.assertRaises(ValueError):
                run_once(db, Invalid('clean'), case_id=cases['clean'])
            self.assertEqual(AgentTools(db, cases['clean']).get_case_evidence()['allocations'], [])
            self.assertEqual(list_jobs(db, cases['clean'])[-1]['status'], 'RUNNING')

        class Slow(ReplayProvider):
            def generate(self, context, schema, *, cancel):
                if cancel.wait(2):
                    raise RuntimeError('inference cancelled')
                return super().generate(context, schema, cancel=cancel)

        with AfterHoursDB.connect('worker') as db, patch('afterhours_agents.worker.heartbeat_job',
                side_effect=RuntimeError('lease lost')):
            start = time.monotonic()
            shutdown = threading.Event()
            with self.assertRaises(LeaseLost):
                run_once(db, Slow('amendment'), case_id=cases['amendment'],
                         heartbeat_interval=0.03, cancel=shutdown)
            self.assertLess(time.monotonic() - start, 1)
            self.assertFalse(shutdown.is_set(), 'one lost lease must not stop the entire worker service')
            self.assertEqual(AgentTools(db, cases['amendment']).get_case_evidence()['allocations'], [])

    @unittest.skipUnless(os.getenv('AFTERHOURS_OWNER_TESTS') == '1', 'requires local owner CLI for short-lease policy test')
    def test_heartbeat_renews_lease_during_slow_inference(self):
        from afterhours_db.client import SpacetimeClient
        from afterhours_db.config import DatabaseConfig
        from afterhours_db.identity import owner_token
        from afterhours_agents.fixtures import seed_matching_cases
        from afterhours_agents.worker import run_once
        cases = seed_matching_cases(f'matching-renew-{uuid4().hex[:8]}')
        config = DatabaseConfig.from_env()

        class Slow(ReplayProvider):
            def generate(self, context, schema, *, cancel):
                if cancel.wait(2.2):
                    raise RuntimeError('cancelled before inference completed')
                return super().generate(context, schema, cancel=cancel)

        with SpacetimeClient(config.uri, config.database, token=owner_token()) as owner:
            try:
                owner.call_reducer('configure_job_policy', [1, 3])
                with AfterHoursDB.connect('worker') as db:
                    result = run_once(db, Slow('clean'), case_id=cases['clean'])
                    self.assertEqual((result['status'], result['attempts']), ('SUCCEEDED', 1))
            finally:
                owner.call_reducer('configure_job_policy', [int(os.getenv('JOB_LEASE_SECONDS', '30')),
                                                           int(os.getenv('JOB_MAX_ATTEMPTS', '3'))])

    def test_cancellation_during_final_heartbeat_does_not_commit(self):
        from unittest.mock import patch
        from afterhours_db.jobs import heartbeat_job
        from afterhours_agents.fixtures import seed_matching_cases
        from afterhours_agents.worker import run_once, LeaseLost
        case_id = seed_matching_cases(f'matching-stop-{uuid4().hex[:8]}')['clean']
        shutdown = threading.Event()

        def stop_after_renewal(db, lease):
            expiry = heartbeat_job(db, lease)
            shutdown.set()
            return expiry

        with AfterHoursDB.connect('worker') as db, patch('afterhours_agents.worker.heartbeat_job', stop_after_renewal):
            with self.assertRaises(LeaseLost):
                run_once(db, ReplayProvider('clean'), case_id=case_id, cancel=shutdown)
            self.assertEqual(AgentTools(db, case_id).get_case_evidence()['allocations'], [])


if __name__ == '__main__':
    unittest.main()
