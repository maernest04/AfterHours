import os
import unittest

import httpx
from backend.api.main import app


class ReviewApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        base_url = os.getenv("AFTERHOURS_API_URL")
        self.client = httpx.AsyncClient(
            base_url=base_url or "http://test",
            transport=None if base_url else httpx.ASGITransport(app=app),
            timeout=30,
        )

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_create_review_combines_upload_and_start(self):
        response = await self.client.post('/create-review', files=[('files', ('accrual.csv', b'amount\n7000\n', 'text/csv'))])
        self.assertEqual(response.status_code, 501)
        self.assertEqual(response.json()['detail']['operation'], 'create-review')

    async def test_remaining_operations_are_explicit_stubs(self):
        requests = [
            ('/get-review', {'review_id': 'review-1'}),
            ('/get-review', {'review_id': 'review-1', 'live': 'true', 'after_sequence': '1'}),
            ('/export-review', {'review_id': 'review-1'}),
        ]
        for path, params in requests:
            with self.subTest(path=path, params=params):
                response = await self.client.get(path, params=params)
                self.assertEqual(response.status_code, 501)
                self.assertEqual(response.json()['detail']['code'], 'NOT_IMPLEMENTED')

    async def test_missing_and_invalid_parameters(self):
        requests = [
            ('/get-review', {}), ('/get-review', {'review_id': ' '}),
            ('/get-review', {'review_id': 'review-1', 'live': 'maybe'}),
            ('/get-review', {'review_id': 'review-1', 'after_sequence': '1'}),
            ('/list-review', {'limit': 0}), ('/list-review', {'limit': 11}),
            ('/list-review', {'cursor': 'page-2'}),
            ('/export-review', {}), ('/export-review', {'review_id': ' '}),
        ]
        for path, params in requests:
            with self.subTest(path=path, params=params):
                self.assertEqual((await self.client.get(path, params=params)).status_code, 422)
        self.assertEqual((await self.client.post('/create-review')).status_code, 422)

    async def test_upload_rejects_empty_unsupported_and_oversized_files(self):
        for content, media_type, expected in [
            (b'', 'text/csv', 422), (b'x', 'image/png', 415),
            (b'x' * (10 * 1024 * 1024 + 1), 'text/plain', 413),
        ]:
            with self.subTest(media_type=media_type, expected=expected):
                response = await self.client.post('/create-review', files=[('files', ('input.txt', content, media_type))])
                self.assertEqual(response.status_code, expected)

    async def test_multiple_files_and_combined_upload_size(self):
        files = [('files', ('ledger.csv', b'posted\n7000', 'text/csv')),
                 ('files', ('contract.txt', b'Rate: 110/hour', 'text/plain'))]
        self.assertEqual((await self.client.post('/create-review', files=files)).status_code, 501)
        large = b'x' * (6 * 1024 * 1024)
        response = await self.client.post('/create-review', files=[
            ('files', ('first.txt', large, 'text/plain')),
            ('files', ('second.txt', large, 'text/plain')),
        ])
        self.assertEqual(response.status_code, 413)

    async def test_success_contracts_are_published_for_every_api(self):
        document = (await self.client.get('/openapi.json')).json()
        for path, method, status in [
            ('/create-review', 'post', '202'),
            ('/list-review', 'get', '200'),
            ('/get-review', 'get', '200'),
        ]:
            with self.subTest(path=path):
                responses = document['paths'][path][method]['responses']
                self.assertIn(status, responses)
                content = responses[status]['content']['application/json']
                self.assertIn('$ref', content['schema'])
                self.assertIn('example', content)
                if path == '/list-review':
                    self.assertIn('503', responses)
                    self.assertNotIn('501', responses)
                else:
                    self.assertIn('501', responses)
                    self.assertNotIn('success', responses['501']['description'].lower())
        live = document['paths']['/get-review']['get']['responses']['200']['content']['text/event-stream']
        self.assertIn('event: snapshot', live['example'])
        self.assertIn('event: review.updated', live['example'])
        export = document['paths']['/export-review']['get']['responses']
        self.assertIn('text/csv', export['200']['content'])
        self.assertNotIn('application/json', export['200']['content'])
        self.assertIn('Content-Disposition', export['200']['headers'])
        self.assertIn('501', export)
        self.assertNotIn('success', export['501']['description'].lower())

    async def test_no_approval_question_settings_or_separate_updates_routes(self):
        paths = (await self.client.get('/openapi.json')).json()['paths']
        self.assertEqual(set(paths), {'/create-review', '/list-review', '/get-review', '/export-review'})


if __name__ == '__main__':
    unittest.main()
