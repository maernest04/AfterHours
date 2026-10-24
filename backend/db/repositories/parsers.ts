// Code parsing of structured inputs at import (brief p.2: "parse structured files with code").
// The gateway runs these before finalize_import; every row keeps a "row N" reference and the raw
// line as its excerpt. Unstructured documents (contracts, amendments, PDFs) are left to agents.
//
// Expected columns (headers are case-insensitive; extra columns are ignored):
//   TIMESHEET csv: service_date, contractor, approved_minutes, status, [billing_rate], [approved_by]
//   INVOICE   csv: invoice_number, contractor, service_start, service_end, minutes, amount, posting_status, [posted_date]
//   LEDGER    csv: entry_id, vendor_id, period, kind, amount, status, [description]
//   ACCRUAL  json: { entryId, vendorId, status, amountCents | amount, postingPeriod?, servicePeriod?: {from,to} }

export type SourceRef = { documentId: bigint; pageOrRow: string; excerpt: string };
export type TimesheetRow = SourceRef & {
  contractor: string;
  serviceDate: string;
  approvedMinutes: number;
  claimedRateCents: string | undefined;
  status: string;
  approvedBy: string;
};
export type InvoiceRow = SourceRef & {
  invoiceNumber: string;
  contractor: string;
  serviceStart: string;
  serviceEnd: string;
  minutes: number;
  amountCents: string;
  postingStatus: string;
  postedDate: string;
};
export type LedgerRow = SourceRef & {
  entryId: string;
  vendorId: string;
  period: string;
  kind: string;
  amountCents: string;
  status: string;
  description: string;
};
export type FactRow = SourceRef & { field: string; value: string };

export class ParseError extends Error {}

/** RFC 4180-style CSV: quoted fields, escaped quotes, CRLF/LF. */
export function parseCsv(text: string): { header: string[]; rows: Array<{ rowNumber: number; raw: string; cells: Record<string, string> }> } {
  const records: Array<{ cells: string[]; raw: string }> = [];
  let field = '';
  let cells: string[] = [];
  let raw = '';
  let quoted = false;
  const push = () => {
    cells.push(field);
    if (cells.some(c => c.trim() !== '')) records.push({ cells, raw });
    cells = [];
    field = '';
    raw = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      raw += ch;
      if (ch === '"' && text[i + 1] === '"') { field += '"'; raw += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') { quoted = true; raw += ch; }
    else if (ch === ',') { cells.push(field); field = ''; raw += ch; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; push(); }
    else { field += ch; raw += ch; }
  }
  push();
  const [head, ...body] = records;
  if (!head) throw new ParseError('CSV is empty');
  const header = head.cells.map(h => h.trim().toLowerCase());
  return {
    header,
    rows: body.map((r, i) => ({
      rowNumber: i + 2,
      raw: r.raw.trim(),
      cells: Object.fromEntries(header.map((k, j) => [k, (r.cells[j] ?? '').trim()])),
    })),
  };
}

/** "7,000.00" / "$110" -> "700000" / "11000". Rejects more than two decimals. */
export function dollarsToCents(input: string): string {
  const m = /^(-)?\$?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) throw new ParseError(`"${input}" is not a dollar amount`);
  const cents = BigInt(m[2].replace(/,/g, '')) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return (m[1] && cents !== 0n ? -cents : cents).toString();
}

function requireColumns(header: string[], required: string[], what: string) {
  const missing = required.filter(c => !header.includes(c));
  if (missing.length) throw new ParseError(`${what} is missing column(s): ${missing.join(', ')}`);
}

function rowError(what: string, rowNumber: number, err: unknown): never {
  throw new ParseError(`${what} row ${rowNumber}: ${err instanceof Error ? err.message : String(err)}`);
}

function minutes(value: string): number {
  if (!/^\d+$/.test(value)) throw new ParseError(`"${value}" is not a whole number of minutes`);
  return Number(value);
}

export function parseTimesheet(documentId: bigint, text: string): TimesheetRow[] {
  const { header, rows } = parseCsv(text);
  requireColumns(header, ['service_date', 'contractor', 'approved_minutes', 'status'], 'Timesheet');
  return rows.map(r => {
    try {
      const c = r.cells;
      return {
        documentId,
        pageOrRow: `row ${r.rowNumber}`,
        excerpt: r.raw,
        contractor: c.contractor,
        serviceDate: c.service_date,
        approvedMinutes: minutes(c.approved_minutes),
        claimedRateCents: c.billing_rate ? dollarsToCents(c.billing_rate) : undefined,
        status: c.status.toUpperCase(),
        approvedBy: c.approved_by ?? '',
      };
    } catch (err) {
      return rowError('Timesheet', r.rowNumber, err);
    }
  });
}

export function parseInvoices(documentId: bigint, text: string): InvoiceRow[] {
  const { header, rows } = parseCsv(text);
  requireColumns(header, ['invoice_number', 'contractor', 'service_start', 'service_end', 'minutes', 'amount', 'posting_status'], 'Invoice');
  return rows.map(r => {
    try {
      const c = r.cells;
      return {
        documentId,
        pageOrRow: `row ${r.rowNumber}`,
        excerpt: r.raw,
        invoiceNumber: c.invoice_number,
        contractor: c.contractor,
        serviceStart: c.service_start,
        serviceEnd: c.service_end,
        minutes: minutes(c.minutes),
        amountCents: dollarsToCents(c.amount),
        postingStatus: c.posting_status.toUpperCase(),
        postedDate: c.posted_date ?? '',
      };
    } catch (err) {
      return rowError('Invoice', r.rowNumber, err);
    }
  });
}

export function parseLedger(documentId: bigint, text: string): LedgerRow[] {
  const { header, rows } = parseCsv(text);
  requireColumns(header, ['entry_id', 'vendor_id', 'period', 'kind', 'amount', 'status'], 'Ledger');
  return rows.map(r => {
    try {
      const c = r.cells;
      return {
        documentId,
        pageOrRow: `row ${r.rowNumber}`,
        excerpt: r.raw,
        entryId: c.entry_id,
        vendorId: c.vendor_id,
        period: c.period,
        kind: c.kind.toUpperCase(),
        amountCents: dollarsToCents(c.amount),
        status: c.status.toUpperCase(),
        description: c.description ?? '',
      };
    } catch (err) {
      return rowError('Ledger', r.rowNumber, err);
    }
  });
}

/** Accrual export (JSON) -> accrual.* facts with JSON-path references. */
export function parseAccrual(documentId: bigint, text: string): FactRow[] {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ParseError('Accrual JSON is not valid JSON');
  }
  const out: FactRow[] = [];
  const add = (path: string, field: string, value: unknown) => {
    if (value === undefined || value === null) return;
    out.push({ documentId, pageOrRow: `json $.${path}`, excerpt: `"${path}": ${JSON.stringify(value)}`, field, value: String(value) });
  };
  add('entryId', 'accrual.entryId', json.entryId);
  add('vendorId', 'accrual.vendorId', json.vendorId);
  add('status', 'accrual.status', json.status);
  if (json.amountCents !== undefined) {
    if (!/^-?\d+$/.test(String(json.amountCents))) throw new ParseError('accrual amountCents must be integer cents');
    add('amountCents', 'accrual.amountCents', json.amountCents);
  } else if (json.amount !== undefined) {
    out.push({ documentId, pageOrRow: 'json $.amount', excerpt: `"amount": ${JSON.stringify(json.amount)}`, field: 'accrual.amountCents', value: dollarsToCents(String(json.amount)) });
  }
  add('postingPeriod', 'accrual.postingPeriod', json.postingPeriod);
  const sp = json.servicePeriod as { from?: string; to?: string } | undefined;
  if (sp?.from && sp?.to) add('servicePeriod', 'accrual.servicePeriod', `${sp.from}..${sp.to}`);
  if (out.length === 0) throw new ParseError('Accrual JSON has no recognized fields');
  return out;
}
