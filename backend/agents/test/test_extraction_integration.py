import asyncio
from contextlib import ExitStack
import json
import os
from uuid import uuid4
import unittest

from afterhours_db import AfterHoursDB
from afterhours_db.cases import finalize_import, get_case, list_facts, list_jobs, start_review
from afterhours_db.jobs import claim_job

from afterhours_extraction.worker import run_job
from test_extraction import CONTRACT, SEED, contract_result


@unittest.skipUnless(os.getenv('AFTERHOURS_INTEGRATION') == '1', 'Set AFTERHOURS_INTEGRATION=1 for real database checks')
class ExtractionIntegrationTests(unittest.TestCase):
    """Real database, files, leases and reducers; the model reply is a REPLAYED fixture (no Bitdeer key needed)."""

    @classmethod
    def setUpClass(cls):
        resources = ExitStack()
        cls.addClassCleanup(resources.close)
        cls.gateway = resources.enter_context(AfterHoursDB.connect('gateway'))
        cls.worker = resources.enter_context(AfterHoursDB.connect('worker'))

    def make_case(self):
        ref = 'EXTRACTION-' + uuid4().hex[:10]
        vendor = 'V-' + ref

        def upload(name, kind, text, media='text/plain'):
            return self.gateway.upload_document(data=text.encode(), original_filename=name, media_type=media,
                type=kind, source_label='extraction integration (SYNTHETIC)').id

        header = 'invoice_number,contractor,service_start,service_end,minutes,amount,posting_status,posted_date\n'
        ids = [upload('contract.txt', 'CONTRACT', CONTRACT),
               upload('work.csv', 'TIMESHEET', (SEED / 'acme_timesheet_2026-09_v2.csv').read_text(), 'text/csv'),
               upload('invoices.csv', 'INVOICE', header, 'text/csv'),
               upload('ledger.csv', 'LEDGER', 'entry_id,vendor_id,period,kind,amount,status,description\n'
                      f'{ref},{vendor},2026-09,ACCRUAL,7000.00,POSTED,Synthetic original\n', 'text/csv'),
               upload('accrual.json', 'ACCRUAL', json.dumps({'entryId': ref, 'vendorId': vendor,
                      'status': 'POSTED', 'amountCents': '700000'}), 'application/json')]
        case = finalize_import(self.gateway, document_ids=ids, vendor_id=vendor, service_period_from='2026-09-01',
            service_period_to='2026-09-30', posting_period='2026-09', original_status='POSTED',
            original_amount_cents='700000', source_entry_id=ref)
        start_review(self.gateway, case['id'], 1)
        return case['id'], ids[0]

    def lease(self, case_id):
        job = next(job for job in list_jobs(self.worker, case_id) if job['role'] == 'EXTRACTION')
        return claim_job(self.worker, job['id'], case_id, 1)

    def test_extraction_stores_proposed_facts_and_queues_matching(self):
        case_id, contract = self.make_case()
        result = contract_result()

        async def decide(prompt, schema):
            return result

        job = asyncio.run(run_job(self.worker, self.lease(case_id), decide, model_run='REPLAYED'))
        self.assertEqual(job['status'], 'SUCCEEDED')
        facts = [f for f in list_facts(self.worker, case_id) if f['field'].startswith('rate.')]
        self.assertEqual({f['field'] for f in facts}, {fact['field'] for fact in result['facts']})
        self.assertTrue(all(f['validation_status'] == 'PROPOSED' and f['document_id'] == contract for f in facts))
        self.assertEqual(get_case(self.worker, case_id)['state'], 'MATCHING')
        self.assertIn(('MATCHING', 'QUEUED'), [(j['role'], j['status']) for j in list_jobs(self.worker, case_id)])

    def test_out_of_scope_or_forged_document_is_not_stored(self):
        case_id, _ = self.make_case()

        async def decide(prompt, schema):
            bad = contract_result()
            bad['facts'][0]['excerpt'] = 'Hourly rate: $1.00'
            return bad

        with self.assertRaises(ValueError):
            asyncio.run(run_job(self.worker, self.lease(case_id), decide, model_run='REPLAYED'))
        self.assertEqual([f for f in list_facts(self.worker, case_id) if f['field'].startswith('rate.')], [])


if __name__ == '__main__':
    unittest.main()
