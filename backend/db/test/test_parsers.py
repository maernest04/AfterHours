import unittest

from afterhours_db.parsers import (
    ParseError, dollars_to_cents, parse_accrual, parse_csv,
    parse_invoices, parse_ledger, parse_timesheet,
)


class ParserTests(unittest.TestCase):
    def test_money_is_exact_and_rejects_fractional_cents(self):
        for value, expected in [('7,000.00', '700000'), ('$110', '11000'),
                                ('-$0.01', '-1'), ('-0.00', '0'),
                                ('9007199254740993.99', '900719925474099399')]:
            with self.subTest(value=value):
                self.assertEqual(dollars_to_cents(value), expected)
        for value in ['1.001', '1,00', 'NaN', '1e3', '+1', '']:
            with self.subTest(value=value), self.assertRaises(ParseError):
                dollars_to_cents(value)

    def test_csv_preserves_quoted_multiline_evidence(self):
        raw = '"Rivera, J.","said ""yes""\r\nthen signed"'
        parsed = parse_csv(' Contractor ,NOTE\r\n' + raw + '\r\n\r\n')
        self.assertEqual(parsed['header'], ['contractor', 'note'])
        self.assertEqual(parsed['rows'], [{'row_number': 2, 'raw': raw, 'cells': {
            'contractor': 'Rivera, J.', 'note': 'said "yes"\r\nthen signed'}}])

    def test_invalid_csv_is_rejected(self):
        for value in ['', '\r\n', 'a,b\n"unterminated,field']:
            with self.subTest(value=value), self.assertRaises(ParseError):
                parse_csv(value)

    def test_timesheet_normalizes_and_retains_source(self):
        raw = '2026-09-01,"Rivera, J.",420,approved,$110,Dana'
        rows = parse_timesheet(9, 'service_date,contractor,approved_minutes,status,billing_rate,approved_by\n' + raw)
        self.assertEqual(rows, [{'document_id': 9, 'page_or_row': 'row 2', 'excerpt': raw,
            'contractor': 'Rivera, J.', 'service_date': '2026-09-01', 'approved_minutes': 420,
            'claimed_rate_cents': '11000', 'status': 'APPROVED', 'approved_by': 'Dana'}])
        row = parse_timesheet(9, 'service_date,contractor,approved_minutes,status\n2026-09-01,J,0,pending')[0]
        self.assertIsNone(row['claimed_rate_cents'])
        self.assertEqual(row['approved_by'], '')

    def test_timesheet_errors_identify_row_and_missing_columns(self):
        with self.assertRaisesRegex(ParseError, 'missing column.*approved_minutes'):
            parse_timesheet(9, 'service_date,contractor,status\n2026-09-01,J,approved')
        for value in ['1.5', '-2', '4294967296']:
            with self.subTest(value=value), self.assertRaisesRegex(ParseError, 'Timesheet row 2'):
                parse_timesheet(9, 'service_date,contractor,approved_minutes,status\n2026-09-01,J,' + value + ',approved')

    def test_invoice_and_ledger_amounts_and_optional_fields(self):
        invoice = parse_invoices(10, 'invoice_number,contractor,service_start,service_end,minutes,amount,posting_status\nI1,J,2026-09-01,2026-09-30,420,"7,000.00",posted')[0]
        self.assertEqual((invoice['amount_cents'], invoice['minutes'], invoice['posting_status'], invoice['posted_date']), ('700000', 420, 'POSTED', ''))
        ledger = parse_ledger(11, 'entry_id,vendor_id,period,kind,amount,status\nE1,V1,2026-09,reversal,-7000,posted')[0]
        self.assertEqual((ledger['amount_cents'], ledger['kind'], ledger['status'], ledger['description']), ('-700000', 'REVERSAL', 'POSTED', ''))

    def test_accrual_json_exact_cents_and_paths(self):
        facts = parse_accrual(12, '{"entryId":"A1","amountCents":900719925474099399,"status":"POSTED","servicePeriod":{"from":"2026-09-01","to":"2026-09-30"}}')
        by_field = {fact['field']: fact for fact in facts}
        self.assertEqual(by_field['accrual.amountCents']['value'], '900719925474099399')
        self.assertEqual(by_field['accrual.amountCents']['page_or_row'], 'json $.amountCents')
        self.assertEqual(by_field['accrual.amountCents']['excerpt'], '"amountCents": 900719925474099399')
        self.assertEqual(by_field['accrual.servicePeriod']['value'], '2026-09-01..2026-09-30')
        self.assertEqual(parse_accrual(12, '{"amount":9007199254740993.99}')[0]['value'], '900719925474099399')

    def test_accrual_rejects_invalid_types_and_amounts(self):
        for value in ['{', '[]', 'null', '{}', '{"amountCents":1.5}',
                      '{"amountCents":true}', '{"amountCents":null}',
                      '{"entryId":{}}', '{"amount":NaN}', '{"amount":"1.001"}',
                      '{"servicePeriod":"2026-09"}']:
            with self.subTest(value=value), self.assertRaises(ParseError):
                parse_accrual(12, value)


if __name__ == '__main__':
    unittest.main()
