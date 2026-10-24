import io
from pathlib import Path
import tempfile
import unittest

from afterhours_db.config import DatabaseConfig
from afterhours_db.documents import AfterHoursDB
from afterhours_db.tools import AgentTools, ToolScopeError, allowed_evidence_ids


class ViewClient:
    """Stand-in for authorized server views; document/file behavior stays real."""

    def __init__(self, rows):
        self.rows = rows

    def query(self, sql):
        prefix = 'SELECT * FROM '
        if not sql.startswith(prefix) or ' ' in sql[len(prefix):]:
            raise AssertionError(f'Unexpected query: {sql}')
        return self.rows.get(sql[len(prefix):], [])


def email(id, vendor='vendor-a', *, sent_at='2026-10-15T12:00:00Z',
          body='Approved hourly rate', subject='Amendment', thread='shared-thread'):
    return dict(id=id, company_id='demo', vendor_id=vendor, thread_id=thread,
                sender='finance@example.com', recipients=['worker@example.com'],
                subject=subject, sent_at=sent_at, body=body)


class AgentToolsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.rows = {
            'cases_view': [dict(id=1, company_id='demo', vendor_id='vendor-a',
                service_period_from='2026-10-01', service_period_to='2026-10-31',
                posting_period='2026-10', original_status='DRAFT',
                original_amount_cents='1200', source_entry_id='entry',
                input_revision=2, state='EXTRACTING', current_proposal_id=None,
                blockers=[], idempotency_key='case-1')],
            'case_documents_view': [dict(case_id=1, document_id=10), dict(case_id=2, document_id=90)],
            'emails_view': [email(20), email(21, 'vendor-b'),
                            email(22, sent_at='2026-10-10T12:00:00Z')],
            'attachments_view': [dict(email_id=20, document_id=11),
                                 dict(email_id=21, document_id=90)],
            'facts_view': [dict(id=id, case_id=case_id, input_revision=revision,
                document_id=10, page_or_row='row 1', excerpt='approved', field='rate',
                value='100', validation_status='VALID', source='CODE')
                for id, case_id, revision in [(30, 1, 2), (31, 1, 1), (32, 2, 2)]],
        }
        self.db = AfterHoursDB(ViewClient(self.rows),
                              DatabaseConfig(file_store_dir=Path(self.directory.name)))
        self.tools = AgentTools(self.db, 1)

    def add_document(self, id, data, media_type='text/plain'):
        saved = self.db.files.put(data)
        row = dict(id=id, company_id='demo', storage_key=saved.storage_key,
                   type='CONTRACT', version=1, content_hash=saved.content_hash,
                   byte_length=saved.byte_length, media_type=media_type,
                   original_filename=f'contract-{id}', reference_id=None,
                   source_label='test', supersedes_document_id=None,
                   upload_key=f'doc-{id}', created_at=0)
        self.rows.setdefault('documents_view', []).append(row)
        return saved

    def test_allowed_evidence_excludes_other_cases_vendors_and_stale_facts(self):
        self.assertEqual(allowed_evidence_ids(self.db, 1),
                         ['doc:10', 'email:20', 'doc:11', 'email:22', 'fact:30'])
        self.assertEqual(allowed_evidence_ids(self.db, 999), [])

    def test_search_enforces_vendor_date_and_keyword_scope(self):
        self.rows['emails_view'].append(email(23, body='Nothing relevant', subject='Greetings'))
        hits = self.tools.search_emails('HOURLY rate', date_range={'from': '2026-10-12', 'to': '2026-10-16'})
        self.assertEqual([hit['emailId'] for hit in hits], ['20'])
        self.assertEqual(hits[0]['attachmentDocumentIds'], ['11'])
        self.assertEqual(hits[0]['evidenceId'], 'email:20')
        self.assertEqual([hit['emailId'] for hit in self.tools.search_emails('rate')], ['20', '22'])
        with self.assertRaises(ToolScopeError):
            self.tools.search_emails('', vendor='vendor-b')
        with self.assertRaises(ToolScopeError):
            AgentTools(self.db, 999).search_emails('')

    def test_search_caps_results_and_snippets_and_ranks_hits(self):
        self.rows['emails_view'] = [email(n, body=('padding ' * 50) + 'hourly' + (' trailing' * 50))
                                   for n in range(40)]
        self.rows['emails_view'].append(email(99, body='hourly rate'))
        hits = self.tools.search_emails('hourly rate', limit=1000)
        self.assertEqual(len(hits), 25)
        self.assertEqual(hits[0]['emailId'], '99')
        self.assertTrue(all(len(hit['snippet']) <= 242 for hit in hits))
        self.assertIn('hourly', hits[1]['snippet'])
        self.assertEqual(self.tools.search_emails('', limit=0), [])
        self.assertEqual(self.tools.search_emails('', limit=-1), [])

    def test_threads_are_oldest_first_and_never_include_other_vendor(self):
        messages = self.tools.read_email_thread('shared-thread')
        self.assertEqual([message['emailId'] for message in messages], ['22', '20'])
        self.assertEqual(messages[0]['body'], 'Approved hourly rate')
        with self.assertRaises(ToolScopeError):
            self.tools.read_email_thread('missing-thread')

    def test_attachments_require_scope_and_verify_real_file_hash(self):
        saved = self.add_document(10, b'contract text')
        self.add_document(11, b'vendor attachment')
        self.add_document(90, b'secret vendor document')
        self.assertEqual(self.tools.read_attachment('10')['text'], 'contract text')
        self.assertEqual(self.tools.read_attachment('11')['text'], 'vendor attachment')
        with self.assertRaises(ToolScopeError):
            self.tools.read_attachment('90')
        self.db.files.path_for(saved.storage_key).write_bytes(b'contract fake')
        with self.assertRaisesRegex(ValueError, 'hash'):
            self.tools.read_attachment('10')

    def test_pdf_extraction_preserves_page_boundaries_and_blank_pages(self):
        from pypdf import PdfWriter
        from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

        writer = PdfWriter()
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'),
                                 NameObject('/Subtype'): NameObject('/Type1'),
                                 NameObject('/BaseFont'): NameObject('/Helvetica')})
        for content in ('Approved rate: 125', '', 'Effective October 1'):
            page = writer.add_blank_page(width=612, height=792)
            page[NameObject('/Resources')] = DictionaryObject({
                NameObject('/Font'): DictionaryObject({NameObject('/F1'): font})})
            stream = DecodedStreamObject()
            stream.set_data(f'BT /F1 12 Tf 50 700 Td ({content}) Tj ET'.encode())
            page[NameObject('/Contents')] = stream
        buffer = io.BytesIO()
        writer.write(buffer)
        self.add_document(10, buffer.getvalue(), 'application/pdf')
        result = self.tools.read_attachment('10')
        self.assertEqual(result['text'], '--- page 1 ---\nApproved rate: 125\n--- page 2 ---\n\n--- page 3 ---\nEffective October 1')
        self.assertEqual(result['evidenceId'], 'doc:10')

    def test_text_attachments_match_utf8_decoder_bom_and_replacement_behavior(self):
        self.add_document(10, b'\xef\xbb\xbfApproved rate\xff')
        self.assertEqual(self.tools.read_attachment('10')['text'], 'Approved rate\ufffd')

    def test_evidence_snapshot_scopes_current_rows_and_serializes_ids(self):
        self.add_document(10, b'case document')
        self.add_document(11, b'mailbox document')
        self.rows['work_items_view'] = [dict(id=id, case_id=case_id,
            input_revision=revision, fact_id=30, contractor='Ada',
            service_date='2026-10-10', approved_minutes=60,
            claimed_rate_cents=None, approved_by='Manager')
            for id, case_id, revision in [(40, 1, 2), (41, 1, 1), (42, 2, 2)]]
        self.rows['job_results_view'] = [dict(job_id=50, case_id=1, model_run='LIVE',
            summary='Done', unresolved_questions=[]), dict(job_id=51, case_id=2)]
        self.rows['invoice_lines_view'] = [dict(id=60, case_id=1, input_revision=2,
            fact_id=30, invoice_number='INV-1', contractor='Ada', service_start='2026-10-01',
            service_end='2026-10-31', minutes=60, amount_cents='12500',
            posting_status='POSTED', posted_date='2026-10-15')]
        self.rows['ledger_records_view'] = [dict(id=70, case_id=1, input_revision=2,
            fact_id=30, entry_id='J-1', vendor_id='vendor-a', period='2026-10',
            kind='ACCRUAL', amount_cents='12500', status='POSTED', description='October')]
        self.rows['allocations_view'] = [dict(id=9007199254740993, case_id=1,
            input_revision=2, work_item_id=40, contract_document_id=10,
            invoice_line_ids=[60], ledger_record_ids=[70], evidence_ids=['fact:30'])]
        self.rows['jobs_view'] = [dict(id=50, case_id=1, case_revision=2,
            role='EXTRACTION', status='SUCCEEDED', attempts=1)]
        snapshot = self.tools.get_case_evidence()
        self.assertEqual(snapshot['case']['id'], '1')
        self.assertEqual(snapshot['case']['servicePeriod'], {'from': '2026-10-01', 'to': '2026-10-31'})
        self.assertIsNone(snapshot['case']['currentProposalId'])
        self.assertEqual([d['documentId'] for d in snapshot['documents']], ['10'])
        self.assertEqual([f['evidenceId'] for f in snapshot['facts']], ['fact:30'])
        self.assertEqual(snapshot['facts'][0]['source'], 'CODE')
        self.assertEqual(snapshot['workItems'], [dict(id='40', factId='30',
            contractor='Ada', serviceDate='2026-10-10', approvedMinutes=60,
            claimedRateCents=None, approvedBy='Manager')])
        self.assertEqual([r['jobId'] for r in snapshot['jobResults']], ['50'])
        self.assertEqual(snapshot['invoiceLines'], [dict(id='60', factId='30',
            invoiceNumber='INV-1', contractor='Ada', serviceStart='2026-10-01',
            serviceEnd='2026-10-31', minutes=60, amountCents='12500',
            postingStatus='POSTED', postedDate='2026-10-15')])
        self.assertEqual(snapshot['ledgerRecords'], [dict(id='70', factId='30',
            entryId='J-1', vendorId='vendor-a', period='2026-10', kind='ACCRUAL',
            amountCents='12500', status='POSTED', description='October')])
        self.assertEqual(snapshot['allocations'], [dict(id='9007199254740993',
            workItemId='40', contractId='10', invoiceLineIds=['60'],
            ledgerEntryIds=['70'], evidenceIds=['fact:30'])])
        self.assertEqual(snapshot['jobs'], [dict(id='50', caseId='1', caseRevision=2,
            role='EXTRACTION', status='SUCCEEDED', attempts=1)])


if __name__ == '__main__':
    unittest.main()
