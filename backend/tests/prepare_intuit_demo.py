"""Prepare a clearly labelled $7,000 sandbox baseline; leave its $700 correction unposted."""
import argparse
import json
from pathlib import Path

import httpx
from dotenv import load_dotenv
from afterhours_db import AfterHoursDB
from afterhours_db.cases import list_cases
from afterhours_db.intuit import QuickBooks, csv_text, qbo_accounts

ROOT = Path(__file__).resolve().parents[2]
VENDOR = 'AfterHours Demo Contractor - 7000 to 7700'
BASELINE = 'AH-DEMO-7000'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--create-sandbox-baseline', action='store_true')
    args = parser.parse_args()
    if not args.create_sandbox_baseline:
        parser.error('This writes one demo vendor and one $7,000 baseline journal. Supply --create-sandbox-baseline.')
    load_dotenv(ROOT / '.env')
    qb = QuickBooks()
    try:
        accounts = qb.query('select * from Account MAXRESULTS 1000')
        with AfterHoursDB.connect('gateway') as db:
            expense, liability = qbo_accounts(accounts, db.settings())
        vendors = qb.query(f"select * from Vendor where DisplayName = '{VENDOR}' MAXRESULTS 1000")
        if len(vendors) > 1:
            raise RuntimeError('Multiple demo vendors; inspect before proceeding.')
        vendor = vendors[0] if vendors else qb.request('POST', 'vendor', json={'DisplayName': VENDOR})['Vendor']
        vendor_id = str(vendor['Id'])
        entries = qb.query('select * from JournalEntry MAXRESULTS 1000')
        baselines = [entry for entry in entries if entry.get('DocNumber') == BASELINE]
        if len(baselines) > 1:
            raise RuntimeError('Multiple demo baselines; inspect before proceeding.')
        if baselines:
            baseline = baselines[0]
            lines = [line for line in baseline.get('Line', []) if line.get('DetailType') == 'JournalEntryLineDetail']
            if len(lines) != 2 or any(float(line['Amount']) != 7000 for line in lines):
                raise RuntimeError('Existing demo baseline does not match $7,000. No journal changed.')
        else:
            baseline = qb.request('POST', 'journalentry', params={'requestid': 'afterhours-demo-baseline-7000-v1'}, json={
                'TxnDate': '2026-10-31', 'DocNumber': BASELINE,
                'PrivateNote': 'AfterHours synthetic demonstration: original $7,000 accrual. Correction requires separate human approval.',
                'Line': [
                    {'Amount': 7000, 'Description': 'AfterHours demo original accrual', 'DetailType': 'JournalEntryLineDetail',
                     'JournalEntryLineDetail': {'PostingType': 'Debit', 'AccountRef': {'value': expense}}},
                    {'Amount': 7000, 'Description': 'AfterHours demo original accrual', 'DetailType': 'JournalEntryLineDetail',
                     'JournalEntryLineDetail': {'PostingType': 'Credit', 'AccountRef': {'value': liability},
                        'Entity': {'Type': 'Vendor', 'EntityRef': {'value': vendor_id}}}},
                ]})['JournalEntry']
        refreshed = qb.request('GET', f'vendor/{vendor_id}')['Vendor']
        print(json.dumps({'sandbox_vendor': VENDOR, 'vendor_id': vendor_id, 'baseline_journal_id': baseline['Id'],
                          'baseline_amount': 7000, 'vendor_balance': refreshed.get('Balance')}), flush=True)
        source_id = f'QBO-JE-{baseline["Id"]}-DEMO-7000'
        with AfterHoursDB.connect('gateway') as db:
            existing = next((case for case in list_cases(db) if case['source_entry_id'] == source_id), None)
        if existing:
            print(json.dumps({'review_id': existing['id'], 'status': existing['state'], 'reused': True}), flush=True)
            return
        seed = ROOT / 'backend/db/src/afterhours_db/seed_data'
        vendor_ref = f'QBO-{vendor_id}'
        accrual = {'_note': 'SYNTHETIC DEMO linked to an actual QuickBooks sandbox baseline journal.',
                   'entryId': source_id, 'vendorId': vendor_ref, 'vendorName': VENDOR,
                   'servicePeriod': {'from': '2026-09-01', 'to': '2026-09-30'}, 'postingPeriod': '2026-09',
                   'status': 'POSTED', 'amountCents': '700000', 'currency': 'USD'}
        contract = (seed / 'acme_msa.txt').read_text().replace('Acme Contracting (SYNTHETIC)', VENDOR)
        amendment = (seed / 'acme_amendment_1.txt').read_text().replace('Acme Contracting (SYNTHETIC)', VENDOR)
        ledger = csv_text(['entry_id', 'vendor_id', 'period', 'kind', 'amount', 'status', 'description'],
                          [[source_id, vendor_ref, '2026-09', 'ACCRUAL', '7000.00', 'POSTED', f'Sandbox journal {baseline["Id"]} original accrual']])
        files = [
            ('files', ('demo_accrual.json', json.dumps(accrual).encode(), 'application/json')),
            ('files', ('demo_msa.txt', contract.encode(), 'text/plain')),
            ('files', ('demo_timesheet_v2.csv', (seed / 'acme_timesheet_2026-09_v2.csv').read_bytes(), 'text/csv')),
            ('files', ('demo_invoices.csv', b'invoice_number,contractor,service_start,service_end,minutes,amount,posting_status,posted_date\n', 'text/csv')),
            ('files', ('demo_ledger.csv', ledger.encode(), 'text/csv')),
            ('files', ('demo_amendment.txt', amendment.encode(), 'text/plain')),
        ]
        response = httpx.post('http://localhost:8000/create-review', files=files, timeout=60)
        response.raise_for_status()
        print(json.dumps(response.json()), flush=True)
    finally:
        qb.close()


if __name__ == '__main__':
    main()
