// Cases, import and evidence reads for the gateway (and read access for the worker).
// Shapes follow ./contracts.ts.

import type { CaseSummary, EvidenceFact, JobSummary } from './contracts';
import type { DbConnection } from '../bindings/index';
import { waitFor } from './client';
import { readDocument, type DocumentRow } from './documents';
import { parseAccrual, parseInvoices, parseLedger, parseTimesheet, type FactRow, type InvoiceRow, type LedgerRow, type TimesheetRow } from './parsers';

type Rows<T> = T extends { iter(): Iterable<infer R> } ? R : never;
export type CaseRow = Rows<DbConnection['db']['casesView']>;
export type JobRow = Rows<DbConnection['db']['jobsView']>;
export type FactRowDb = Rows<DbConnection['db']['factsView']>;

export type FinalizeImportInput = {
  companyId: string;
  idempotencyKey: string;
  documentIds: bigint[];
  vendorId: string;
  servicePeriod: { from: string; to: string };
  postingPeriod: string;
  originalStatus: 'DRAFT' | 'POSTED';
  originalAmountCents: string;
  sourceEntryId: string;
};

const PARSEABLE = new Set(['text/csv', 'application/json', 'text/plain']);

/** Parse structured documents with code, then create the case atomically (finalize_import). */
export async function finalizeImport(conn: DbConnection, input: FinalizeImportInput): Promise<CaseRow> {
  const existing = findCaseByIdempotencyKey(conn, input.idempotencyKey);
  if (existing) return existing;

  const timesheetRows: TimesheetRow[] = [];
  const invoiceRows: InvoiceRow[] = [];
  const ledgerRows: LedgerRow[] = [];
  const otherFacts: FactRow[] = [];
  for (const id of input.documentIds) {
    let doc: DocumentRow;
    let bytes: Uint8Array;
    try {
      ({ document: doc, bytes } = readDocument(conn, id));
    } catch {
      continue; // the reducer reports missing documents
    }
    if (!PARSEABLE.has(doc.mediaType)) continue; // e.g. PDF timesheets: left for the extraction agent
    const text = new TextDecoder().decode(bytes);
    if (doc.type === 'TIMESHEET') timesheetRows.push(...parseTimesheet(doc.id, text));
    else if (doc.type === 'INVOICE') invoiceRows.push(...parseInvoices(doc.id, text));
    else if (doc.type === 'LEDGER') ledgerRows.push(...parseLedger(doc.id, text));
    else if (doc.type === 'ACCRUAL' && doc.mediaType === 'application/json') otherFacts.push(...parseAccrual(doc.id, text));
  }

  await conn.reducers.finalizeImport({
    companyId: input.companyId,
    idempotencyKey: input.idempotencyKey,
    vendorId: input.vendorId,
    servicePeriodFrom: input.servicePeriod.from,
    servicePeriodTo: input.servicePeriod.to,
    postingPeriod: input.postingPeriod,
    originalStatus: input.originalStatus,
    originalAmountCents: input.originalAmountCents,
    sourceEntryId: input.sourceEntryId,
    documentIds: input.documentIds,
    timesheetRows,
    invoiceRows,
    ledgerRows,
    otherFacts,
  });
  return waitFor(() => findCaseByIdempotencyKey(conn, input.idempotencyKey), `case ${input.idempotencyKey}`);
}

/** IMPORTED -> EXTRACTING; queues the EXTRACTION job. Resolves once the change is replicated. */
export async function startReview(conn: DbConnection, caseId: bigint, expectedRevision: number): Promise<CaseRow> {
  await conn.reducers.startReview({ caseId, expectedRevision });
  return waitFor(() => {
    const c = getCase(conn, caseId);
    return c && c.state !== 'IMPORTED' ? c : undefined;
  }, `case ${caseId} review start`);
}

export function findCaseByIdempotencyKey(conn: DbConnection, key: string): CaseRow | undefined {
  return [...conn.db.casesView.iter()].find(c => c.idempotencyKey === key);
}

export function getCase(conn: DbConnection, caseId: bigint): CaseRow | undefined {
  return [...conn.db.casesView.iter()].find(c => c.id === caseId);
}

export function listCases(conn: DbConnection, filter: { state?: string } = {}): CaseRow[] {
  return [...conn.db.casesView.iter()].filter(c => !filter.state || c.state === filter.state).sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function listJobs(conn: DbConnection, caseId: bigint): JobRow[] {
  return [...conn.db.jobsView.iter()].filter(j => j.caseId === caseId).sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Facts for the case's current revision (CODE facts from import + AGENT proposals). */
export function listFacts(conn: DbConnection, caseId: bigint): FactRowDb[] {
  const c = getCase(conn, caseId);
  if (!c) return [];
  return [...conn.db.factsView.iter()].filter(f => f.caseId === caseId && f.inputRevision === c.inputRevision).sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Documents imported into a case. */
export function caseDocumentIds(conn: DbConnection, caseId: bigint): bigint[] {
  return [...conn.db.caseDocumentsView.iter()].filter(l => l.caseId === caseId).map(l => l.documentId);
}

/**
 * Pipeline hand-off point for build_proposal (later phase): the last agent stage finished and no
 * job is queued or running for the current revision.
 */
export function isAwaitingProposal(conn: DbConnection, caseId: bigint): boolean {
  const c = getCase(conn, caseId);
  if (!c || !['MATCHING', 'INVESTIGATING'].includes(c.state)) return false;
  const jobs = listJobs(conn, caseId).filter(j => j.caseRevision === c.inputRevision);
  return jobs.length > 0 && jobs.every(j => j.status === 'SUCCEEDED');
}

// --- control-plane shapes ---------------------------------------------------------------------------

export function toCaseSummary(c: CaseRow): CaseSummary {
  return {
    id: String(c.id),
    companyId: c.companyId,
    vendorId: c.vendorId,
    servicePeriod: { from: c.servicePeriodFrom, to: c.servicePeriodTo },
    postingPeriod: c.postingPeriod,
    originalStatus: c.originalStatus as CaseSummary['originalStatus'],
    originalAmountCents: c.originalAmountCents,
    sourceEntryId: c.sourceEntryId,
    inputRevision: c.inputRevision,
    state: c.state as CaseSummary['state'],
    currentProposalId: c.currentProposalId === undefined ? null : String(c.currentProposalId),
    blockers: c.blockers,
  };
}

export function toJobSummary(j: JobRow): JobSummary {
  return {
    id: String(j.id),
    caseId: String(j.caseId),
    caseRevision: j.caseRevision,
    role: j.role as JobSummary['role'],
    status: j.status as JobSummary['status'],
    attempts: j.attempts,
  };
}

export function toEvidenceFact(f: FactRowDb): EvidenceFact {
  return {
    id: String(f.id),
    documentId: String(f.documentId),
    pageOrRow: f.pageOrRow,
    excerpt: f.excerpt,
    field: f.field,
    value: f.value,
    validationStatus: f.validationStatus as EvidenceFact['validationStatus'],
  };
}
