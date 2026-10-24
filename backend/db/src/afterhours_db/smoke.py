"""Real-server integration checks. Creates uniquely labeled synthetic documents."""
import hashlib
import unittest
from uuid import uuid4

from . import AfterHoursDB, SpacetimeClient, SpacetimeError
from .config import DatabaseConfig


class StorageSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = DatabaseConfig.from_env()
        cls.gateway = AfterHoursDB.connect('gateway', cls.config)
        cls.worker = AfterHoursDB.connect('worker', cls.config)
        cls.anon = SpacetimeClient(cls.config.uri, cls.config.database)
        cls.ref = f'SMOKE-{uuid4().hex[:8]}'
        cls.company = cls.gateway.settings()['company_id']

    @classmethod
    def tearDownClass(cls):
        for connection in (cls.gateway, cls.worker, cls.anon):
            connection.close()

    def upload(self, data=None, **kwargs):
        values = dict(data=data or f'SYNTHETIC {uuid4()}'.encode(), original_filename='synthetic.txt',
                      media_type='text/plain', type='OTHER', reference_id=self.ref,
                      source_label='Python smoke (SYNTHETIC)')
        values.update(kwargs)
        return self.gateway.upload_document(**values)

    def raw_args(self):
        saved = self.gateway.files.put(b'SYNTHETIC reducer validation')
        return [self.company, uuid4().hex, saved.storage_key, saved.content_hash,
                saved.byte_length, 'text/plain', 'synthetic.txt', 'OTHER',
                {'some': self.ref}, 'Python smoke (SYNTHETIC)']

    def test_01_upload_persists_file_and_metadata(self):
        doc = self.upload(b'SYNTHETIC contract', type='CONTRACT')
        self.assertEqual(doc.version, 1)
        self.assertIsNone(doc.supersedes_document_id)
        self.assertEqual(doc.company_id, self.company)
        self.assertEqual(doc.content_hash, hashlib.sha256(b'SYNTHETIC contract').hexdigest())
        self.assertTrue(self.gateway.files.path_for(doc.storage_key).is_file())
        self.assertEqual(self.gateway.get_document(doc.id), doc)

    def test_02_verified_read(self):
        doc = self.upload(b'SYNTHETIC verified read')
        metadata, data = self.gateway.read_document(doc.id)
        self.assertEqual(metadata, doc)
        self.assertEqual(data, b'SYNTHETIC verified read')
        self.assertTrue(self.gateway.verify_document(doc.id).ok)
        self.assertIn(doc, self.gateway.find_by_content_hash(doc.content_hash))

    def test_03_tamper_detected(self):
        doc = self.upload()
        self.gateway.files.path_for(doc.storage_key).write_bytes(b'altered')
        result = self.gateway.verify_document(doc.id)
        self.assertFalse(result.ok)
        self.assertRegex(result.error, 'size|hash')

    def test_04_reducer_validates_metadata_and_company(self):
        for index, value, message in [(2, 'sha256/' + '0' * 64, 'storageKey'),
                                      (7, 'RECEIPT', 'type must be'),
                                      (5, 'image/png', 'media type'),
                                      (0, 'other-co', 'Unknown company')]:
            with self.subTest(value=value):
                args = self.raw_args()
                args[index] = value
                with self.assertRaisesRegex(SpacetimeError, message):
                    self.gateway.client.call_reducer('store_document', args)

    def test_05_roles_enforce_writes_and_settings(self):
        for client in (self.worker.client, self.anon):
            with self.assertRaisesRegex(SpacetimeError, 'Only the configured gateway'):
                client.call_reducer('store_document', self.raw_args())
        with self.assertRaisesRegex(SpacetimeError, 'module owner'):
            self.anon.call_reducer('configure_settings', [self.company, 'USD', ['1', 'x'], ['2', 'y'], 'x'])

    def test_06_views_and_private_tables(self):
        doc = self.upload()
        self.assertEqual(self.worker.get_document(doc.id), doc)
        self.assertEqual(self.worker.settings()['company_id'], self.company)
        for view in ('documents_view', 'settings_view', 'my_service_identity'):
            self.assertEqual(self.anon.query(f'SELECT * FROM {view}'), [])
        with self.assertRaises(SpacetimeError):
            self.anon.query('SELECT * FROM documents')

    def test_07_idempotent_retry_and_conflict(self):
        key = uuid4().hex
        first = self.upload(b'SYNTHETIC retry', upload_key=key)
        second = self.upload(b'SYNTHETIC retry', upload_key=key)
        self.assertEqual(first.id, second.id)
        with self.assertRaisesRegex(SpacetimeError, 'different content'):
            self.upload(b'SYNTHETIC different', upload_key=key)

    def test_08_version_preserves_previous_and_history(self):
        first = self.upload(b'SYNTHETIC v1', type='TIMESHEET')
        second = self.gateway.add_document_version(first.id, data=b'SYNTHETIC v2',
                    original_filename='v2.txt', media_type='text/plain', source_label='smoke (SYNTHETIC)')
        self.assertEqual(second.version, 2)
        self.assertEqual(second.supersedes_document_id, first.id)
        self.assertEqual(second.type, 'TIMESHEET')
        self.assertEqual(second.reference_id, self.ref)
        self.assertEqual(self.gateway.read_document(first.id)[1], b'SYNTHETIC v1')
        self.assertEqual(self.gateway.get_version_history(first.id), [first, second])
        self.assertEqual(self.gateway.get_version_history(second.id), [first, second])
        self.assertEqual(self.gateway.get_document(first.id), first)

    def test_09_invalid_version_rejected(self):
        first = self.upload(b'SYNTHETIC v1')
        kwargs = dict(original_filename='v2.txt', media_type='text/plain', source_label='smoke (SYNTHETIC)')
        second = self.gateway.add_document_version(first.id, data=b'SYNTHETIC v2', **kwargs)
        for previous, data, message in [(first.id, b'SYNTHETIC v3', 'already superseded'),
                                         (second.id, b'SYNTHETIC v2', 'identical content')]:
            with self.assertRaisesRegex(SpacetimeError, message):
                self.gateway.add_document_version(previous, data=data, **kwargs)

    def test_10_list_filters(self):
        ref = f'{self.ref}-filters'
        first = self.upload(b'SYNTHETIC first', type='TIMESHEET', reference_id=ref)
        self.gateway.add_document_version(first.id, data=b'SYNTHETIC next', original_filename='v2.txt',
                    media_type='text/plain', source_label='smoke (SYNTHETIC)')
        self.upload(type='CONTRACT', reference_id=ref)
        self.assertEqual(len(self.gateway.list_documents(reference_id=ref)), 3)
        self.assertEqual(len(self.gateway.list_documents(reference_id=ref, type='TIMESHEET')), 2)
        latest = self.gateway.list_documents(reference_id=ref, latest_only=True)
        self.assertEqual(len(latest), 2)
        self.assertNotIn(first, latest)

    def test_11_ledger_round_trip(self):
        data = b'entry_id,amount,status\nSYNTHETIC,1.00,POSTED\n'
        doc = self.upload(data, type='LEDGER', original_filename='ledger.csv', media_type='text/csv')
        self.assertEqual(doc.type, 'LEDGER')
        self.assertEqual(self.gateway.read_document(doc.id)[1], data)

    def test_12_settings(self):
        settings = self.gateway.settings()
        self.assertEqual(settings['currency'], 'USD')
        self.assertEqual(settings['expense_account']['code'], '6100')
        self.assertEqual(settings['liability_account']['code'], '2105')

    def test_13_upload_limits(self):
        data = self.ref.encode().ljust(10 * 1024 * 1024, b'A')
        doc = self.upload(data)
        self.assertEqual(doc.byte_length, 10 * 1024 * 1024)
        self.assertEqual(self.gateway.read_document(doc.id)[1], data)
        for invalid, media in [(b'', 'text/plain'), (data + b'A', 'text/plain'), (b'abc', 'image/png')]:
            with self.assertRaises(ValueError):
                self.gateway.upload_document(data=invalid, original_filename='x.txt', media_type=media,
                    type='OTHER', source_label='smoke (SYNTHETIC)')


def run() -> bool:
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(StorageSmokeTests))
    return result.wasSuccessful()
