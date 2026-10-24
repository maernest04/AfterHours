"""Parse structured import evidence with exact money and retained source references."""
from __future__ import annotations

import json
import re
from decimal import Decimal


class ParseError(ValueError):
    """A structured document cannot be imported without losing or inventing data."""


def parse_csv(text: str) -> dict:
    """Read RFC 4180-style records, retaining raw records for evidence excerpts."""
    records = []
    field, cells, raw = '', [], ''
    quoted = False
    index = 0

    def push():
        nonlocal field, cells, raw
        cells.append(field)
        if any(cell.strip() for cell in cells):
            records.append((cells, raw))
        field, cells, raw = '', [], ''

    while index < len(text):
        char = text[index]
        if quoted:
            raw += char
            if char == '"' and text[index:index + 2] == '""':
                field += '"'
                raw += '"'
                index += 1
            elif char == '"':
                quoted = False
            else:
                field += char
        elif char == '"':
            quoted = True
            raw += char
        elif char == ',':
            cells.append(field)
            field = ''
            raw += char
        elif char in '\r\n':
            if text[index:index + 2] == '\r\n':
                index += 1
            push()
        else:
            field += char
            raw += char
        index += 1
    if quoted:
        raise ParseError('CSV has an unterminated quoted field')
    push()
    if not records:
        raise ParseError('CSV is empty')
    header = [cell.strip().lower() for cell in records[0][0]]
    return {'header': header, 'rows': [
        {'row_number': index + 2, 'raw': record.strip(),
         'cells': {key: (values[column] if column < len(values) else '').strip()
                   for column, key in enumerate(header)}}
        for index, (values, record) in enumerate(records[1:])
    ]}


def dollars_to_cents(value: str) -> str:
    match = re.fullmatch(r'(-)?\$?([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)(?:\.([0-9]{1,2}))?', value.strip())
    if match is None:
        raise ParseError(f'"{value}" is not a dollar amount')
    cents = int(match[2].replace(',', '')) * 100 + int((match[3] or '').ljust(2, '0'))
    return str(-cents if match[1] else cents)


def _minutes(value: str) -> int:
    if re.fullmatch(r'[0-9]+', value) is None:
        raise ParseError(f'"{value}" is not a whole number of minutes')
    result = int(value)
    if result > 2**32 - 1:
        raise ParseError('Minutes exceed the supported unsigned 32-bit range')
    return result


def _rows(document_id: int, text: str, required: list[str], label: str, convert) -> list[dict]:
    parsed = parse_csv(text)
    missing = [column for column in required if column not in parsed['header']]
    if missing:
        raise ParseError(f'{label} is missing column(s): {", ".join(missing)}')
    output = []
    for row in parsed['rows']:
        try:
            output.append({'document_id': document_id, 'page_or_row': f'row {row["row_number"]}',
                           'excerpt': row['raw'], **convert(row['cells'])})
        except ParseError as error:
            raise ParseError(f'{label} row {row["row_number"]}: {error}') from error
    return output


def parse_timesheet(document_id: int, text: str) -> list[dict]:
    return _rows(document_id, text, ['service_date', 'contractor', 'approved_minutes', 'status'],
                 'Timesheet', lambda c: {
        'contractor': c['contractor'], 'service_date': c['service_date'],
        'approved_minutes': _minutes(c['approved_minutes']),
        'claimed_rate_cents': dollars_to_cents(c['billing_rate']) if c.get('billing_rate') else None,
        'status': c['status'].upper(), 'approved_by': c.get('approved_by', ''),
    })


def parse_invoices(document_id: int, text: str) -> list[dict]:
    return _rows(document_id, text, ['invoice_number', 'contractor', 'service_start', 'service_end',
                                   'minutes', 'amount', 'posting_status'], 'Invoice', lambda c: {
        'invoice_number': c['invoice_number'], 'contractor': c['contractor'],
        'service_start': c['service_start'], 'service_end': c['service_end'],
        'minutes': _minutes(c['minutes']), 'amount_cents': dollars_to_cents(c['amount']),
        'posting_status': c['posting_status'].upper(), 'posted_date': c.get('posted_date', ''),
    })


def parse_ledger(document_id: int, text: str) -> list[dict]:
    return _rows(document_id, text, ['entry_id', 'vendor_id', 'period', 'kind', 'amount', 'status'],
                 'Ledger', lambda c: {
        'entry_id': c['entry_id'], 'vendor_id': c['vendor_id'], 'period': c['period'],
        'kind': c['kind'].upper(), 'amount_cents': dollars_to_cents(c['amount']),
        'status': c['status'].upper(), 'description': c.get('description', ''),
    })


def parse_accrual(document_id: int, text: str) -> list[dict]:
    def invalid_constant(value):
        raise ValueError(f'Invalid JSON constant {value}')

    try:
        accrual = json.loads(text, parse_float=Decimal, parse_constant=invalid_constant)
    except (ValueError, TypeError) as error:
        raise ParseError('Accrual JSON is not valid JSON') from error
    if not isinstance(accrual, dict):
        raise ParseError('Accrual JSON must be an object')
    output = []

    def add(path, field, value, *, converted=None):
        if value is None:
            return
        if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
            raise ParseError(f'accrual {path} must be a scalar string or number')
        excerpt_value = str(value) if isinstance(value, Decimal) else json.dumps(value, ensure_ascii=False)
        output.append({'document_id': document_id, 'page_or_row': f'json $.{path}',
                       'excerpt': f'"{path}": {excerpt_value}', 'field': field,
                       'value': str(value) if converted is None else converted})

    for path in ['entryId', 'vendorId', 'status']:
        add(path, f'accrual.{path}', accrual.get(path))
    if 'amountCents' in accrual:
        value = accrual['amountCents']
        if isinstance(value, bool) or re.fullmatch(r'-?[0-9]+', str(value)) is None:
            raise ParseError('accrual amountCents must be integer cents')
        add('amountCents', 'accrual.amountCents', value)
    elif 'amount' in accrual:
        value = accrual['amount']
        add('amount', 'accrual.amountCents', value, converted=dollars_to_cents(str(value)))
    add('postingPeriod', 'accrual.postingPeriod', accrual.get('postingPeriod'))
    period = accrual.get('servicePeriod')
    if period is not None:
        if not isinstance(period, dict):
            raise ParseError('accrual servicePeriod must be an object')
        for boundary in ('from', 'to'):
            if boundary in period and not isinstance(period[boundary], str):
                raise ParseError(f'accrual servicePeriod.{boundary} must be a string')
        if period.get('from') and period.get('to'):
            add('servicePeriod', 'accrual.servicePeriod', f'{period["from"]}..{period["to"]}')
    if not output:
        raise ParseError('Accrual JSON has no recognized fields')
    return output
