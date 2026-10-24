"""Opt-in HTTP + real database + ready-worker flow; no paid model requests.

Run from the repo root with AFTERHOURS_FLOW_TESTS=1 and AFTERHOURS_API_URL set.
All three merged worker implementations run with explicit provider replay fixtures.
Requires idle shared database workers; an independent live watcher could claim test work.
"""
from contextlib import asynccontextmanager
import asyncio
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx


ROOT = Path(__file__).resolve().parents[2]
SEED = ROOT / 'backend/db/src/afterhours_db/seed_data'


@asynccontextmanager
async def extraction_replay():
    text = (SEED / 'acme_msa.txt').read_text()

    def fact(field, value, contains):
        number, excerpt = next((i, line) for i, line in enumerate(text.splitlines(), 1) if contains in line)
        return {'pageOrRow': f'line {number}', 'excerpt': excerpt, 'field': field, 'value': value}

    async def decide(prompt, schema):
        return {'facts': [fact('rate.hourlyCents', '10000', 'Hourly rate:'),
                          fact('rate.effectiveFrom', '2026-01-01', 'effective'),
                          fact('rate.approvedBy', 'Dana Whitfield', 'Authorized signatory:'),
                          fact('rate.signedDate', '2025-12-15', 'Signed:')],
                'unresolvedQuestions': []}

    yield decide


class MatchingReplay:
    model_run = 'REPLAYED'

    def generate(self, context, schema, *, cancel):
        contract = next(d['documentId'] for d in context['documents'] if d['type'] == 'CONTRACT')
        ledger = next(row for row in context['ledgerRecords']
                      if row['entryId'] == context['case']['sourceEntryId'])
        matches = []
        for work in context['workItems']:
            evidence = [f'doc:{contract}', f'fact:{work["factId"]}', f'fact:{ledger["factId"]}']
            matches.append({'workItemId': work['id'], 'contractId': contract,
                            'invoiceLineIds': [], 'ledgerEntryIds': [ledger['id']],
                            'evidenceIds': evidence})
        cited = sorted({ref for match in matches for ref in match['evidenceIds']})
        return {'proposedFacts': [], 'proposedMatches': matches, 'evidenceIds': cited,
                'unresolvedQuestions': ['Which signed amendment supports the September rate?'],
                'explanation': {'summary': 'Synthetic replay: work needs a signed rate amendment.',
                                'evidenceIds': cited}}


def investigation_replay(contract_id, amendment_id, thread_id):
    text = (SEED / 'acme_amendment_1.txt').read_text()

    def fact(field, value, contains):
        number, excerpt = next((i, line) for i, line in enumerate(text.splitlines(), 1) if contains in line)
        return {'documentId': str(amendment_id), 'pageOrRow': f'line {number}',
                'excerpt': excerpt, 'field': field, 'value': value}

    cited = [f'doc:{amendment_id}']
    output = {'proposedFacts': [
        fact('rate.hourlyCents', '11000', 'hourly rate'),
        fact('rate.effectiveFrom', '2026-09-01', 'effective'),
        fact('rate.approvedBy', 'Dana Whitfield', 'signed:'),
        fact('rate.signedDate', '2026-08-28', 'signed:'),
    ], 'proposedMatches': [], 'evidenceIds': cited, 'unresolvedQuestions': [],
        'explanation': {'summary': 'Synthetic replay: signed amendment resolves the rate.', 'evidenceIds': cited}}

    @asynccontextmanager
    async def session():
        actions = iter([
            {'tool': 'readAttachment', 'arguments': {'documentId': str(contract_id)}},
            {'tool': 'searchEmails', 'arguments': {'query': 'amendment'}},
            {'tool': 'readEmailThread', 'arguments': {'threadId': thread_id}},
            {'tool': 'readAttachment', 'arguments': {'documentId': str(amendment_id)}},
            {'tool': 'finish', 'output': output},
        ])

        async def decide(prompt, schema):
            return next(actions)

        yield decide

    return session


@unittest.skipUnless(os.getenv('AFTERHOURS_FLOW_TESTS') == '1', 'Opt-in real HTTP/database flow')
class ReviewFlowTests(unittest.TestCase):
    @unittest.skipUnless(os.getenv('AFTERHOURS_DROID_TESTS') == '1', 'Docker Droid startup check')
    def test_investigation_provider_starts_without_inference(self):
        from afterhours_orchestrator.pipeline import live_investigation_session

        async def start():
            async with live_investigation_session() as decide:
                self.assertTrue(callable(decide))
                # Opening the SDK and disabling tools is tested; never send a prompt.

        with patch.dict(os.environ, FACTORY_API_KEY='fake-no-inference', FACTORY_MODEL_ID='gpt-6-luna-fast'):
            asyncio.run(start())

    def test_upload_queue_matching_investigation_and_detail_stream(self):
        base = os.getenv('AFTERHOURS_API_URL', 'http://127.0.0.1:8001')
        unique = 'FLOW-' + uuid4().hex[:12]
        vendor = 'V-' + unique
        accrual = json.loads((SEED / 'acme_accrual_2026-09.json').read_text())
        accrual.update(entryId=unique, vendorId=vendor)
        ledger = (SEED / 'ledger_2026-09.csv').read_text().replace('ACR-2026-09-ACME', unique).replace('V-ACME', vendor)
        uploads = [
            ('files', ('accrual.json', json.dumps(accrual).encode(), 'application/json')),
            ('files', ('contract.txt', (SEED / 'acme_msa.txt').read_bytes(), 'text/plain')),
            ('files', ('timesheet.csv', (SEED / 'acme_timesheet_2026-09_v2.csv').read_bytes(), 'text/csv')),
            ('files', ('invoices.csv', (SEED / 'acme_invoices_2026-08.csv').read_bytes(), 'text/csv')),
            ('files', ('ledger.csv', ledger.encode(), 'text/csv')),
        ]
        with httpx.Client(base_url=base, timeout=30) as client:
            response = client.post('/create-review', files=uploads)
            self.assertEqual(response.status_code, 202, response.text)
            accepted = response.json()
            self.assertEqual(accepted['status'], 'IMPORTED')
            self.assertTrue(accepted['idempotency_key'])
            self.assertEqual(client.post('/create-review', files=uploads).status_code, 409)
            case_id = int(accepted['review_id'])
            params = {'review_id': str(case_id)}
            initial = client.get('/get-review', params=params)
            self.assertEqual(initial.status_code, 200, initial.text)
            initial = initial.json()
            self.assertEqual(initial['original_amount_cents'], '700000')
            self.assertIsNone(initial['corrected_target_cents'])
            self.assertIsNone(initial['proposal_id'])

            from afterhours_db import AfterHoursDB
            from afterhours_db.cases import get_case, is_awaiting_proposal, list_jobs
            from afterhours_db.mailbox import store_email
            from afterhours_db.tools import AgentTools
            from afterhours_orchestrator.pipeline import run_cycle

            with AfterHoursDB.connect('gateway') as gateway, AfterHoursDB.connect('worker') as worker:
                self.assertEqual(get_case(gateway, case_id)['idempotency_key'], accepted['idempotency_key'])
                with client.stream('GET', '/get-review', params={**params, 'live': 'true'}) as live:
                    self.assertEqual(live.status_code, 200)
                    events = (json.loads(line[6:]) for line in live.iter_lines() if line.startswith('data: '))
                    self.assertEqual(next(events)['status'], 'IMPORTED')
                    report = run_cycle(gateway, worker, case_id=case_id)
                    self.assertEqual(next(events)['status'], 'EXTRACTING')
                self.assertFalse(report.errors, report.errors)
                jobs = list_jobs(worker, case_id)
                self.assertEqual([(j['role'], j['status']) for j in jobs], [('EXTRACTION', 'QUEUED')])
                # A cycle without an extraction provider leaves its job queued.
                queued = client.get('/get-review', params=params).json()
                self.assertEqual(queued['status'], 'EXTRACTING')
                self.assertNotEqual(queued['sequence'], initial['sequence'])
                evidence = AgentTools(worker, case_id).get_case_evidence()
                contract = next(d['documentId'] for d in evidence['documents'] if d['type'] == 'CONTRACT')
                amendment = gateway.upload_document(data=(SEED / 'acme_amendment_1.txt').read_bytes(),
                    original_filename='amendment.txt', media_type='text/plain', type='AMENDMENT',
                    source_label='HTTP pipeline test (SYNTHETIC)')
                store_email(gateway, message_key=unique, vendor_id=vendor, thread_id=unique,
                    sender='contracts@synthetic.example', recipients=['ap@synthetic.example'],
                    subject='Signed amendment (MOCK)', sent_at='2026-08-28T17:05:00Z',
                    body='Synthetic mailbox: signed amendment attached.', attachment_document_ids=[amendment.id])
                report = run_cycle(gateway, worker, case_id=case_id, max_jobs=3,
                    extraction_session=extraction_replay, extraction_model_run='REPLAYED',
                    matching_provider_factory=MatchingReplay,
                    investigation_session=investigation_replay(contract, amendment.id, unique),
                    investigation_model_run='REPLAYED')
                self.assertFalse(report.errors, report.errors)
                jobs = list_jobs(worker, case_id)
                self.assertEqual([(j['role'], j['status']) for j in jobs], [
                    ('EXTRACTION', 'SUCCEEDED'), ('MATCHING', 'SUCCEEDED'), ('INVESTIGATION', 'SUCCEEDED')])
                self.assertFalse(is_awaiting_proposal(gateway, case_id))
                self.assertEqual(len(report.completed_proposals), 1)
                evidence = AgentTools(worker, case_id).get_case_evidence()
                self.assertEqual(len(evidence['jobResults']), 3)
                self.assertTrue(all(row['modelRun'] == 'REPLAYED' for row in evidence['jobResults']))
                self.assertTrue(any(f['field'] == 'rate.hourlyCents' and f['value'] == '11000'
                                    for f in evidence['facts']))

            detail = client.get('/get-review', params=params)
            self.assertEqual(detail.status_code, 200, detail.text)
            snapshot = detail.json()
            self.assertEqual(snapshot['status'], 'READY_FOR_REVIEW')
            self.assertNotEqual(snapshot['sequence'], queued['sequence'])
            self.assertIsNotNone(snapshot['proposal_id'])
            self.assertEqual(snapshot['corrected_target_cents'], '770000')
            self.assertEqual(snapshot['difference_cents'], '70000')
            self.assertEqual(snapshot['history'], [])  # Mock evidence is not an approval.
            self.assertTrue(snapshot['evidence'])
            self.assertEqual(client.get('/export-review', params=params).status_code, 501)
            with client.stream('GET', '/get-review', params={**params, 'live': 'true',
                                                           'after_sequence': initial['sequence']}) as stream:
                self.assertEqual(stream.status_code, 200)
                data = next(line[6:] for line in stream.iter_lines() if line.startswith('data: '))
                self.assertEqual(json.loads(data)['review_id'], str(case_id))
            page = client.get('/list-review').json()
            self.assertLessEqual(len(page['items']), 10)
            if page['next_cursor']:
                self.assertEqual(len(page['items']), 10)
                following = client.get('/list-review', params={'cursor': page['next_cursor']}).json()
                self.assertFalse({row['review_id'] for row in page['items']} &
                                 {row['review_id'] for row in following['items']})
            missing = client.get('/get-review', params={'review_id': '18446744073709551615'})
            self.assertEqual(missing.status_code, 404)
            print(f'HTTP pipeline flow verified for synthetic case {case_id}; all models REPLAYED.')


if __name__ == '__main__':
    unittest.main()
