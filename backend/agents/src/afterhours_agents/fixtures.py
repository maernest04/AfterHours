"""Synthetic matching fixtures. Extraction is explicitly REPLAYED, never LIVE."""
import argparse
import json
from pathlib import Path
import re

from dotenv import load_dotenv
from afterhours_db import AfterHoursDB
from afterhours_db.cases import finalize_import, list_jobs, start_review
from afterhours_db.jobs import claim_job, complete_job
from afterhours_db.mailbox import store_email

SCENARIOS = ('clean', 'amendment', 'missing_amendment', 'ambiguous_invoice',
             'no_invoice', 'conflicting_contract')


def seed_matching_cases(namespace: str = 'matching-demo-v1') -> dict[str, int]:
    """Idempotently import six cases and prepare just their matching jobs.

    Use a new namespace for another E2E run. Existing cases are never reset.
    This is development setup, not a substitute for the extraction agent.
    """
    if not re.fullmatch(r'[a-z0-9-]{1,32}', namespace):
        raise ValueError('namespace must be 1–32 lowercase letters, digits or hyphens')
    cases = {}
    with AfterHoursDB.connect('gateway') as gateway, AfterHoursDB.connect('worker') as worker:
        for name in SCENARIOS:
            ref = f'{namespace}:{name}'
            vendor = f'V-{ref}'
            source = f'ACR-{ref}'
            docs = {}

            def upload(label, kind, body, media='text/plain'):
                doc = gateway.upload_document(data=body.encode(), original_filename=label,
                    media_type=media, type=kind, source_label='Matching fixture (SYNTHETIC)',
                    reference_id=ref, upload_key=f'{ref}:{label}')
                docs[label] = doc.id
                return doc.id

            contract_text = (f'SYNTHETIC AGREEMENT for vendor {vendor}.\n'
                'Covers all approved services by Alex Rivera. Rate $100.00/hour.\n'
                'Effective 2026-01-01 through 2026-12-31. Signed by Controller Dana Whitfield.\n')
            contract = upload('contract.txt', 'CONTRACT', contract_text)
            higher = name in {'amendment', 'missing_amendment'}
            upload('timesheet.csv', 'TIMESHEET',
                'service_date,contractor,approved_minutes,billing_rate,status,approved_by\n'
                '2026-09-10,Alex Rivera,420,100.00,APPROVED,Project Manager\n'
                f'2026-09-20,Alex Rivera,480,{"110.00" if higher else "100.00"},APPROVED,Project Manager\n'
                '2026-09-21,Alex Rivera,60,100.00,PENDING,\n', 'text/csv')
            invoices = ('invoice_number,contractor,service_start,service_end,minutes,amount,posting_status,posted_date\n'
                f'INV-OTHER-{ref},Other Person,2026-09-10,2026-09-20,900,1500.00,POSTED,2026-09-25\n'
                f'INV-AUG-{ref},Alex Rivera,2026-08-01,2026-08-31,900,1500.00,POSTED,2026-09-01\n')
            if name != 'no_invoice':
                invoices += (f'INV-A-{ref},Alex Rivera,2026-09-10,2026-09-10,420,700.00,POSTED,2026-09-12\n'
                    f'INV-B-{ref},Alex Rivera,2026-09-20,2026-09-20,480,{"880.00" if higher else "800.00"},UNPOSTED,\n')
            if name == 'ambiguous_invoice':
                invoices += f'INV-DUP-{ref},Alex Rivera,2026-09-20,2026-09-20,480,800.00,UNPOSTED,\n'
            upload('invoices.csv', 'INVOICE', invoices, 'text/csv')
            upload('ledger.csv', 'LEDGER',
                'entry_id,vendor_id,period,kind,amount,status,description\n'
                f'{source},{vendor},2026-09,ACCRUAL,1500.00,POSTED,Original accrual\n'
                f'OTHER-{ref},V-UNRELATED,2026-09,ACCRUAL,1500.00,POSTED,Other vendor\n'
                f'PRIOR-{ref},{vendor},2026-08,ACCRUAL,1500.00,POSTED,Prior period\n', 'text/csv')
            upload('accrual.json', 'ACCRUAL', json.dumps({'entryId': source, 'vendorId': vendor,
                'status': 'POSTED', 'amountCents': '150000', 'postingPeriod': '2026-09'}), 'application/json')
            imported = list(docs.values())
            amendment_text = (f'SYNTHETIC AMENDMENT for vendor {vendor}.\n'
                'Replaces the $100.00/hour rate with $110.00/hour for Alex Rivera from 2026-09-15.\n'
                'Signed 2026-09-14 by Controller Dana Whitfield. All other terms unchanged.\n')
            if higher:
                amendment = upload('amendment.txt', 'AMENDMENT', amendment_text)
                if name == 'amendment':
                    imported.append(amendment)
                else:
                    store_email(gateway, message_key=f'{ref}:amendment-mail', vendor_id=vendor,
                        thread_id=f'{ref}:amendment', sender='contracts@synthetic.example',
                        recipients=['ap@synthetic.example'], subject='Signed September amendment',
                        sent_at='2026-09-14T12:00:00Z', body='Signed amendment attached for investigation.',
                        attachment_document_ids=[amendment])
            if name == 'conflicting_contract':
                imported.append(upload('conflicting-contract.txt', 'CONTRACT',
                    f'SYNTHETIC AGREEMENT for vendor {vendor}.\n'
                    'Covers all approved services by Alex Rivera at $130/hour for all of 2026.\n'
                    'Signed by Dana Whitfield. No supersession relationship is stated.\n'))
            case = finalize_import(gateway, document_ids=imported, vendor_id=vendor,
                service_period_from='2026-09-01', service_period_to='2026-09-30', posting_period='2026-09',
                original_status='POSTED', original_amount_cents='150000', source_entry_id=source,
                idempotency_key=ref)
            cases[name] = case['id']
            start_review(gateway, case['id'], case['input_revision'])
            extraction = next(j for j in list_jobs(worker, case['id']) if j['role'] == 'EXTRACTION')
            if extraction['status'] == 'SUCCEEDED':
                continue
            lease = claim_job(worker, extraction['id'], case['id'], case['input_revision'])
            facts = []
            for doc_id, rate, effective, text in [(contract, '10000', '2026-01-01', contract_text)] + (
                [(docs['amendment.txt'], '11000', '2026-09-15', amendment_text)] if name == 'amendment' else []):
                for field, value in [('rate.hourlyCents', rate), ('rate.effectiveFrom', effective),
                                     ('rate.approvedBy', 'Dana Whitfield')]:
                    facts.append({'documentId': str(doc_id), 'pageOrRow': 'lines 1–4',
                        'excerpt': text, 'field': field, 'value': value})
            evidence = [f'doc:{contract}']
            complete_job(worker, lease, 'REPLAYED', {'proposedFacts': facts, 'proposedMatches': [],
                'evidenceIds': evidence, 'unresolvedQuestions': [], 'explanation': {
                    'summary': 'Synthetic extraction fixture; matching is the stage under test.',
                    'evidenceIds': evidence}})
    return cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--namespace', default='matching-demo-v1')
    args = parser.parse_args()
    load_dotenv(Path.cwd() / '.env')
    print(json.dumps(seed_matching_cases(args.namespace), indent=2))


if __name__ == '__main__':
    main()
