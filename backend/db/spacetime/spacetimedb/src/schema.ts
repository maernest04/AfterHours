// Document-storage schema, following the implementation brief (Accrual_Correction_Brief, p.3):
// - Tables stay private. Clients read through views that check ctx.sender against the configured
//   gateway/worker identities (see index.ts).
// - Original file bytes live on a persistent server volume; documents reference them by
//   storageKey and contentHash. No file bytes are stored in SpacetimeDB.
// - Every business record belongs to the fixed demo company (settings.companyId).

import { schema, table, t } from 'spacetimedb/server';

export const Account = t.object('Account', { code: t.string(), name: t.string() });

/** Private. The identity that published the module; only it may configure settings and identities. */
const moduleOwner = table(
  { name: 'module_owner' },
  {
    id: t.u32().primaryKey(),
    identity: t.identity(),
  }
);

/** Private. Single row (id = 0): fixed demo company and accounting policy. No memberships table. */
const settings = table(
  { name: 'settings' },
  {
    id: t.u32().primaryKey(),
    companyId: t.string(),
    currency: t.string(),
    expenseAccount: Account,
    liabilityAccount: Account,
    policyVersion: t.string(),
  }
);

/** Private. Configured server identities: GATEWAY (Next.js server) and WORKER (Node agent worker). */
const serviceIdentity = table(
  { name: 'service_identity' },
  {
    identity: t.identity().primaryKey(),
    role: t.string(),
    label: t.string(),
    createdAt: t.timestamp(),
  }
);

/**
 * Private. One version of a source document. Bytes are on the file store at `storageKey`.
 * Rows are never updated or deleted; a new version points at its predecessor.
 */
const documents = table(
  { name: 'documents' },
  {
    id: t.u64().primaryKey().autoInc(),
    companyId: t.string().index('btree'),
    storageKey: t.string(),
    type: t.string().index('btree'),
    version: t.u32(),
    contentHash: t.string().index('btree'),
    byteLength: t.u32(),
    mediaType: t.string(),
    originalFilename: t.string(),
    referenceId: t.option(t.string()),
    sourceLabel: t.string(),
    supersedesDocumentId: t.option(t.u64()),
    uploadKey: t.string().unique(),
    createdAt: t.timestamp(),
  }
);

// --- cases and evidence (brief p.3 "Core records") ----------------------------------------------
// Money is integer-cent strings, durations integer minutes, dates YYYY-MM-DD, periods YYYY-MM.
// Evidence rows carry the case inputRevision they were derived from.

/** An existing accrual under review. State values follow the brief's state transitions (p.4). */
const cases = table(
  { name: 'cases' },
  {
    id: t.u64().primaryKey().autoInc(),
    companyId: t.string().index('btree'),
    vendorId: t.string(),
    servicePeriodFrom: t.string(),
    servicePeriodTo: t.string(),
    postingPeriod: t.string(),
    originalStatus: t.string(),
    originalAmountCents: t.string(),
    sourceEntryId: t.string().unique(),
    inputRevision: t.u32(),
    state: t.string().index('btree'),
    currentProposalId: t.option(t.u64()),
    blockers: t.array(t.string()),
    idempotencyKey: t.string().unique(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/** Documents imported into a case (documents rows themselves stay immutable). */
const caseDocuments = table(
  { name: 'case_documents' },
  {
    id: t.u64().primaryKey().autoInc(),
    caseId: t.u64().index('btree'),
    documentId: t.u64().index('btree'),
    inputRevision: t.u32(),
  }
);

/** Extracted fact with its source reference. CODE facts come from structured-file parsing at import;
 *  AGENT facts are proposals submitted through complete_job. */
const facts = table(
  { name: 'facts' },
  {
    id: t.u64().primaryKey().autoInc(),
    companyId: t.string(),
    caseId: t.u64().index('btree'),
    inputRevision: t.u32(),
    documentId: t.u64(),
    pageOrRow: t.string(),
    excerpt: t.string(),
    field: t.string(),
    value: t.string(),
    validationStatus: t.string(),
    reason: t.string(),
    source: t.string(),
    jobId: t.option(t.u64()),
    modelRun: t.string(),
    createdAt: t.timestamp(),
  }
);

const workItems = table(
  { name: 'work_items' },
  {
    id: t.u64().primaryKey().autoInc(),
    caseId: t.u64().index('btree'),
    inputRevision: t.u32(),
    factId: t.u64(),
    vendorId: t.string(),
    contractor: t.string(),
    serviceDate: t.string(),
    approvedMinutes: t.u32(),
    claimedRateCents: t.option(t.string()),
    approvedBy: t.string(),
  }
);

const invoiceLines = table(
  { name: 'invoice_lines' },
  {
    id: t.u64().primaryKey().autoInc(),
    caseId: t.u64().index('btree'),
    inputRevision: t.u32(),
    factId: t.u64(),
    invoiceNumber: t.string(),
    contractor: t.string(),
    serviceStart: t.string(),
    serviceEnd: t.string(),
    minutes: t.u32(),
    amountCents: t.string(),
    postingStatus: t.string(),
    postedDate: t.string(),
  }
);

/** "Ledger records showing what is already recorded" (brief p.1). */
const ledgerRecords = table(
  { name: 'ledger_records' },
  {
    id: t.u64().primaryKey().autoInc(),
    caseId: t.u64().index('btree'),
    inputRevision: t.u32(),
    factId: t.u64(),
    entryId: t.string(),
    vendorId: t.string(),
    period: t.string(),
    kind: t.string(),
    amountCents: t.string(),
    status: t.string(),
    description: t.string(),
  }
);

/** Proposed links between work, contracts, invoices and ledger records (CandidateMatch). */
const allocations = table(
  { name: 'allocations' },
  {
    id: t.u64().primaryKey().autoInc(),
    caseId: t.u64().index('btree'),
    inputRevision: t.u32(),
    jobId: t.u64(),
    workItemId: t.u64(),
    contractDocumentId: t.u64(),
    invoiceLineIds: t.array(t.u64()),
    ledgerRecordIds: t.array(t.u64()),
    evidenceIds: t.array(t.string()),
    validationStatus: t.string(),
    createdAt: t.timestamp(),
  }
);

// --- mock finance mailbox (brief p.1/p.3; synthetic, never Gmail) ------------------------------

const emails = table(
  { name: 'emails' },
  {
    id: t.u64().primaryKey().autoInc(),
    companyId: t.string().index('btree'),
    vendorId: t.string().index('btree'),
    threadId: t.string().index('btree'),
    messageKey: t.string().unique(),
    sender: t.string(),
    recipients: t.array(t.string()),
    subject: t.string(),
    sentAt: t.string(),
    body: t.string(),
  }
);

const attachments = table(
  { name: 'attachments' },
  {
    id: t.u64().primaryKey().autoInc(),
    emailId: t.u64().index('btree'),
    documentId: t.u64(),
  }
);

// --- jobs (brief p.3-4: leases, bounded retries, scheduled sweep) -------------------------------

/** jobKey = caseId:revision:role, so job creation is deduplicated. */
const jobs = table(
  { name: 'jobs' },
  {
    id: t.u64().primaryKey().autoInc(),
    jobKey: t.string().unique(),
    companyId: t.string(),
    caseId: t.u64().index('btree'),
    caseRevision: t.u32(),
    role: t.string(),
    status: t.string().index('btree'),
    attempts: t.u32(),
    leaseToken: t.string(),
    leaseExpiresAtMicros: t.i64(),
    leaseConnectionId: t.string(),
    lastError: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/** Structured explanation and open questions submitted with a completed job. */
const jobResults = table(
  { name: 'job_results' },
  {
    id: t.u64().primaryKey().autoInc(),
    jobId: t.u64().unique(),
    caseId: t.u64().index('btree'),
    modelRun: t.string(),
    summary: t.string(),
    explanationEvidenceIds: t.array(t.string()),
    evidenceIds: t.array(t.string()),
    unresolvedQuestions: t.array(t.string()),
    createdAt: t.timestamp(),
  }
);

/** Private. Lease length and retry bound (single row, id = 0). */
const jobPolicy = table(
  { name: 'job_policy' },
  {
    id: t.u32().primaryKey(),
    leaseSeconds: t.u32(),
    maxAttempts: t.u32(),
  }
);

/** Private. Drives the scheduled sweep that requeues expired leases. */
const sweepSchedule = table(
  { name: 'sweep_schedule' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

const spacetimedb = schema({
  moduleOwner,
  settings,
  serviceIdentity,
  documents,
  cases,
  caseDocuments,
  facts,
  workItems,
  invoiceLines,
  ledgerRecords,
  allocations,
  emails,
  attachments,
  jobs,
  jobResults,
  jobPolicy,
  sweepSchedule,
});
export default spacetimedb;
export {
  documents,
  settings,
  cases,
  caseDocuments,
  facts,
  workItems,
  invoiceLines,
  ledgerRecords,
  allocations,
  emails,
  attachments,
  jobs,
  jobResults,
  sweepSchedule,
};
