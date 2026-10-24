"""Opt-in model-quality checks: actual Factory calls plus real DB persistence."""
import os
import unittest
from uuid import uuid4

from afterhours_db import AfterHoursDB
from afterhours_db.tools import AgentTools


@unittest.skipUnless(os.getenv('AFTERHOURS_LIVE_FACTORY') == '1', 'requires explicitly enabled live Factory inference')
class MatchingFactoryTests(unittest.TestCase):
    def test_six_scenarios_with_live_model(self):
        from afterhours_agents.factory import FactoryProvider
        from afterhours_agents.fixtures import seed_matching_cases
        from afterhours_agents.worker import run_once
        provider = FactoryProvider(api_key=os.environ['FACTORY_API_KEY'],
            model=os.environ['FACTORY_MODEL_ID'], timeout=120)
        cases = seed_matching_cases(f'matching-live-{uuid4().hex[:8]}')
        print(f'Live Factory model: {provider.model}; cases: {cases}', flush=True)
        for scenario, case_id in cases.items():
            with self.subTest(scenario=scenario, case_id=case_id), AfterHoursDB.connect('worker') as db:
                result = run_once(db, provider, case_id=case_id)
                self.assertIsNotNone(result)
                self.assertEqual(result['status'], 'SUCCEEDED')
                evidence = AgentTools(db, case_id).get_case_evidence()
                matching_result = next(r for r in evidence['jobResults'] if r['jobId'] == str(result['id']))
                self.assertEqual(matching_result['modelRun'], 'LIVE')
                uncertain = scenario in {'missing_amendment', 'ambiguous_invoice', 'conflicting_contract'}
                self.assertEqual(bool(matching_result['unresolvedQuestions']), uncertain,
                    f'Unexpected questions: {matching_result["unresolvedQuestions"]}')
                self.assertEqual(evidence['case']['state'], 'INVESTIGATING' if uncertain else 'MATCHING')
                allocations = evidence['allocations']
                if not uncertain:
                    self.assertEqual(len(allocations), 2)
                if scenario in {'missing_amendment', 'ambiguous_invoice'}:
                    unaffected = next(w['id'] for w in evidence['workItems']
                                      if w['serviceDate'] == '2026-09-10')
                    self.assertIn(unaffected, [a['workItemId'] for a in allocations],
                                  'Unambiguous work must remain matched despite other open questions')
                # Ambiguous cases may omit unresolved matches, but must not guess
                # conflicting governing agreements or competing invoice identities.
                if scenario == 'conflicting_contract':
                    self.assertEqual(allocations, [])
                for allocation in allocations:
                    work = next(w for w in evidence['workItems'] if w['id'] == allocation['workItemId'])
                    contract = next(d for d in evidence['documents'] if d['documentId'] == allocation['contractId'])
                    expected = 'AMENDMENT' if scenario == 'amendment' and work['serviceDate'] == '2026-09-20' else 'CONTRACT'
                    self.assertEqual(contract['type'], expected)
                    expected_ledger = next(r['id'] for r in evidence['ledgerRecords']
                                          if r['entryId'] == evidence['case']['sourceEntryId'])
                    self.assertEqual(allocation['ledgerEntryIds'], [expected_ledger])
                    if scenario == 'no_invoice' or (scenario == 'ambiguous_invoice' and work['serviceDate'] == '2026-09-20'):
                        self.assertEqual(allocation['invoiceLineIds'], [])
                    else:
                        expected_invoices = [r['id'] for r in evidence['invoiceLines']
                            if r['contractor'] == work['contractor'] and
                            r['serviceStart'] <= work['serviceDate'] <= r['serviceEnd']]
                        self.assertEqual(allocation['invoiceLineIds'], expected_invoices)
                print(f'PASS {scenario}: case={case_id}, allocations={len(allocations)}, '
                      f'questions={len(matching_result["unresolvedQuestions"])}', flush=True)


if __name__ == '__main__':
    unittest.main()
