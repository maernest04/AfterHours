import json
import unittest
from unittest.mock import patch

from afterhours_db.websocket import SpacetimeConnection, ReducerError


class WebSocketTests(unittest.TestCase):
    def test_matches_ack_to_request_and_surfaces_reducer_failure(self):
        messages = [
            {'IdentityToken': {'connection_id': {'__connection_id__': 1}, 'identity': {}, 'token': 'not-logged'}},
            {'TransactionUpdate': {'reducer_call': {'request_id': 99}, 'status': {'Committed': {'tables': []}}}},
            {'TransactionUpdate': {'reducer_call': {'request_id': 1}, 'status': {'Failed': 'Stale or unknown lease.'}}},
        ]
        with patch('afterhours_db.websocket.connect') as factory:
            factory.return_value.recv.side_effect = [json.dumps(m) for m in messages]
            with SpacetimeConnection('http://localhost:3000', 'demo', token='secret') as client:
                self.assertEqual(client.connection_id, '00000000000000000000000000000001')
                with self.assertRaisesRegex(ReducerError, 'Stale or unknown lease'):
                    client.call_reducer('heartbeat_job', [1, 2, 1, 'old'])

    def test_argument_error_with_zero_request_id_is_reported_and_connection_survives(self):
        messages = [
            {'IdentityToken': {'connection_id': {'__connection_id__': 1}}},
            {'TransactionUpdate': {'caller_connection_id': {'__connection_id__': 2},
                'reducer_call': {'request_id': 0, 'reducer_name': 'heartbeat_job'},
                'status': {'Failed': 'different caller'}}},
            {'TransactionUpdate': {'caller_connection_id': {'__connection_id__': 1},
                'reducer_call': {'request_id': 0, 'reducer_name': 'heartbeat_job'},
                'status': {'Failed': 'invalid arguments for reducer heartbeat_job'}}},
            {'TransactionUpdate': {'reducer_call': {'request_id': 2},
                'status': {'Committed': {'tables': []}}}},
        ]
        with patch('afterhours_db.websocket.connect') as factory:
            factory.return_value.recv.side_effect = [json.dumps(m) for m in messages]
            with SpacetimeConnection('http://localhost:3000', 'demo', token='secret') as client:
                with self.assertRaisesRegex(ReducerError, 'invalid arguments'):
                    client.call_reducer('heartbeat_job', [])
                self.assertIsNone(client.call_reducer('heartbeat_job', [1, 2, 1, 'lease']))

    def test_success_and_timeout_close_connection_without_retry(self):
        with patch('afterhours_db.websocket.connect') as factory:
            factory.return_value.recv.side_effect = [
                json.dumps({'IdentityToken': {'connection_id': {'__connection_id__': 1}}}),
                json.dumps({'TransactionUpdate': {'reducer_call': {'request_id': 1}, 'status': {'Committed': {'tables': []}}}}),
                TimeoutError('timed out'),
            ]
            with SpacetimeConnection('http://localhost:3000', 'demo', token='secret') as client:
                self.assertIsNone(client.call_reducer('claim_job', [1, 2, 1]))
                with self.assertRaises(TimeoutError):
                    client.call_reducer('heartbeat_job', [1, 2, 1, 'lease'])
                with self.assertRaisesRegex(RuntimeError, 'closed'):
                    client.call_reducer('heartbeat_job', [1, 2, 1, 'lease'])

if __name__ == '__main__':
    unittest.main()
