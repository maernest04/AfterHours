"""Explicit opt-in live DB checks; never reset existing data."""
import os
import unittest
from uuid import uuid4

from afterhours_db import AfterHoursDB
from afterhours_db.cases import list_jobs
from afterhours_db.tools import AgentTools


@unittest.skipUnless(os.getenv('AFTERHOURS_LIVE_TESTS') == '1', 'requires local database')
class FixtureTests(unittest.TestCase):
    def test_seed_creates_scoped_matching_jobs_and_is_idempotent(self):
        from afterhours_agents.fixtures import seed_matching_cases
        namespace = f'matching-test-{uuid4().hex[:8]}'
        cases = seed_matching_cases(namespace)
        self.assertEqual(set(cases), {'clean', 'amendment', 'missing_amendment',
                                    'ambiguous_invoice', 'no_invoice', 'conflicting_contract'})
        again = seed_matching_cases(namespace)
        self.assertEqual(cases, again)
        with AfterHoursDB.connect('worker') as db:
            for name, case_id in cases.items():
                with self.subTest(name=name):
                    jobs = list_jobs(db, case_id)
                    self.assertEqual([(j['role'], j['status']) for j in jobs],
                                     [('EXTRACTION', 'SUCCEEDED'), ('MATCHING', 'QUEUED')])
                    evidence = AgentTools(db, case_id).get_case_evidence()
                    self.assertEqual(len(evidence['workItems']), 2)
                    self.assertEqual(evidence['jobResults'][0]['modelRun'], 'REPLAYED')
                    self.assertTrue(any(f['validationStatus'] == 'REJECTED' for f in evidence['facts']))
                    self.assertEqual(len(evidence['ledgerRecords']), 3)
                    self.assertTrue(any(r['vendorId'] != evidence['case']['vendorId']
                                        for r in evidence['ledgerRecords']))


if __name__ == '__main__':
    unittest.main()
