"""Minimal Bitdeer chat-completions client (OpenAI-compatible, stdlib only).

Docs: https://developers.bitdeer.ai/docs/guides/llm and .../llm/structured-outputs
The key is read server-side only and is never logged or echoed in errors.
"""
import asyncio
import json
import os
import re
import sys
import urllib.error
import urllib.request

DEFAULT_BASE_URL = 'https://api-inference.bitdeer.ai/v1'
DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash'
RETRY_STATUSES = {408, 429, 500, 502, 503, 504}
# Strict structured outputs only guarantee type/enum/required/properties; the application
# validates everything else (patterns, lengths, quotes) itself.
_UNSUPPORTED = {'pattern', 'minLength', 'maxLength', 'minItems', 'maxItems', 'format', 'const'}


class BitdeerError(RuntimeError):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def wire_schema(schema):
    """Strip keywords strict mode may reject; local jsonschema validation still applies them."""
    if isinstance(schema, dict):
        return {key: wire_schema(value) for key, value in schema.items() if key not in _UNSUPPORTED}
    if isinstance(schema, list):
        return [wire_schema(item) for item in schema]
    return schema


def parse_json_content(content):
    """Parse a model reply that should be one JSON object, tolerating fences and <think> blocks."""
    text = re.sub(r'<think>.*?</think>', '', content or '', flags=re.S).strip()
    fenced = re.fullmatch(r'```(?:json)?\s*(.*?)\s*```', text, flags=re.S)
    if fenced:
        text = fenced[1]
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find('{'), text.rfind('}')
        if start < 0 or end <= start:
            raise BitdeerError('Bitdeer reply was not JSON') from None
        try:
            value = json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            raise BitdeerError('Bitdeer reply was not valid JSON') from None
    if not isinstance(value, dict):
        raise BitdeerError('Bitdeer reply was not a JSON object')
    return value


class BitdeerClient:
    def __init__(self, api_key=None, model=None, base_url=None, *, timeout=90, retries=3, mode=None):
        self.api_key = api_key or os.getenv('BITDEER_API_KEY') or ''
        self.model = model or os.getenv('BITDEER_MODEL_ID') or DEFAULT_MODEL
        self.base_url = (base_url or os.getenv('BITDEER_BASE_URL') or DEFAULT_BASE_URL).rstrip('/')
        self.timeout = timeout
        self.retries = retries
        # json_schema (strict) is tried first; json_object is the automatic fallback.
        self.mode = mode or os.getenv('BITDEER_STRUCTURED_MODE') or 'json_schema'
        # Hard stop on spend: total tokens (input + output, incl. hidden reasoning) per client/process.
        self.token_budget = int(os.getenv('BITDEER_TOKEN_BUDGET') or 60000)
        self.tokens_used = 0
        if not self.api_key:
            raise BitdeerError('BITDEER_API_KEY is not set; add it to the root .env')
        if not self.base_url.startswith('https://') and not self.base_url.startswith('http://localhost'):
            raise BitdeerError('BITDEER_BASE_URL must use https')

    def _post(self, payload):
        request = urllib.request.Request(
            f'{self.base_url}/chat/completions', data=json.dumps(payload).encode(), method='POST',
            headers={'Authorization': f'Bearer {self.api_key}', 'Content-Type': 'application/json',
                     'Accept': 'application/json', 'User-Agent': 'afterhours-extraction/0.1'})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read(500).decode('utf-8', 'replace').replace(self.api_key, '***')
            raise BitdeerError(f'Bitdeer HTTP {error.code}: {detail}', error.code) from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise BitdeerError(f'Bitdeer request failed: {type(error).__name__}', 0) from None

    def _complete_sync(self, messages, schema, name, mode):
        payload = {'model': self.model, 'messages': messages, 'temperature': 0, 'max_tokens': 4096}
        if mode == 'json_schema':
            payload['response_format'] = {'type': 'json_schema', 'json_schema': {
                'name': name, 'schema': wire_schema(schema), 'strict': True}}
        else:
            payload['response_format'] = {'type': 'json_object'}
        if self.tokens_used >= self.token_budget:
            raise BitdeerError(f'Bitdeer token budget exhausted ({self.tokens_used}/{self.token_budget}); raise BITDEER_TOKEN_BUDGET')
        body = self._post(payload)
        usage = body.get('usage') or {}
        self.tokens_used += int(usage.get('total_tokens') or 0)
        print(f"[bitdeer] {self.model} in={usage.get('prompt_tokens')} out={usage.get('completion_tokens')} total_used={self.tokens_used}", file=sys.stderr)
        try:
            choice = body['choices'][0]
            content = choice['message']['content']
        except (KeyError, IndexError, TypeError):
            raise BitdeerError('Bitdeer reply had no message content') from None
        if choice.get('finish_reason') == 'length':
            raise BitdeerError('Bitdeer reply was truncated (max_tokens)')
        return parse_json_content(content)

    def complete_json_sync(self, system, user, schema, name='extraction'):
        messages = [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]
        mode, delay = self.mode, 1.0
        for attempt in range(self.retries + 1):
            try:
                return self._complete_sync(messages, schema, name, mode)
            except BitdeerError as error:
                if error.status == 400 and mode == 'json_schema':
                    mode = 'json_object'   # strict schema rejected: fall back, schema stays in the prompt
                    self.mode = mode
                    messages[0] = {'role': 'system', 'content': system + '\nReply with one JSON object matching this '
                                   'JSON Schema exactly:\n' + json.dumps(schema)}
                    continue
                if error.status in RETRY_STATUSES or error.status == 0:
                    if attempt == self.retries:
                        raise
                    import time
                    time.sleep(delay)
                    delay = min(delay * 2, 8)
                    continue
                raise
        raise BitdeerError('Bitdeer retries exhausted')

    async def complete_json(self, system, user, schema, name='extraction'):
        return await asyncio.to_thread(self.complete_json_sync, system, user, schema, name)
