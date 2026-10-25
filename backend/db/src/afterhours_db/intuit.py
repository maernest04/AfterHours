"""Map a QuickBooks Online sandbox company into an AfterHours case import."""
from __future__ import annotations

import argparse
import csv
from collections import defaultdict
from datetime import date
from decimal import Decimal
import hashlib
import io
import json
import os
from pathlib import Path
import re

import httpx
from dotenv import load_dotenv

from .cases import finalize_import, get_case, list_jobs, start_review
from .config import DatabaseConfig
from .documents import AfterHoursDB
from .parsers import parse_accrual


SANDBOX = 'https://sandbox-quickbooks.api.intuit.com'
TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
DEMO_BASELINE_DOC = 'AH-DEMO-7000'
DEMO_VENDOR_NAMES = (
    'October Accrual',
    'AfterHours Demo Contractor - 7000 to 7700',
)


def dollars(value) -> str:
    return f'{Decimal(str(value)).quantize(Decimal("0.01"))}'


def cents(value) -> str:
    return str(int(Decimal(dollars(value)) * 100))


def csv_text(header, rows) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator='\n')
    writer.writerow(header)
    writer.writerows(rows)
    return buf.getvalue()


def month_bounds(period: str) -> tuple[str, str]:
    year, month = map(int, period.split('-'))
    start = date(year, month, 1)
    end = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    last = date.fromordinal(end.toordinal() - 1)
    return start.isoformat(), last.isoformat()


def in_period(txn_date: str, period: str) -> bool:
    start, end = month_bounds(period)
    return start <= txn_date <= end


class QuickBooks:
    def __init__(self):
        missing = [name for name in ('INTUIT_CLIENT_ID', 'INTUIT_CLIENT_SECRET', 'INTUIT_REALM_ID',
                                     'INTUIT_ACCESS_TOKEN', 'INTUIT_REFRESH_TOKEN') if not os.getenv(name)]
        if missing:
            raise RuntimeError('Missing ' + ', '.join(missing))
        self.realm = os.environ['INTUIT_REALM_ID']
        self.access = os.environ['INTUIT_ACCESS_TOKEN']
        self.refresh = os.environ['INTUIT_REFRESH_TOKEN']
        self.http = httpx.Client(timeout=30)

    def close(self):
        self.http.close()

    def _refresh(self):
        response = self.http.post(TOKEN_URL, data={'grant_type': 'refresh_token', 'refresh_token': self.refresh},
                                  auth=(os.environ['INTUIT_CLIENT_ID'], os.environ['INTUIT_CLIENT_SECRET']))
        response.raise_for_status()
        body = response.json()
        self.access = body['access_token']
        if body.get('refresh_token'):
            self.refresh = body['refresh_token']

    def request(self, method: str, path: str, **kwargs) -> dict:
        url = f'{SANDBOX}/v3/company/{self.realm}/{path.lstrip("/")}?minorversion=75'
        headers = {'Authorization': f'Bearer {self.access}', 'Accept': 'application/json'}
        if 'json' in kwargs:
            headers['Content-Type'] = 'application/json'
        response = self.http.request(method, url, headers=headers, **kwargs)
        if response.status_code == 401:
            self._refresh()
            headers['Authorization'] = f'Bearer {self.access}'
            response = self.http.request(method, url, headers=headers, **kwargs)
        response.raise_for_status()
        return response.json()

    def query(self, sql: str) -> list[dict]:
        payload = self.request('GET', 'query', params={'query': sql}).get('QueryResponse') or {}
        return next((value for value in payload.values() if isinstance(value, list)), [])


def map_case(period: str, bills: list[dict], activities: list[dict]) -> dict:
    grouped = defaultdict(lambda: {'name': '', 'bills': [], 'unpaid': Decimal('0'), 'total': Decimal('0')})
    for bill in bills:
        if not in_period(bill['TxnDate'], period):
            continue
        vendor = bill['VendorRef']
        row = grouped[vendor['value']]
        row['name'] = vendor['name']
        row['bills'].append(bill)
        row['unpaid'] += Decimal(str(bill.get('Balance') or 0))
        row['total'] += Decimal(str(bill.get('TotalAmt') or 0))
    if not grouped:
        raise ValueError(f'No QuickBooks bills in {period}')
    vendor_id, vendor = max(grouped.items(), key=lambda item: (item[1]['unpaid'], item[1]['total'], len(item[1]['bills'])))
    afterhours_vendor = f'QBO-{vendor_id}'
    start, end = month_bounds(period)
    amount = vendor['unpaid'] if vendor['unpaid'] > 0 else vendor['total']
    entry_id = f'QBO-{vendor_id}-{period}'
    def bill_minutes(bill) -> str:
        total = 0
        for line in bill.get('Line') or []:
            qty = (line.get('ItemBasedExpenseLineDetail') or {}).get('Qty')
            if qty:
                total += int(Decimal(str(qty)) * 60)
        return str(max(total, 60))

    invoices = [['BILL-' + bill['Id'], vendor['name'], bill['TxnDate'], bill['TxnDate'], bill_minutes(bill),
                 dollars(bill['TotalAmt']), 'POSTED', bill['TxnDate']] for bill in vendor['bills']]
    timesheet = {}
    for activity in activities:
        if not in_period(activity['TxnDate'], period):
            continue
        if (activity.get('VendorRef') or {}).get('value') != vendor_id:
            continue
        person = activity['VendorRef']['name']
        minutes = int(activity.get('Hours') or 0) * 60 + int(activity.get('Minutes') or 0)
        key = (activity['TxnDate'], person)
        if key not in timesheet:
            timesheet[key] = [activity['TxnDate'], person, minutes, activity.get('HourlyRate')]
        else:
            timesheet[key][2] += minutes
    hourly = next((rate for _day, _name, _minutes, rate in timesheet.values() if rate), None)
    if hourly is None:
        hourly = next((activity.get('HourlyRate') for activity in activities
                       if in_period(activity['TxnDate'], period) and activity.get('HourlyRate')), 100)
    if not timesheet:
        for bill in vendor['bills']:
            key = (bill['TxnDate'], vendor['name'])
            minutes = int(bill_minutes(bill))
            if key not in timesheet:
                timesheet[key] = [bill['TxnDate'], vendor['name'], minutes, hourly]
            else:
                timesheet[key][2] += minutes
    ledger = [[entry_id, afterhours_vendor, period, 'ACCRUAL', dollars(amount), 'POSTED',
               f'QuickBooks A/P {vendor["name"]} {period}']]
    ledger.extend([['BILL-' + bill['Id'], afterhours_vendor, bill['TxnDate'][:7], 'INVOICE',
                    dollars(bill['TotalAmt']), 'POSTED', vendor['name']] for bill in vendor['bills']])
    accrual = {'entryId': entry_id, 'vendorId': afterhours_vendor, 'vendorName': vendor['name'],
               'servicePeriod': {'from': start, 'to': end}, 'postingPeriod': period, 'status': 'POSTED',
               'amountCents': cents(amount), 'currency': 'USD'}
    contract = (f'CONTRACT\nBetween the AfterHours demo company and {vendor["name"]}.\n'
                f'1. Services: hourly contractor services imported from QuickBooks Online.\n'
                f'2. Hourly rate: ${dollars(hourly)} per hour, effective {start}.\n'
                f'Authorized signatory: Dana Whitfield\nSigned: {start}\n')
    return {
        'vendor_id': afterhours_vendor, 'vendor_name': vendor['name'], 'entry_id': entry_id,
        'period': period, 'service_from': start, 'service_to': end, 'amount_cents': cents(amount),
        'files': {
            'CONTRACT': ('contract.txt', 'text/plain', contract.encode()),
            'TIMESHEET': ('timesheet.csv', 'text/csv', csv_text(
                ['service_date', 'contractor', 'approved_minutes', 'billing_rate', 'status', 'approved_by'],
                [[day, name, minutes, dollars(rate) if rate is not None else '', 'APPROVED', 'QuickBooks']
                 for (day, name), (_, _, minutes, rate) in sorted(timesheet.items())]).encode()),
            'INVOICE': ('invoices.csv', 'text/csv', csv_text(
                ['invoice_number', 'contractor', 'service_start', 'service_end', 'minutes', 'amount',
                 'posting_status', 'posted_date'], invoices).encode()),
            'LEDGER': ('ledger.csv', 'text/csv', csv_text(
                ['entry_id', 'vendor_id', 'period', 'kind', 'amount', 'status', 'description'], ledger).encode()),
            'ACCRUAL': ('accrual.json', 'application/json', json.dumps(accrual, indent=2).encode()),
        },
    }


def journal_entry(proposal: dict, expense_account_id: str, liability_account_id: str,
                  vendor_id: str | None = None) -> dict:
    if int(proposal['export_amount_cents'] or 0) == 0:
        raise ValueError('Proposal has no journal to post')
    lines = []
    for account_id, line in zip((expense_account_id, liability_account_id), proposal['journal_lines']):
        debit, credit = int(line['debit_cents']), int(line['credit_cents'])
        if debit == credit == 0:
            continue
        detail = {
            'PostingType': 'Debit' if debit else 'Credit',
            'AccountRef': {'value': str(account_id)},
        }
        if vendor_id and account_id == liability_account_id:
            numeric = qbo_numeric_id(vendor_id)
            if numeric is None:
                raise ValueError('QuickBooks vendor id must be numeric')
            detail['Entity'] = {'Type': 'Vendor', 'EntityRef': {'value': numeric}}
        lines.append({
            'Amount': float(dollars(Decimal(debit or credit) / 100)),
            'Description': line['account_name'],
            'DetailType': 'JournalEntryLineDetail',
            'JournalEntryLineDetail': detail,
        })
    if len(lines) != 2:
        raise ValueError('Proposal journal must debit one account and credit the other')
    return {'TxnDate': proposal['entry_date'], 'PrivateNote': f'AfterHours {proposal["hash"]}', 'Line': lines}


def qbo_accounts(accounts: list[dict], settings: dict) -> tuple[str, str]:
    expense = os.getenv('INTUIT_EXPENSE_ACCOUNT_ID')
    liability = os.getenv('INTUIT_LIABILITY_ACCOUNT_ID')
    by_number = {str(row.get('AcctNum') or ''): row['Id'] for row in accounts if row.get('AcctNum')}
    expense = expense or by_number.get(settings['expense_account']['code'])
    liability = liability or by_number.get(settings['liability_account']['code'])
    if not expense:
        expense = next((row['Id'] for row in accounts if row.get('AccountType') == 'Expense' and row.get('Active', True)), None)
    if not liability:
        liability = next((row['Id'] for row in accounts if 'Payable' in (row.get('Name') or '') and row.get('Active', True)), None)
    if not expense or not liability or expense == liability:
        raise RuntimeError('Set INTUIT_EXPENSE_ACCOUNT_ID and INTUIT_LIABILITY_ACCOUNT_ID to QuickBooks account ids')
    return str(expense), str(liability)


def posted_entry(entries: list[dict], proposal_hash: str) -> dict | None:
    return next((row for row in entries if proposal_hash in (row.get('PrivateNote') or '')), None)


def qbo_numeric_id(value) -> str | None:
    text = str(value or '').removeprefix('QBO-').strip()
    return text if re.fullmatch(r'[1-9][0-9]{0,18}', text) else None


def vendor_on_journal(entry: dict) -> str | None:
    for line in entry.get('Line') or []:
        value = (((line.get('JournalEntryLineDetail') or {}).get('Entity') or {})
                 .get('EntityRef') or {}).get('value')
        resolved = qbo_numeric_id(value)
        if resolved:
            return resolved
    return None


def resolve_qbo_vendor_id(case: dict, accounts: list[dict], liability_id: str, *,
                          entries: list[dict] | None = None, qb: QuickBooks | None = None) -> str | None:
    """A/P journal lines need a numeric QBO vendor; V-DEMO ids are not QuickBooks ids."""
    if not any(str(row['Id']) == str(liability_id) and row.get('AccountType') == 'Accounts Payable'
               for row in accounts):
        return None
    for candidate in (os.getenv('INTUIT_VENDOR_ID'), case.get('vendor_id')):
        resolved = qbo_numeric_id(candidate)
        if resolved:
            return resolved
    for entry in entries or []:
        if entry.get('DocNumber') == DEMO_BASELINE_DOC:
            resolved = vendor_on_journal(entry)
            if resolved:
                return resolved
    if qb is not None:
        for name in DEMO_VENDOR_NAMES:
            vendors = qb.query(f"select * from Vendor where DisplayName = '{name}' MAXRESULTS 5")
            if vendors:
                return str(vendors[0]['Id'])
    raise RuntimeError('Accounts Payable journal needs a numeric QuickBooks vendor id')


def import_qbo(config: DatabaseConfig, period: str, *, start: bool = False) -> dict:
    qb = QuickBooks()
    try:
        mapped = map_case(period, qb.query('select * from Bill MAXRESULTS 1000'),
                          qb.query('select * from TimeActivity MAXRESULTS 1000'))
    finally:
        qb.close()
    source = f'QuickBooks Online sandbox {mapped["vendor_name"]}'
    key_prefix = f'qbo:{mapped["entry_id"]}'
    with AfterHoursDB.connect('gateway', config) as db:
        documents = []
        for kind, (filename, media, data) in mapped['files'].items():
            upload_key = f'{key_prefix}:{kind.lower()}'
            previous = db.find_by_upload_key(upload_key)
            if previous is None:
                document = db.upload_document(data=data, original_filename=filename, media_type=media, type=kind,
                                              reference_id=mapped['entry_id'], source_label=source, upload_key=upload_key)
            else:
                latest = db.get_version_history(previous.id)[-1]
                if latest.content_hash == hashlib.sha256(data).hexdigest():
                    document = latest
                else:
                    document = db.add_document_version(latest.id, data=data, original_filename=filename,
                                                       media_type=media, source_label=source)
            documents.append(document)
            print(f'[intuit] {kind:9} doc {document.id} {filename}')
        accrual, data = db.read_document(next(doc.id for doc in documents if doc.type == 'ACCRUAL'))
        metadata = {fact['field']: fact['value'] for fact in parse_accrual(accrual.id, data.decode())}
        period_from, period_to = metadata['accrual.servicePeriod'].split('..')
        case = finalize_import(db, document_ids=[doc.id for doc in documents],
                               vendor_id=metadata['accrual.vendorId'], service_period_from=period_from,
                               service_period_to=period_to, posting_period=metadata['accrual.postingPeriod'],
                               original_status=metadata['accrual.status'],
                               original_amount_cents=metadata['accrual.amountCents'],
                               source_entry_id=metadata['accrual.entryId'],
                               idempotency_key=f'{key_prefix}:import')
        if start and case['state'] == 'IMPORTED':
            case = start_review(db, case['id'], case['input_revision'])
        jobs = ', '.join(f'{job["role"]}:{job["status"]}' for job in list_jobs(db, case['id']))
        print(f'[intuit] CASE      case {case["id"]} {case["source_entry_id"]} '
              f'{case["original_amount_cents"]} cents state {case["state"]} jobs [{jobs}]')
        return get_case(db, case['id']) or case


def post_proposal(config: DatabaseConfig, case_id: int, approve_hash: str | None) -> dict:
    with AfterHoursDB.connect('gateway', config) as db:
        case = get_case(db, case_id)
        if case is None or not case.get('current_proposal_id'):
            raise RuntimeError(f'Case {case_id} has no proposal; run agents then afterhours-calculate')
        proposal = next((row for row in db.client.query('SELECT * FROM proposals_view')
                         if row['id'] == int(case['current_proposal_id'])), None)
        if proposal is None:
            raise RuntimeError('Proposal is not visible to the gateway')
        summary = {key: proposal[key] for key in ('id', 'version', 'entry_date', 'export_amount_cents',
                                                  'adjustment_cents', 'hash', 'journal_lines')}
        print(json.dumps({'case_id': case_id, 'proposal': summary}, indent=2))
        if approve_hash is None:
            print('[intuit] Pass --approve-hash <proposal.hash> to post this journal to QuickBooks')
            return proposal
        if approve_hash != proposal['hash']:
            raise ValueError('approve-hash does not match the current proposal')
        qb = QuickBooks()
        try:
            entries = qb.query('select * from JournalEntry MAXRESULTS 1000')
            existing = posted_entry(entries, proposal['hash'])
            if existing:
                result = {'already_posted': True, 'posted': False, 'qbo_id': existing.get('Id'),
                          'doc_number': existing.get('DocNumber'), 'txn_date': existing.get('TxnDate'),
                          'hash': proposal['hash']}
                print(json.dumps(result, indent=2))
                return result
            accounts = qb.query('select * from Account MAXRESULTS 1000')
            expense, liability = qbo_accounts(accounts, db.settings())
            vendor_id = resolve_qbo_vendor_id(case, accounts, liability, entries=entries, qb=qb)
            created = qb.request('POST', 'journalentry',
                                 json=journal_entry(proposal, expense, liability, vendor_id=vendor_id))['JournalEntry']
        finally:
            qb.close()
        result = {'already_posted': False, 'posted': True, 'qbo_id': created.get('Id'),
                  'doc_number': created.get('DocNumber'), 'txn_date': created.get('TxnDate'),
                  'hash': proposal['hash']}
        print(json.dumps(result, indent=2))
        return result


def main():
    load_dotenv(Path.cwd() / '.env')
    parser = argparse.ArgumentParser(description='Import a QuickBooks sandbox period into AfterHours')
    parser.add_argument('--period', default=os.getenv('INTUIT_PERIOD', '2026-09'))
    parser.add_argument('--start-review', action='store_true')
    args = parser.parse_args()
    import_qbo(DatabaseConfig.from_env(), args.period, start=args.start_review)


if __name__ == '__main__':
    main()
