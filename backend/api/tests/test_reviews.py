"""Exercise real API, parsers, file store and SDK with an in-memory reducer boundary."""
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest

import httpx
from afterhours_db import AfterHoursDB, DatabaseConfig

from backend.api.main import app
from backend.api.repository import SDKReviewRepository
from backend.api.service import ReviewService, ReviewUpload, get_review_service


SEED = Path(__file__).resolve().parents[2] / 'db/src/afterhours_db/seed_data'


def uploads():
    names = [('acme_accrual_2026-09.json', 'application/json'),
             ('acme_msa.txt', 'text/plain'), ('acme_timesheet_2026-09_v2.csv', 'text/csv'),
             ('acme_invoices_2026-08.csv', 'text/csv'), ('ledger_2026-09.csv', 'text/csv')]
    return [ReviewUpload(name, mime, len(data), io.BytesIO(data))
            for name, mime in names for data in [(SEED / name).read_bytes()]]


class MemoryClient:
    """Persist reducer arguments, leaving application classification/parsing to real SDK."""
    def __init__(self):
        self.tables = {name: [] for name in ('documents', 'cases', 'facts', 'proposals', 'emails')}
        self.closed = 0

    def close(self):
        self.closed += 1

    def query(self, sql):
        source, _, where = sql.removeprefix('SELECT * FROM ').partition(' WHERE ')
        table = source.removesuffix('_view')
        if table == 'settings':
            return [{'currency': 'USD'}]
        rows = self.tables[table]
        if where.startswith('id = '):
            rows = [row for row in rows if row['id'] == int(where.removeprefix('id = '))]
        elif where.startswith("upload_key = '") and where.endswith("'"):
            key = where[len("upload_key = '"):-1].replace("''", "'")
            rows = [row for row in rows if row['upload_key'] == key]
        elif where:
            raise AssertionError(f'Unsupported test query: {sql}')
        return copy.deepcopy(rows)

    def call_reducer(self, name, args):
        if name == 'store_document':
            fields = ['company_id', 'upload_key', 'storage_key', 'content_hash', 'byte_length',
                      'media_type', 'original_filename', 'type', 'reference_id', 'source_label']
            row = dict(zip(fields, args))
            row['reference_id'] = row['reference_id'].get('some')
            row.update(id=len(self.tables['documents']) + 1, version=1,
                       supersedes_document_id=None, created_at=1)
            self.tables['documents'].append(row)
        elif name == 'finalize_import':
            fields = ['company_id', 'idempotency_key', 'vendor_id', 'service_period_from',
                      'service_period_to', 'posting_period', 'original_status',
                      'original_amount_cents', 'source_entry_id']
            row = dict(zip(fields, args))
            row.update(id=1, input_revision=1, state='IMPORTED', current_proposal_id=None,
                       blockers=[], created_at=1, updated_at=1)
            self.tables['cases'].append(row)
            for fact in args[13]:
                self.tables['facts'].append(dict(id=len(self.tables['facts']) + 1,
                    case_id=1, input_revision=1, document_id=fact[0], page_or_row=fact[1],
                    excerpt=fact[2], field=fact[3], value=fact[4]))
        elif name == 'store_email':
            fields = ['company_id', 'message_key', 'vendor_id', 'thread_id', 'sender',
                      'recipients', 'subject', 'sent_at', 'body', 'attachment_document_ids']
            row = dict(zip(fields, args))
            row.update(id=len(self.tables['emails']) + 1)
            self.tables['emails'].append(row)
        else:
            raise AssertionError(f'Unexpected reducer: {name}')


class ReviewTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.db_client = MemoryClient()
        self.db = AfterHoursDB(self.db_client, DatabaseConfig(file_store_dir=Path(self.directory.name)))
        self.service = ReviewService(SDKReviewRepository(lambda: self.db))
        app.dependency_overrides[get_review_service] = lambda: self.service
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test')

    async def asyncTearDown(self):
        app.dependency_overrides.pop(get_review_service, None)
        await self.client.aclose()
        self.directory.cleanup()

    async def create(self, files=None, **kwargs):
        return await self.client.post('/create-review', files=[
            ('files', (file.filename, file.stream.read(), file.media_type))
            for file in (uploads() if files is None else files)], **kwargs)

    async def test_create_persists_original_bytes_metadata_and_generated_key(self):
        response = await self.create()
        self.assertEqual(response.status_code, 202, response.text)
        body = response.json()
        self.assertEqual(body['status'], 'IMPORTED')
        self.assertEqual(body['review_id'], '1')
        case = self.db_client.tables['cases'][0]
        self.assertEqual(body['idempotency_key'], case['idempotency_key'])
        self.assertTrue(body['idempotency_key'])
        self.assertEqual((case['vendor_id'], case['original_amount_cents'], case['source_entry_id']),
                         ('V-ACME', '700000', 'ACR-2026-09-ACME'))
        self.assertEqual([row['type'] for row in self.db_client.tables['documents']],
                         ['ACCRUAL', 'CONTRACT', 'TIMESHEET', 'INVOICE', 'LEDGER'])
        self.assertEqual(self.db.read_document(1)[1], (SEED / 'acme_accrual_2026-09.json').read_bytes())
        self.assertEqual(self.db_client.tables['emails'], [])

    async def test_create_puts_uploaded_amendment_in_that_vendor_mailbox(self):
        data = (SEED / 'acme_amendment_1.txt').read_bytes()
        response = await self.create(uploads() + [ReviewUpload(
            'acme_amendment_1.txt', 'text/plain', len(data), io.BytesIO(data))])
        self.assertEqual(response.status_code, 202, response.text)
        emails = self.db_client.tables['emails']
        self.assertEqual(len(emails), 1)
        self.assertEqual(emails[0]['vendor_id'], 'V-ACME')
        self.assertEqual(emails[0]['attachment_document_ids'], [6])
        self.assertIn('Amendment No. 1', emails[0]['subject'])

    async def test_source_returns_original_bytes_and_rejects_unrelated_facts(self):
        await self.create()
        fact = self.db_client.tables['facts'][0]
        response = await self.client.get('/review-source', params={'review_id': '1', 'evidence_id': f"fact:{fact['id']}"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, self.db.read_document(fact['document_id'])[1])
        self.assertIn('inline', response.headers['content-disposition'])
        self.assertEqual(response.headers['x-content-type-options'], 'nosniff')
        for review, evidence in [('2', f"fact:{fact['id']}"), ('1', 'fact:999'), ('1', 'doc:1')]:
            denied = await self.client.get('/review-source', params={'review_id': review, 'evidence_id': evidence})
            self.assertIn(denied.status_code, (404, 422))

    async def test_invalid_later_file_is_rejected_before_any_write(self):
        files = uploads() + [ReviewUpload('unknown.csv', 'text/csv', 10, io.BytesIO(b'amount\n12\n'))]
        response = await self.create(files)
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.db_client.tables['documents'], [])
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    async def test_create_rejects_client_metadata_and_duplicate_source(self):
        response = await self.create(data={'status': 'APPROVED', 'idempotency_key': 'client-key'})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.db_client.tables['documents'], [])
        self.assertEqual((await self.create()).status_code, 202)
        response = await self.create()
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(len(self.db_client.tables['documents']), 5)

    async def test_get_persisted_unknowns_and_evidence_stable_sequence(self):
        self.service.create_review(uploads())
        first = await self.client.get('/get-review', params={'review_id': '1'})
        self.assertEqual(first.status_code, 200, first.text)
        body = first.json()
        self.assertEqual(body['original_amount_cents'], '700000')
        self.assertIsNone(body['corrected_target_cents'])
        self.assertIsNone(body['proposal_id'])
        self.assertEqual(body['history'], [])
        self.assertTrue(any(row['page_or_row'] == 'json $.entryId' for row in body['evidence']))
        self.assertEqual(body['sequence'], (await self.client.get('/get-review', params={'review_id': '1'})).json()['sequence'])
        self.db_client.tables['cases'][0].update(state='WAITING_FOR_INPUT', blockers=['Missing support'])
        updated = (await self.client.get('/get-review', params={'review_id': '1'})).json()
        self.assertEqual(updated['blockers'], ['Missing support'])
        self.assertNotEqual(updated['sequence'], body['sequence'])
        self.assertEqual((await self.client.get('/get-review', params={'review_id': '2'})).status_code, 404)

    async def test_get_projects_only_current_revision_proposal_exact_money(self):
        self.service.create_review(uploads())
        self.db_client.tables['cases'][0].update(current_proposal_id=7, state='READY_FOR_REVIEW')
        proposal = dict(id=7, case_id=1, input_revision=1, corrected_target_cents='770000',
                        adjustment_cents='70000', export_amount_cents='70000', hash='abc',
                        currency='USD', entry_date='2026-10-24', journal_lines=[{
                            'account_code': '6000', 'account_name': 'Expense',
                            'debit_cents': '70000', 'credit_cents': '0'}])
        self.db_client.tables['proposals'].append(proposal)
        body = (await self.client.get('/get-review', params={'review_id': '1'})).json()
        self.assertEqual(body['proposal_id'], '7')
        self.assertEqual(body['difference_cents'], '70000')
        self.assertEqual(body['journal_lines'][0]['debit_cents'], '70000')
        proposal['input_revision'] = 0
        self.assertEqual((await self.client.get('/get-review', params={'review_id': '1'})).status_code, 503)

    async def test_live_snapshots_detect_change_and_close_between_polls(self):
        self.service.create_review(uploads())
        stream = self.service.stream_review('1')
        initial = (await anext(stream)).decode()
        self.assertIn('event: snapshot\n', initial)
        initial_body = json.loads(initial.split('data: ', 1)[1])
        self.db_client.tables['cases'][0].update(state='EXTRACTING', updated_at=2)
        update = (await anext(stream)).decode()
        self.assertIn('event: review.updated\n', update)
        self.assertIn('"status":"EXTRACTING"', update)
        self.assertGreaterEqual(self.db_client.closed, 3)
        await stream.aclose()
        resumed = self.service.stream_review('1', initial_body['sequence'])
        self.assertIn('event: snapshot\n', (await anext(resumed)).decode())
        await resumed.aclose()

    async def test_invalid_structured_inputs_reject_without_file_writes(self):
        for filename, mime, data in [
            ('accrual.json', 'application/json', b'{"entryId":"a","entryId":"b"}'),
            ('ledger.csv', 'text/csv', b'entry_id,vendor_id,period,kind,amount,status\nx,v,2026-13,ACCRUAL,2,POSTED\n'),
            ('timesheet.csv', 'text/csv', b'service_date,contractor,approved_minutes,status\n2026-02-30,A,15,APPROVED\n'),
            ('contract.pdf', 'application/pdf', b'%PDF-1.7'),
        ]:
            with self.subTest(filename=filename):
                response = await self.create(uploads() + [ReviewUpload(filename, mime, len(data), io.BytesIO(data))])
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(self.db_client.tables['documents'], [])

    async def test_invalid_live_cursor_and_missing_review_fail_before_stream_headers(self):
        response = await self.client.get('/get-review', params={'review_id': '1', 'live': True, 'after_sequence': 'junk'})
        self.assertEqual(response.status_code, 422)
        response = await self.client.get('/get-review', params={'review_id': '1', 'live': True})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.headers['content-type'], 'application/json')

    async def test_header_only_invoice_accepts_no_invoice_scenario(self):
        files = uploads()
        data = b'invoice_number,contractor,service_start,service_end,minutes,amount,posting_status,posted_date\n'
        files[3] = ReviewUpload('invoices.csv', 'text/csv', len(data), io.BytesIO(data))
        response = await self.create(files)
        self.assertEqual(response.status_code, 202, response.text)

    async def test_invalid_filename_is_rejected_before_any_writes(self):
        files = uploads()
        last = files[-1]
        files[-1] = ReviewUpload('x' * 256, last.media_type, last.size, last.stream)
        response = await self.create(files)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.db_client.tables['documents'], [])

    async def test_acceptance_survives_sweeper_start_before_import_readback(self):
        reducer = self.db_client.call_reducer
        def call(name, args):
            reducer(name, args)
            if name == 'finalize_import':
                self.db_client.tables['cases'][0]['state'] = 'EXTRACTING'
        self.db_client.call_reducer = call
        response = await self.create()
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()['status'], 'IMPORTED')
        body = (await self.client.get('/get-review', params={'review_id': '1'})).json()
        self.assertEqual(body['status'], 'EXTRACTING')

    async def test_approve_posts_matching_hash_and_rejects_mismatch(self):
        self.service.create_review(uploads())
        self.db_client.tables['cases'][0].update(current_proposal_id=7, state='READY_FOR_REVIEW')
        self.db_client.tables['proposals'].append(dict(
            id=7, case_id=1, input_revision=1, corrected_target_cents='770000',
            adjustment_cents='70000', export_amount_cents='70000', hash='abc',
            currency='USD', entry_date='2026-10-24', journal_lines=[{
                'account_code': '6000', 'account_name': 'Expense',
                'debit_cents': '70000', 'credit_cents': '0'}]))
        posts = []
        self.service.post_intuit = lambda case_id, approve_hash: posts.append((case_id, approve_hash)) or {
            'posted': True, 'already_posted': False, 'qbo_id': 146}
        mismatch = await self.client.post('/approve-review', json={'review_id': '1', 'proposal_hash': 'nope'})
        self.assertEqual(mismatch.status_code, 409)
        self.assertEqual(posts, [])
        ok = await self.client.post('/approve-review', json={'review_id': '1', 'proposal_hash': 'abc'})
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(ok.json(), {
            'review_id': '1', 'proposal_hash': 'abc', 'posted': True,
            'already_posted': False, 'qbo_id': '146'})
        self.assertEqual(posts, [(1, 'abc')])

    async def test_accrual_identifier_limits_match_database_unicode_length(self):
        files = uploads()
        accrual = json.loads(files[0].stream.read())
        accrual['vendorId'] = '\U0001f600' * 33
        data = json.dumps(accrual).encode()
        files[0] = ReviewUpload('accrual.json', 'application/json', len(data), io.BytesIO(data))
        response = await self.create(files)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.db_client.tables['documents'], [])


if __name__ == '__main__':
    unittest.main()
