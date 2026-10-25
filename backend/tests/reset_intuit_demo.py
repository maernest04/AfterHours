"""Back up and remove ONE completed $7,000 Intuit demo review; dry-run by default.

Delete its $700 adjustment in QuickBooks first. This script never changes QuickBooks.
Original documents and file bytes remain stored; re-upload creates a fresh review.
"""
import argparse
from datetime import datetime, timezone
import json
from decimal import Decimal
from pathlib import Path
import re

from dotenv import load_dotenv
from afterhours_db import AfterHoursDB
from afterhours_db.cases import get_case
from afterhours_db.client import SpacetimeClient
from afterhours_db.config import DatabaseConfig
from afterhours_db.identity import owner_token
from afterhours_db.intuit import QuickBooks

ROOT = Path(__file__).resolve().parents[2]
TABLES = ('allocations', 'job_results', 'proposals', 'jobs', 'work_items',
          'invoice_lines', 'ledger_records', 'facts', 'case_documents')


def validate_case(case):
    if (not case or not re.fullmatch(r'QBO-JE-\d+-DEMO-7000', case['source_entry_id'])
            or not re.fullmatch(r'QBO-\d+', case['vendor_id'])
            or case['original_status'] != 'POSTED' or case['original_amount_cents'] != '700000'
            or case['posting_period'] != '2026-09'
            or case['service_period_from'] != '2026-09-01' or case['service_period_to'] != '2026-09-30'):
        raise ValueError('Refusing to reset anything except the labelled $7,000 Intuit demo review.')
    if case['state'] in {'IMPORTED', 'EXTRACTING', 'MATCHING', 'INVESTIGATING'}:
        raise ValueError('Pipeline is still active. Wait for the review to finish before resetting.')


def validate_synthetic(case):
    if (not case or not re.fullmatch(r'V-DEMO-[0-9a-f-]{36}', case['vendor_id'])
            or case['source_entry_id'] != 'ACR-DEMO-' + case['vendor_id'].removeprefix('V-DEMO-')
            or case['original_amount_cents'] != '700000' or case['original_status'] != 'POSTED'
            or case['posting_period'] != '2026-11' or case['service_period_from'] != '2026-11-01'
            or case['service_period_to'] != '2026-11-30'):
        raise ValueError('Not an isolated synthetic built-in demo case.')
    if case['state'] in {'IMPORTED', 'EXTRACTING', 'MATCHING', 'INVESTIGATING'}:
        raise ValueError('Pipeline is still active. Wait before resetting.')


def verify_quickbooks(case, proposals):
    qb = QuickBooks()
    try:
        vendor_id = case['vendor_id'].removeprefix('QBO-')
        vendor = qb.request('GET', f'vendor/{vendor_id}')['Vendor']
        hashes = {p['hash'] for p in proposals}
        posted = [j for j in qb.query('select * from JournalEntry MAXRESULTS 1000')
                  if j.get('PrivateNote') in {f'AfterHours {h}' for h in hashes}]
        if posted:
            ids = ', '.join(str(j['Id']) for j in posted)
            raise ValueError(f'Delete the $700 correction in QuickBooks first (journal ID {ids}). Keep AH-DEMO-7000.')
        if Decimal(str(vendor.get('Balance', 0))) != 7000:
            raise ValueError('Demo vendor balance must be $7,000 before clearing its database review.')
        baseline_id = case['source_entry_id'].split('-')[2]
        baseline = qb.request('GET', f'journalentry/{baseline_id}')['JournalEntry']
        lines = [line for line in baseline.get('Line', []) if line.get('DetailType') == 'JournalEntryLineDetail']
        if (baseline.get('DocNumber') != 'AH-DEMO-7000' or baseline.get('TxnDate') != '2026-10-31'
                or not baseline.get('PrivateNote', '').startswith('AfterHours synthetic demonstration: original $7,000 accrual.')
                or len(lines) != 2 or any(Decimal(str(line['Amount'])) != 7000 for line in lines)
                or {line['JournalEntryLineDetail']['PostingType'] for line in lines} != {'Debit', 'Credit'}
                or not any(line['JournalEntryLineDetail']['PostingType'] == 'Credit' and
                           line['JournalEntryLineDetail'].get('Entity', {}).get('EntityRef', {}).get('value') == vendor_id
                           for line in lines)):
            raise ValueError('The original $7,000 sandbox baseline is missing or has changed.')
    finally:
        qb.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case-id', required=True, type=int)
    parser.add_argument('--apply', action='store_true', help='Back up and delete the selected demo review')
    parser.add_argument('--synthetic-demo', action='store_true', help='Clear an isolated built-in demo instead of the Intuit rehearsal')
    args = parser.parse_args()
    load_dotenv(ROOT / '.env')
    config = DatabaseConfig.from_env()
    with AfterHoursDB.connect('gateway', config) as db:
        case = get_case(db, args.case_id)
        (validate_synthetic if args.synthetic_demo else validate_case)(case)
        rows = {table: [row for row in db.client.query(f'SELECT * FROM {table}_view')
                        if row['case_id'] == args.case_id] for table in TABLES}
        if any(j['status'] in {'RUNNING', 'QUEUED'} for j in rows['jobs']):
            raise ValueError('Review has active jobs; wait for the pipeline to stop.')
        linked = {row['document_id'] for row in rows['case_documents']}
        documents = [row for row in db.client.query('SELECT * FROM documents_view') if row['id'] in linked]
        if not args.synthetic_demo:
            verify_quickbooks(case, rows['proposals'])
        print(json.dumps({'database': config.database, 'server': config.uri, 'case_id': args.case_id,
                          'rows_to_remove': {**{table: len(values) for table, values in rows.items()}, 'cases': 1},
                          'quickbooks_balance': None if args.synthetic_demo else 7000, 'original_documents_retained': len(documents),
                          'dry_run': not args.apply}, indent=2))
        if not args.apply:
            print('No changes made. Add --apply to back up and remove this review.')
            return
        directory = ROOT / 'data/demo-backups'
        directory.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        backup = directory / f'case-{args.case_id}-{stamp}.json'
        backup.write_text(json.dumps({'database': config.database, 'server': config.uri,
                                     'case': case, 'rows': rows, 'documents': documents}, indent=2), encoding='utf-8')
        # Export the original upload bytes, so the same package can be uploaded again.
        upload = ROOT / 'data/intuit-demo-upload'
        if not args.synthetic_demo:
            upload.mkdir(parents=True, exist_ok=True)
            for document_id in linked:
                document, data = db.read_document(document_id)
                filename = Path(document.original_filename).name
                (upload / filename).write_bytes(data)
        proposal = next((p for p in rows['proposals'] if p['id'] == case['current_proposal_id']), None)
        with SpacetimeClient(config.uri, config.database, token=owner_token()) as owner:
            owner.call_reducer('reset_intuit_demo_case', [args.case_id, case['source_entry_id'], case['vendor_id'],
                                                         case['input_revision'], proposal['hash'] if proposal else ''])
        if get_case(db, args.case_id) is not None:
            raise RuntimeError('Review is still present after reset; inspect the database before retrying.')
        for table in TABLES:
            if any(row['case_id'] == args.case_id for row in db.client.query(f'SELECT * FROM {table}_view')):
                raise RuntimeError(f'Reset left linked rows in {table}.')
        print(f'Reset complete. Backup: {backup}')
        if not args.synthetic_demo:
            print(f'Upload the six files from {upload} at http://localhost:5173/ to run the full pipeline again.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError) as error:
        raise SystemExit(str(error)) from None
