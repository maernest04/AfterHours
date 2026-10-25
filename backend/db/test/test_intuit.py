import json
import unittest

from afterhours_db.intuit import journal_entry, map_case, posted_entry, qbo_accounts


class IntuitMapTests(unittest.TestCase):
    def test_maps_unpaid_bills_and_merges_same_day_time(self):
        bills = [
            {'Id': '126', 'TxnDate': '2026-09-28', 'TotalAmt': 205, 'Balance': 205,
             'VendorRef': {'value': '46', 'name': 'Norton Lumber'},
             'Line': [{'ItemBasedExpenseLineDetail': {'Qty': 8}}]},
            {'Id': '25', 'TxnDate': '2026-09-25', 'TotalAmt': 103.55, 'Balance': 0,
             'VendorRef': {'value': '46', 'name': 'Norton Lumber'}},
            {'Id': '9', 'TxnDate': '2026-08-01', 'TotalAmt': 50, 'Balance': 50,
             'VendorRef': {'value': '1', 'name': 'Other'}},
        ]
        activities = [
            {'TxnDate': '2026-09-26', 'Hours': 3, 'Minutes': 0, 'HourlyRate': 15,
             'EmployeeRef': {'name': 'Emily Platt'}},
            {'TxnDate': '2026-09-26', 'Hours': 2, 'Minutes': 0, 'HourlyRate': 15,
             'EmployeeRef': {'name': 'Emily Platt'}},
        ]
        mapped = map_case('2026-09', bills, activities)
        self.assertEqual(mapped['vendor_id'], 'QBO-46')
        self.assertEqual(mapped['amount_cents'], '20500')
        self.assertIn(b'BILL-126,Norton Lumber,2026-09-28,2026-09-28,480,205.00,POSTED,2026-09-28',
                      mapped['files']['INVOICE'][2])
        self.assertIn(b'BILL-25', mapped['files']['INVOICE'][2])
        self.assertNotIn(b'BILL-9', mapped['files']['INVOICE'][2])
        timesheet = mapped['files']['TIMESHEET'][2].decode()
        self.assertIn('2026-09-28,Norton Lumber,480,15.00,APPROVED,QuickBooks', timesheet)
        self.assertIn('2026-09-25,Norton Lumber,60,15.00,APPROVED,QuickBooks', timesheet)
        self.assertNotIn('Emily Platt', timesheet)
        accrual = json.loads(mapped['files']['ACCRUAL'][2])
        self.assertEqual(accrual['vendorId'], 'QBO-46')
        self.assertEqual(accrual['amountCents'], '20500')
        self.assertTrue(mapped['files']['CONTRACT'][2].startswith(b'CONTRACT\n'))
        self.assertIn(b'Hourly rate: $15.00 per hour', mapped['files']['CONTRACT'][2])

    def test_journal_entry_requires_hash_match_and_balanced_lines(self):
        proposal = {
            'id': 3, 'hash': 'abc123', 'entry_date': '2026-09-30', 'export_amount_cents': '70000',
            'journal_lines': [
                {'account_code': '6100', 'account_name': 'Contractor Expense', 'debit_cents': '70000', 'credit_cents': '0'},
                {'account_code': '2105', 'account_name': 'Accrued Liabilities', 'debit_cents': '0', 'credit_cents': '70000'},
            ],
        }
        body = journal_entry(proposal, '88', '33', vendor_id='36')
        self.assertEqual(body['TxnDate'], '2026-09-30')
        self.assertEqual(body['PrivateNote'], 'AfterHours abc123')
        self.assertEqual(body['Line'][0]['JournalEntryLineDetail']['PostingType'], 'Debit')
        self.assertEqual(body['Line'][0]['Amount'], 700.0)
        self.assertEqual(body['Line'][1]['JournalEntryLineDetail']['AccountRef']['value'], '33')
        self.assertEqual(body['Line'][1]['JournalEntryLineDetail']['Entity']['EntityRef']['value'], '36')
        self.assertNotIn('Entity', body['Line'][0]['JournalEntryLineDetail'])
        self.assertIsNone(posted_entry([{'PrivateNote': 'other'}], 'abc123'))
        self.assertEqual(posted_entry([{'Id': '9', 'PrivateNote': 'AfterHours abc123'}], 'abc123')['Id'], '9')
        accounts = [
            {'Id': '10', 'AcctNum': '6100', 'AccountType': 'Expense', 'Active': True, 'Name': 'Expense'},
            {'Id': '33', 'Name': 'Accounts Payable (A/P)', 'Active': True, 'AccountType': 'Accounts Payable'},
        ]
        self.assertEqual(qbo_accounts(accounts, {'expense_account': {'code': '6100'},
                                                 'liability_account': {'code': '2105'}}), ('10', '33'))
