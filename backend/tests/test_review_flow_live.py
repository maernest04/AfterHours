"""Opt-in paid E2E: HTTP upload -> Bitdeer -> Factory matching/investigation.

Only synthetic evidence and a mock mailbox are used. No approval or posting occurs.
"""
import json
import os
import unittest
from uuid import uuid4

import httpx

from test_review_flow import SEED


@unittest.skipUnless(os.getenv('AFTERHOURS_LIVE_FLOW') == '1', 'Opt-in paid provider flow')
class LiveReviewFlowTests(unittest.TestCase):
    def test_upload_through_all_live_agents_and_calculation(self):
        from afterhours_db import AfterHoursDB
        from afterhours_db.cases import is_awaiting_proposal, list_jobs
        from afterhours_db.mailbox import store_email
        from afterhours_db.tools import AgentTools
        from afterhours_orchestrator.pipeline import live_extraction_session, run_cycle

        unique = 'LIVE-FLOW-' + uuid4().hex[:12]
        vendor = 'V-' + unique
        accrual = json.loads((SEED / 'acme_accrual_2026-09.json').read_text())
        accrual.update(entryId=unique, vendorId=vendor)
        ledger = (SEED / 'ledger_2026-09.csv').read_text().replace('ACR-2026-09-ACME', unique).replace('V-ACME', vendor)
        # Make this success fixture satisfy the MSA's project-manager request clause.
        # Missing authority should remain a real blocker, not a prompt assumption.
        contract = (SEED / 'acme_msa.txt').read_text().replace(
            'Authorized signatory:',
            '4. Pat Lee is Northwind Demo Co\'s project manager. Timesheets approved by Pat Lee\n'
            'constitute requested services under this agreement.\n\nAuthorized signatory:')
        files = [
            ('files', ('accrual.json', json.dumps(accrual).encode(), 'application/json')),
            ('files', ('contract.txt', contract.encode(), 'text/plain')),
            ('files', ('timesheet.csv', (SEED / 'acme_timesheet_2026-09_v2.csv').read_bytes(), 'text/csv')),
            ('files', ('invoices.csv', (SEED / 'acme_invoices_2026-08.csv').read_bytes(), 'text/csv')),
            ('files', ('ledger.csv', ledger.encode(), 'text/csv')),
        ]
        with httpx.Client(base_url=os.getenv('AFTERHOURS_API_URL', 'http://127.0.0.1:8001'), timeout=30) as client:
            response = client.post('/create-review', files=files)
            self.assertEqual(response.status_code, 202, response.text)
            accepted = response.json()
            case_id = int(accepted['review_id'])
            print(f'LIVE flow created synthetic case {case_id}; running only this case.', flush=True)
            with AfterHoursDB.connect('gateway') as gateway, AfterHoursDB.connect('worker') as worker:
                amendment = gateway.upload_document(data=(SEED / 'acme_amendment_1.txt').read_bytes(),
                    original_filename='amendment.txt', media_type='text/plain', type='AMENDMENT',
                    source_label='Live pipeline test (SYNTHETIC)')
                store_email(gateway, message_key=unique, vendor_id=vendor, thread_id=unique,
                    sender='contracts@synthetic.example', recipients=['ap@synthetic.example'],
                    subject='Countersigned September rate amendment (MOCK)', sent_at='2026-08-28T17:05:00Z',
                    body='Synthetic mailbox: signed amendment attached; September services use $110.00/hour.',
                    attachment_document_ids=[amendment.id])
                report = run_cycle(gateway, worker, case_id=case_id, max_jobs=3,
                                   extraction_session=live_extraction_session)
                self.assertFalse(report.errors, report.errors)
                jobs = list_jobs(worker, case_id)
                self.assertEqual([(j['role'], j['status']) for j in jobs], [
                    ('EXTRACTION', 'SUCCEEDED'), ('MATCHING', 'SUCCEEDED'), ('INVESTIGATION', 'SUCCEEDED')])
                evidence = AgentTools(worker, case_id).get_case_evidence()
                self.assertEqual(len(evidence['jobResults']), 3)
                self.assertTrue(all(row['modelRun'] == 'LIVE' for row in evidence['jobResults']))
                self.assertTrue(any(f['field'] == 'rate.hourlyCents' and f['value'] == '10000'
                                    for f in evidence['facts']))
                self.assertTrue(any(f['documentId'] == str(amendment.id) and f['field'] == 'rate.hourlyCents'
                                    and f['value'] == '11000' for f in evidence['facts']))
                self.assertEqual(len(evidence['allocations']), len(evidence['workItems']))
                self.assertFalse(is_awaiting_proposal(gateway, case_id))
                self.assertEqual(len(report.completed_proposals), 1)

            params = {'review_id': str(case_id)}
            response = client.get('/get-review', params=params)
            self.assertEqual(response.status_code, 200, response.text)
            snapshot = response.json()
            self.assertEqual(snapshot['status'], 'READY_FOR_REVIEW')
            self.assertEqual(snapshot['original_amount_cents'], '700000')
            self.assertIsNotNone(snapshot['proposal_id'])
            self.assertEqual(snapshot['corrected_target_cents'], '770000')
            self.assertEqual(snapshot['difference_cents'], '70000')
            self.assertEqual(snapshot['history'], [])
            self.assertTrue(any(e['document_id'] == str(amendment.id) for e in snapshot['evidence']))
            with client.stream('GET', '/get-review', params={**params, 'live': 'true'}) as stream:
                self.assertEqual(stream.status_code, 200)
                data = next(line[6:] for line in stream.iter_lines() if line.startswith('data: '))
                self.assertEqual(json.loads(data)['sequence'], snapshot['sequence'])
            self.assertEqual(client.get('/export-review', params=params).status_code, 501)
            print(f'LIVE E2E verified case {case_id}: extraction, matching, investigation, persisted calculation.', flush=True)


if __name__ == '__main__':
    unittest.main()
