import tempfile
import unittest
from pathlib import Path

import httpx

from afterhours_db import FileStore, SpacetimeClient, SpacetimeError


class FileStoreTests(unittest.TestCase):
    def test_round_trip_and_content_addressing(self):
        with tempfile.TemporaryDirectory() as directory:
            store = FileStore(Path(directory))
            saved = store.put(b'abc')
            self.assertEqual(saved.content_hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
            self.assertEqual(saved.byte_length, 3)
            self.assertEqual(store.put(b'abc'), saved)
            self.assertEqual(store.read(saved.storage_key, saved.content_hash, 3), b'abc')

    def test_tamper_and_path_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            store = FileStore(Path(directory))
            saved = store.put(b'abc')
            store.path_for(saved.storage_key).write_bytes(b'xyz')
            with self.assertRaisesRegex(ValueError, 'hash'):
                store.read(saved.storage_key, saved.content_hash, 3)
            with self.assertRaisesRegex(ValueError, 'storage key'):
                store.read('../../secret', saved.content_hash, 3)
            with self.assertRaisesRegex(ValueError, 'hash'):
                store.put(b'abc')


class ClientTests(unittest.TestCase):
    def test_query_decodes_options_nested_products_and_large_integers(self):
        def field(name, ty):
            return {'name': {'some': name}, 'algebraic_type': ty}
        schema = {'elements': [
            field('id', {'U64': []}),
            field('reference_id', {'Sum': {'variants': [field('some', {'String': []}), field('none', {'Product': {'elements': []}})]}}),
            field('account', {'Product': {'elements': [field('code', {'String': []}), field('name', {'String': []})]}}),
        ]}
        def handler(request):
            self.assertEqual(request.headers['authorization'], 'Bearer secret')
            self.assertEqual(request.content, b'SELECT * FROM documents_view')
            return httpx.Response(200, json=[{'schema': schema, 'rows': [[9007199254740993, {'0': 'REF'}, ['6100', 'Expense']], [2, {'1': []}, ['2105', 'Liability']], [3, [0, 'LIVE'], ['6100', 'Expense']], [4, [1, []], ['2105', 'Liability']]]}])
        with SpacetimeClient('http://localhost:3000', 'demo', token='secret', transport=httpx.MockTransport(handler)) as client:
            rows = client.query('SELECT * FROM documents_view')
        self.assertEqual(rows[0], {'id': 9007199254740993, 'reference_id': 'REF', 'account': {'code': '6100', 'name': 'Expense'}})
        self.assertIsNone(rows[1]['reference_id'])
        self.assertEqual(rows[2]['reference_id'], 'LIVE')
        self.assertIsNone(rows[3]['reference_id'])

    def test_reducer_errors_are_explicit_and_not_retried(self):
        calls = []
        def handler(request):
            calls.append(request)
            return httpx.Response(400, text='Only the configured gateway identity may do this.')
        with SpacetimeClient('http://localhost:3000', 'demo', token='secret', transport=httpx.MockTransport(handler)) as client:
            with self.assertRaisesRegex(SpacetimeError, 'Only the configured gateway') as error:
                client.call_reducer('store_document', ['demo'])
        self.assertEqual(error.exception.status_code, 400)
        self.assertEqual(len(calls), 1)
        self.assertNotIn('secret', str(error.exception))

    def test_reducer_success_and_identifier_validation(self):
        with SpacetimeClient('http://localhost:3000', 'demo', transport=httpx.MockTransport(lambda r: httpx.Response(200))) as client:
            self.assertIsNone(client.call_reducer('store_document', []))
            with self.assertRaises(ValueError):
                client.call_reducer('../sql', [])


if __name__ == '__main__':
    unittest.main()
