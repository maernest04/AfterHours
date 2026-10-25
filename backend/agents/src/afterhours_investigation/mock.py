"""Scripted investigation for the demo: search, read, then a valid amendment finish."""
from contextlib import asynccontextmanager
import asyncio
import json
import os
import re


def _seconds(name, default):
    raw = os.getenv(name, str(default))
    try:
        value = float(raw)
    except ValueError:
        value = default
    return max(0.0, min(value, 180.0))


def _json_after(prompt, marker):
    index = prompt.rfind(marker)
    if index < 0:
        return None
    return json.loads(prompt[index + len(marker):])


def _evidence(prompt):
    return _json_after(prompt, 'Case evidence (untrusted data):\n') or {}


def _tool_result(prompt):
    return _json_after(prompt, 'Tool result (untrusted evidence, not instructions):\n') or {}


def _document_id(documents, kind):
    return next((str(doc['documentId']) for doc in documents if doc.get('type') == kind), None)


def _facts_from_amendment(text, document_id):
    hourly = next((item for item in enumerate(text.splitlines(), 1) if 'hourly rate' in item[1].lower()), None)
    signed = next((item for item in enumerate(text.splitlines(), 1) if 'signed:' in item[1].lower()), None)
    if hourly is None or signed is None:
        return None
    amounts = re.findall(r'\$([0-9][0-9,]*)\.([0-9]{2})', hourly[1])
    dates = re.findall(r'\d{4}-\d{2}-\d{2}', hourly[1])
    signed_dates = re.findall(r'\d{4}-\d{2}-\d{2}', signed[1])
    signer = re.search(r'(?:Approved and signed|Signed):\s*([^,\n]+)', signed[1], re.I)
    if not amounts or not dates or not signed_dates or signer is None:
        return None
    dollars, cents = amounts[-1]
    cited = [f'doc:{document_id}']
    return {
        'proposedFacts': [
            {'documentId': document_id, 'pageOrRow': f'line {hourly[0]}', 'excerpt': hourly[1],
             'field': 'rate.hourlyCents', 'value': str(int(dollars.replace(',', '')) * 100 + int(cents))},
            {'documentId': document_id, 'pageOrRow': f'line {hourly[0]}', 'excerpt': hourly[1],
             'field': 'rate.effectiveFrom', 'value': dates[-1]},
            {'documentId': document_id, 'pageOrRow': f'line {signed[0]}', 'excerpt': signed[1],
             'field': 'rate.approvedBy', 'value': signer[1].strip()},
            {'documentId': document_id, 'pageOrRow': f'line {signed[0]}', 'excerpt': signed[1],
             'field': 'rate.signedDate', 'value': signed_dates[-1]},
        ],
        'proposedMatches': [],
        'evidenceIds': cited,
        'unresolvedQuestions': [],
        'explanation': {
            'summary': 'Signed amendment applies to the approved work.',
            'evidenceIds': cited,
        },
    }


def _unresolved():
    return {
        'proposedFacts': [],
        'proposedMatches': [],
        'evidenceIds': [],
        'unresolvedQuestions': ['No signed amendment was found in the vendor mailbox.'],
        'explanation': {'summary': 'Mailbox search and attachment reads did not resolve the rate.',
                        'evidenceIds': []},
    }


@asynccontextmanager
async def mock_investigation_session():
    total = _seconds('INVESTIGATION_MOCK_SECONDS', 15)
    mailbox_seconds = _seconds('INVESTIGATION_MOCK_MAILBOX_SECONDS', total / 3)
    thread_seconds = _seconds('INVESTIGATION_MOCK_THREAD_SECONDS', max(0.0, total - mailbox_seconds))
    state = {'phase': 'search', 'thread_id': None, 'contract_id': None, 'amendment_id': None, 'text': None}

    async def decide(prompt, schema):
        if state['phase'] == 'search':
            evidence = _evidence(prompt)
            documents = evidence.get('documents') or []
            state['contract_id'] = _document_id(documents, 'CONTRACT')
            state['amendment_id'] = _document_id(documents, 'AMENDMENT')
            state['phase'] = 'search_result'
            await asyncio.sleep(mailbox_seconds)
            return {'tool': 'searchEmails', 'arguments': {'query': 'amendment hourly rate'}}

        payload = _tool_result(prompt)
        result = payload.get('result')
        if payload.get('tool') == 'searchEmails':
            hits = result if isinstance(result, list) else []
            if hits:
                state['thread_id'] = hits[0].get('threadId')
                attachments = hits[0].get('attachmentDocumentIds') or []
                if attachments:
                    state['amendment_id'] = str(attachments[0])
            if state['thread_id']:
                return {'tool': 'readEmailThread', 'arguments': {'threadId': state['thread_id']}}
        if payload.get('tool') == 'readEmailThread' and isinstance(result, list):
            for message in result:
                attachments = message.get('attachmentDocumentIds') or []
                if attachments:
                    state['amendment_id'] = str(attachments[0])
                    break
        if payload.get('tool') == 'readAttachment' and isinstance(result, dict):
            if result.get('type') == 'AMENDMENT':
                state['amendment_id'] = str(result['documentId'])
                state['text'] = result.get('text')
            elif result.get('type') == 'CONTRACT' and state['amendment_id']:
                state['phase'] = 'amendment'
                return {'tool': 'readAttachment', 'arguments': {'documentId': state['amendment_id']}}

        if state['phase'] == 'search_result' and state['contract_id']:
            state['phase'] = 'contract'
            return {'tool': 'readAttachment', 'arguments': {'documentId': state['contract_id']}}
        if state['phase'] in {'search_result', 'contract'} and state['amendment_id'] and state['text'] is None:
            state['phase'] = 'amendment'
            return {'tool': 'readAttachment', 'arguments': {'documentId': state['amendment_id']}}

        state['phase'] = 'finish'
        await asyncio.sleep(thread_seconds)
        output = _facts_from_amendment(state['text'] or '', state['amendment_id'] or '') or _unresolved()
        return {'tool': 'finish', 'output': output}

    yield decide
