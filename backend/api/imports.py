"""Conservative file-only import inference, completed before any storage writes."""
import csv
from dataclasses import dataclass
from datetime import date
import hashlib
import io
import json
import re
from typing import Sequence, TYPE_CHECKING

from afterhours_db.parsers import parse_accrual, parse_invoices, parse_ledger, parse_timesheet

if TYPE_CHECKING:
    from .service import ReviewUpload


class InvalidUpload(ValueError):
    pass


@dataclass(frozen=True)
class ImportDocument:
    filename: str
    media_type: str
    type: str
    data: bytes


@dataclass(frozen=True)
class ReviewImport:
    documents: list[ImportDocument]
    metadata: dict[str, str]


HEADERS = {
    'TIMESHEET': {'service_date', 'contractor', 'approved_minutes', 'status'},
    'INVOICE': {'invoice_number', 'contractor', 'service_start', 'service_end', 'minutes', 'amount', 'posting_status'},
    'LEDGER': {'entry_id', 'vendor_id', 'period', 'kind', 'amount', 'status'},
}
PARSERS = {'TIMESHEET': parse_timesheet, 'INVOICE': parse_invoices, 'LEDGER': parse_ledger}


def _date(value: str):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise InvalidUpload('Dates must use YYYY-MM-DD.')
    date.fromisoformat(value)


def _period(value: str):
    _date(value + '-01')


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InvalidUpload('JSON object keys must be unique.')
        result[key] = value
    return result


def _metadata(text: str) -> dict[str, str]:
    raw = json.loads(text, object_pairs_hook=_unique_object)
    if not isinstance(raw, dict) or raw.get('currency') != 'USD':
        raise InvalidUpload('Accrual JSON must declare currency USD.')
    if 'amount' in raw and 'amountCents' in raw:
        raise InvalidUpload('Specify only one accrual amount representation.')
    facts = {row['field']: row['value'] for row in parse_accrual(0, text)}
    names = {'vendor_id': 'vendorId', 'source_entry_id': 'entryId', 'posting_period': 'postingPeriod',
             'original_status': 'status', 'original_amount_cents': 'amountCents'}
    metadata = {name: facts['accrual.' + field] for name, field in names.items()}
    start, end = facts['accrual.servicePeriod'].split('..')
    _date(start)
    _date(end)
    _period(metadata['posting_period'])
    if start > end:
        raise InvalidUpload('Accrual service period is reversed.')
    for field, limit in [('vendor_id', 64), ('source_entry_id', 128)]:
        value = metadata[field]
        if (not isinstance(raw[names[field]], str) or not value.strip()
                or len(value.strip().encode('utf-16-le')) // 2 > limit):
            raise InvalidUpload('Accrual vendorId and entryId must be nonempty bounded strings.')
        metadata[field] = value.strip()
    if metadata['original_status'] not in {'DRAFT', 'POSTED'}:
        raise InvalidUpload('Accrual status must be DRAFT or POSTED.')
    if not re.fullmatch(r'-?(0|[1-9][0-9]*)', metadata['original_amount_cents']):
        raise InvalidUpload('Accrual amount must be canonical integer cents.')
    metadata.update(service_period_from=start, service_period_to=end)
    return metadata


def prepare_import(files: Sequence['ReviewUpload']) -> ReviewImport:
    documents, hashes, metadata, seen_work = [], set(), None, set()
    total = 0
    try:
        for upload in files:
            if not 1 <= len(upload.filename.strip().encode('utf-16-le')) // 2 <= 255:
                raise InvalidUpload('Upload filenames must contain 1–255 characters.')
            data = upload.stream.read(10 * 1024 * 1024 + 1)
            total += len(data)
            if not data or total > 10 * 1024 * 1024:
                raise InvalidUpload('Uploads must be nonempty and total at most 10 MiB.')
            digest = hashlib.sha256(data).digest()
            if digest in hashes:
                raise InvalidUpload('Duplicate file contents are not supported.')
            hashes.add(digest)
            text = data.decode('utf-8-sig')
            if upload.media_type == 'application/json':
                if metadata is not None:
                    raise InvalidUpload('Supply exactly one accrual JSON document.')
                metadata = _metadata(text)
                kind = 'ACCRUAL'
            elif upload.media_type == 'text/csv':
                records = list(csv.reader(io.StringIO(text), strict=True))
                records = [row for row in records if any(cell.strip() for cell in row)]
                header = [cell.strip().lower() for cell in records[0]]
                if len(set(header)) != len(header) or any(not cell for cell in header):
                    raise InvalidUpload('CSV column names must be nonempty and unique.')
                if any(len(row) != len(header) for row in records[1:]):
                    raise InvalidUpload('CSV rows must match the header width.')
                matches = [kind for kind, required in HEADERS.items() if required <= set(header)]
                if len(matches) != 1:
                    raise InvalidUpload('CSV headers must identify exactly one timesheet, invoice or ledger format.')
                kind = matches[0]
                rows = PARSERS[kind](0, text)
                for row in rows:
                    if kind == 'TIMESHEET':
                        _date(row['service_date'])
                        if not 1 <= row['approved_minutes'] <= 1440 or not row['contractor']:
                            raise InvalidUpload('Timesheet rows require a contractor and 1–1440 minutes.')
                        key = (row['contractor'], row['service_date'])
                        if row['status'] == 'APPROVED':
                            if key in seen_work:
                                raise InvalidUpload('Duplicate approved contractor/date work is ambiguous.')
                            seen_work.add(key)
                    elif kind == 'INVOICE':
                        _date(row['service_start'])
                        _date(row['service_end'])
                        if (row['service_start'] > row['service_end'] or row['minutes'] <= 0
                                or row['posting_status'] not in {'POSTED', 'UNPOSTED'}):
                            raise InvalidUpload('Invoice row has invalid dates, minutes or posting status.')
                        if row['posting_status'] == 'POSTED':
                            _date(row['posted_date'])
                    else:
                        _period(row['period'])
                        if row['kind'] not in {'ACCRUAL', 'INVOICE', 'OTHER'} or row['status'] not in {'DRAFT', 'POSTED'}:
                            raise InvalidUpload('Ledger row has invalid kind or status.')
            elif upload.media_type == 'text/plain':
                # Titles, never filenames or arbitrary mentions in the body, classify text.
                lines = [line.strip().upper() for line in text.splitlines() if line.strip()]
                if lines and lines[0] == 'SYNTHETIC DEMO DOCUMENT - NOT A REAL CONTRACT':
                    lines.pop(0)
                title = lines[0] if lines else ''
                if title in {'MASTER SERVICES AGREEMENT', 'CONTRACT'}:
                    kind = 'CONTRACT'
                elif re.fullmatch(r'AMENDMENT(?: NO\. \d+ TO MASTER SERVICES AGREEMENT)?', title):
                    kind = 'AMENDMENT'
                else:
                    raise InvalidUpload('Plain text requires an explicit supported contract or amendment title.')
            else:
                raise InvalidUpload('PDF and unclassified file contents are not supported for automatic imports.')
            documents.append(ImportDocument(upload.filename, upload.media_type, kind, data))
        required = {'ACCRUAL', 'CONTRACT', 'TIMESHEET', 'INVOICE', 'LEDGER'}
        missing = required - {document.type for document in documents}
        if missing:
            raise InvalidUpload('Missing required document types: ' + ', '.join(sorted(missing)))
        return ReviewImport(documents, metadata)
    except InvalidUpload:
        raise
    except (ValueError, KeyError, IndexError, TypeError, csv.Error) as error:
        raise InvalidUpload('Invalid structured upload; check required fields, dates and exact amounts.') from error
