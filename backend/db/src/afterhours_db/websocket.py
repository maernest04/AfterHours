"""Persistent JSON WebSocket reducer calls for connection-bound worker leases.

Queries still use the authenticated HTTP API. This isn't a subscription cache.
Calls serialize on one connection and never reconnect/retry a possibly committed write.
"""
import json
import re
import threading
import time
from urllib.parse import quote, urlsplit, urlunsplit

from websockets.sync.client import connect

from .client import SpacetimeClient, SpacetimeError


class ReducerError(SpacetimeError):
    def __init__(self, message: str):
        super().__init__(None, message)


class SpacetimeConnection(SpacetimeClient):
    def __init__(self, uri: str, database: str, *, token: str, timeout: float = 30):
        super().__init__(uri, database, token=token, timeout=timeout)
        parsed = urlsplit(uri)
        if parsed.scheme not in ('http', 'https'):
            super().close()
            raise ValueError('Database URI must use http or https')
        ws_uri = urlunsplit(('wss' if parsed.scheme == 'https' else 'ws', parsed.netloc,
                            f'{parsed.path.rstrip("/")}/v1/database/{quote(database, safe="")}/subscribe', '', ''))
        self._closed = False
        self._lock = threading.Lock()
        self._request_id = 0
        self._timeout = timeout
        self._ws = None
        try:
            self._ws = connect(ws_uri, subprotocols=['v1.json.spacetimedb'],
                               additional_headers={'Authorization': f'Bearer {token}'},
                               open_timeout=timeout, close_timeout=5, max_size=16 * 1024 * 1024)
            identity = json.loads(self._ws.recv(timeout=timeout))['IdentityToken']
            value = identity['connection_id']['__connection_id__']
            self.connection_id = format(int(value), '032x')
        except Exception:
            self.close()
            raise

    def close(self):
        self._closed = True
        if self._ws is not None:
            self._ws.close()
        super().close()

    def call_reducer(self, name: str, args: list) -> None:
        if not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', name):
            raise ValueError('Invalid reducer name')
        with self._lock:
            if self._closed:
                raise RuntimeError('WebSocket connection is closed; obtain a new connection and lease')
            self._request_id += 1
            request_id = self._request_id
            deadline = time.monotonic() + self._timeout
            try:
                self._ws.send(json.dumps({'CallReducer': {'reducer': name, 'args': json.dumps(args),
                                                         'request_id': request_id, 'flags': 0}}))
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError(f'Timed out awaiting reducer {name}; it may have committed')
                    message = json.loads(self._ws.recv(timeout=remaining))
                    update = message.get('TransactionUpdate')
                    if not update:
                        continue
                    call = update.get('reducer_call', {})
                    status = update['status']
                    caller = update.get('caller_connection_id', {}).get('__connection_id__')
                    # Argument validation errors use request_id=0 in server 2.13.
                    # Only accept them for this serialized call and this connection.
                    argument_error = (call.get('request_id') == 0 and call.get('reducer_name') == name
                                      and 'Failed' in status and caller is not None
                                      and format(int(caller), '032x') == self.connection_id)
                    if call.get('request_id') != request_id and not argument_error:
                        continue
                    if 'Committed' in status:
                        return
                    if 'Failed' in status:
                        raise ReducerError(status['Failed'])
                    raise ReducerError(f'Reducer {name} did not commit: {status}')
            except ReducerError:
                raise
            except Exception:
                # Do not let a late response or a new connection continue an old lease.
                self.close()
                raise
