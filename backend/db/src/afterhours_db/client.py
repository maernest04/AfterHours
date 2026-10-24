"""Small synchronous HTTP client; no local replica or realtime subscriptions."""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote

import httpx


class SpacetimeError(RuntimeError):
    def __init__(self, status_code: int | None, message: str):
        self.status_code = status_code
        prefix = f'SpacetimeDB HTTP {status_code}' if status_code is not None else 'SpacetimeDB reducer'
        super().__init__(f'{prefix}: {message}')


def _name(value: Any) -> str | None:
    return value.get('some') if isinstance(value, dict) else value


def _decode(value: Any, schema: dict) -> Any:
    """Decode SATS products/options from SQL's inline schema, preserving integers."""
    if 'Product' in schema:
        fields = schema['Product']['elements']
        if not fields:
            return {}
        result = {}
        for index, field in enumerate(fields):
            name = _name(field['name']) or str(index)
            raw = value[name] if isinstance(value, dict) else value[index]
            result[name] = _decode(raw, field['algebraic_type'])
        return result
    if 'Sum' in schema:
        variants = schema['Sum']['variants']
        tag, raw = value if isinstance(value, list) else next(iter(value.items()))
        tag = str(tag)
        index = int(tag) if tag.isdecimal() else next(i for i, v in enumerate(variants) if _name(v['name']) == tag)
        variant = variants[index]
        name = _name(variant['name']) or str(index)
        if {_name(v['name']) for v in variants} == {'some', 'none'}:
            return None if name == 'none' else _decode(raw, variant['algebraic_type'])
        return {name: _decode(raw, variant['algebraic_type'])}
    if 'Array' in schema:
        return [_decode(item, schema['Array']) for item in value]
    if 'Builtin' in schema:
        return _decode(value, schema['Builtin'])
    return value


class SpacetimeClient:
    """Use a service token for application calls; reserve owner tokens for setup.

    Calls have a bounded timeout and are never automatically retried: a timed-out
    reducer might already have committed. Reuse the upload key when retrying.
    Use sync FastAPI handlers or asyncio.to_thread when calling from async code.
    """
    def __init__(self, uri: str, database: str, *, token: str | None = None,
                 timeout: float = 30, transport: httpx.BaseTransport | None = None):
        self.uri = uri.rstrip('/')
        self.database = database
        self._prefix = f'/v1/database/{quote(database, safe="")}'
        self._http = httpx.Client(base_url=self.uri, timeout=timeout, transport=transport,
                                  headers={'Authorization': f'Bearer {token}'} if token else {})

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        self._http.close()

    def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        response = self._http.request(method, path, **kwargs)
        if response.is_error:
            raise SpacetimeError(response.status_code, response.text)
        return response

    def create_identity(self) -> dict[str, str]:
        return self._request('POST', '/v1/identity').json()

    def identity(self) -> str:
        response = self._request('GET', self._prefix + '/schema', params={'version': 9})
        return response.headers['spacetime-identity']

    def query(self, sql: str) -> list[dict[str, Any]]:
        """Run one read query. Table/view access remains enforced by the server."""
        results = self._request('POST', self._prefix + '/sql', content=sql,
                                headers={'Content-Type': 'text/plain'}).json()
        if len(results) != 1:
            raise ValueError('query() expects exactly one SQL statement')
        result = results[0]
        return [_decode(row, {'Product': result['schema']}) for row in result['rows']]

    def call_reducer(self, name: str, args: list[Any]) -> None:
        """Arguments are ordered SATS-JSON values, matching the reducer signature."""
        if not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', name):
            raise ValueError('Invalid reducer name')
        self._request('POST', self._prefix + '/call/' + name, json=args)
