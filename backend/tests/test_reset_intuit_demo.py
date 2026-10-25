import unittest
from unittest.mock import patch

from backend.tests.reset_intuit_demo import validate_case, validate_synthetic, verify_quickbooks


class ResetDemoTests(unittest.TestCase):
    def setUp(self):
        self.case = dict(source_entry_id='QBO-JE-149-DEMO-7000', vendor_id='QBO-58',
                         original_status='POSTED', original_amount_cents='700000',
                         posting_period='2026-09', service_period_from='2026-09-01',
                         service_period_to='2026-09-30', state='READY_FOR_REVIEW')

    def test_refuses_normal_cases_and_active_pipeline(self):
        validate_case(self.case)
        for change in [dict(source_entry_id='REAL-ENTRY'), dict(vendor_id='V-ACME'),
                       dict(original_amount_cents='75500'), dict(state='EXTRACTING')]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_case({**self.case, **change})

    def test_synthetic_reset_requires_matching_demo_vendor_and_source(self):
        run = '58ae3322-8141-4f73-8439-01df7747f686'
        case = {**self.case, 'vendor_id': f'V-DEMO-{run}', 'source_entry_id': f'ACR-DEMO-{run}',
                'posting_period': '2026-11', 'service_period_from': '2026-11-01', 'service_period_to': '2026-11-30'}
        validate_synthetic(case)
        for change in [dict(source_entry_id='REAL'), dict(vendor_id='QBO-58'), dict(state='MATCHING')]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_synthetic({**case, **change})

    @patch('backend.tests.reset_intuit_demo.QuickBooks')
    def test_renamed_vendor_is_identified_by_baseline_not_display_name(self, factory):
        qb = factory.return_value
        lines = [dict(Amount=7000, DetailType='JournalEntryLineDetail', JournalEntryLineDetail=detail) for detail in [
            dict(PostingType='Debit'), dict(PostingType='Credit', Entity={'EntityRef': {'value': '58'}})]]
        qb.request.side_effect = [{'Vendor': {'DisplayName': 'October Accrual', 'Balance': 7000}},
                                  {'JournalEntry': dict(DocNumber='AH-DEMO-7000', TxnDate='2026-10-31', Line=lines,
                                   PrivateNote='AfterHours synthetic demonstration: original $7,000 accrual.')}]
        qb.query.return_value = []
        verify_quickbooks(self.case, [])
        self.assertTrue(all(call.args[0] == 'GET' for call in qb.request.call_args_list))

    @patch('backend.tests.reset_intuit_demo.QuickBooks')
    def test_refuses_reset_until_adjustment_deleted(self, factory):
        qb = factory.return_value
        qb.request.return_value = {'Vendor': {'Balance': 7700}}
        qb.query.return_value = [{'Id': '150', 'PrivateNote': 'AfterHours demo-hash'}]
        with self.assertRaisesRegex(ValueError, 'Delete the.*journal ID 150'):
            verify_quickbooks(self.case, [{'hash': 'demo-hash'}])
        self.assertTrue(all(call.args[0] == 'GET' for call in qb.request.call_args_list))
