import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from afterhours_db.cases import finalize_import, is_awaiting_proposal, list_facts
from afterhours_db.mailbox import store_email


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.client = Mock()
        self.client.query.return_value = []
        self.db = SimpleNamespace(client=self.client, config=SimpleNamespace(company_id='demo'))
        self.input = dict(document_ids=[7], vendor_id='V1', service_period_from='2026-09-01',
                          service_period_to='2026-09-30', posting_period='2026-09',
                          original_status='POSTED', original_amount_cents='700000', source_entry_id='E1')

    def test_import_serializes_exact_evidence_and_generates_key(self):
        self.db.read_document = lambda _: (SimpleNamespace(id=7, type='TIMESHEET', media_type='text/csv'),
            b'service_date,contractor,approved_minutes,status\n2026-09-01,J,420,approved')
        def committed(name, args):
            self.assertEqual(name, 'finalize_import')
            self.assertEqual(args[0], 'demo')
            self.assertTrue(args[1])
            self.assertEqual(args[10], [[7, 'row 2', '2026-09-01,J,420,approved', 'J', '2026-09-01', 420, {'none': []}, 'APPROVED', '']])
            self.client.query.return_value = [{'id': 1, 'idempotency_key': args[1]}]
        self.client.call_reducer.side_effect = committed
        self.assertEqual(finalize_import(self.db, **self.input)['id'], 1)

    def test_import_stops_before_reducer_when_document_integrity_fails(self):
        self.db.read_document = Mock(side_effect=ValueError('File content hash mismatch'))
        with self.assertRaisesRegex(ValueError, 'hash'):
            finalize_import(self.db, **self.input)
        self.client.call_reducer.assert_not_called()

    def test_idempotent_import_returns_existing_but_rejects_conflicting_source(self):
        existing = {'id': 1, 'idempotency_key': 'fixed', 'source_entry_id': 'E1'}
        self.client.query.return_value = [existing]
        self.assertEqual(finalize_import(self.db, **self.input, idempotency_key='fixed'), existing)
        self.input['source_entry_id'] = 'E2'
        with self.assertRaisesRegex(ValueError, 'different import'):
            finalize_import(self.db, **self.input, idempotency_key='fixed')
        self.client.call_reducer.assert_not_called()

    def test_facts_and_proposal_readiness_use_current_revision(self):
        tables = {
            'cases_view': [{'id': 1, 'input_revision': 2, 'state': 'MATCHING'}],
            'facts_view': [{'id': 1, 'case_id': 1, 'input_revision': 1}, {'id': 2, 'case_id': 1, 'input_revision': 2}],
            'jobs_view': [{'id': 1, 'case_id': 1, 'case_revision': 1, 'status': 'FAILED'}, {'id': 2, 'case_id': 1, 'case_revision': 2, 'status': 'SUCCEEDED'}],
        }
        self.client.query.side_effect = lambda sql: tables[sql.split()[-1]]
        self.assertEqual([fact['id'] for fact in list_facts(self.db, 1)], [2])
        self.assertTrue(is_awaiting_proposal(self.db, 1))
        tables['jobs_view'][1]['status'] = 'RUNNING'
        self.assertFalse(is_awaiting_proposal(self.db, 1))

    def test_mailbox_defaults_to_no_attachments_and_returns_committed_email(self):
        self.client.query.return_value = [{'id': 2, 'message_key': 'm1'}]
        result = store_email(self.db, message_key='m1', vendor_id='V1', thread_id='t1',
            sender='from@example.test', recipients=['to@example.test'], subject='Test',
            sent_at='2026-09-01T12:00:00Z', body='Synthetic')
        self.assertEqual(result['id'], 2)
        self.client.call_reducer.assert_called_once_with('store_email', ['demo', 'm1', 'V1', 't1',
            'from@example.test', ['to@example.test'], 'Test', '2026-09-01T12:00:00Z', 'Synthetic', []])
