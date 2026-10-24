// Cases, evidence, mock mailbox and the job queue (brief p.3-4). This file provides the plug-in
// points agents and the gateway use; it deliberately contains no accounting calculation, proposal,
// approval or export logic (build_proposal, decide_review and *_export come in a later phase).
//
// IDs: rows are referenced by their u64 id. Evidence references are prefixed strings:
// "doc:<documents.id>", "fact:<facts.id>", "email:<emails.id>".

import { ScheduleAt } from 'spacetimedb';
import { SenderError, t } from 'spacetimedb/server';
import spacetimedb, {
  allocations,
  attachments,
  caseDocuments,
  cases,
  emails,
  facts,
  invoiceLines,
  jobResults,
  jobs,
  ledgerRecords,
  sweepSchedule,
  workItems,
} from './schema';
import { companyForService, requireCompany, requireGateway, requireOwner, requireScheduler, requireText, requireWorker, type Ctx, type VCtx } from './auth';

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const CENTS = /^-?(0|[1-9]\d*)$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
/** Required inputs (brief p.1): accrual, contract, approved timesheet, invoices, ledger records. */
const REQUIRED_TYPES = ['ACCRUAL', 'CONTRACT', 'TIMESHEET', 'INVOICE', 'LEDGER'];
// Role order shared with the Python SDK job contract.
const ROLE_ORDER = ['EXTRACTION', 'MATCHING', 'INVESTIGATION'] as const;
const MODEL_RUNS = ['LIVE', 'REPLAYED'];
const SWEEP_INTERVAL_MICROS = 2_000_000n;

type CaseRow = NonNullable<ReturnType<Ctx['db']['cases']['id']['find']>>;
type JobRow = NonNullable<ReturnType<Ctx['db']['jobs']['id']['find']>>;

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new SenderError(message);
}

function getCase(ctx: Ctx, caseId: bigint): CaseRow {
  const c = ctx.db.cases.id.find(caseId);
  check(c, `Case ${caseId} not found.`);
  requireCompany(ctx, c.companyId);
  return c;
}

function setCase(ctx: Ctx, c: CaseRow, patch: Partial<CaseRow>): CaseRow {
  return ctx.db.cases.id.update({ ...c, ...patch, updatedAt: ctx.timestamp });
}

function policy(ctx: Ctx) {
  return ctx.db.jobPolicy.id.find(0) ?? { id: 0, leaseSeconds: 30, maxAttempts: 3 };
}

function enqueueJob(ctx: Ctx, c: CaseRow, role: (typeof ROLE_ORDER)[number]) {
  const jobKey = `${c.id}:${c.inputRevision}:${role}`;
  if (ctx.db.jobs.jobKey.find(jobKey)) return; // deduplicated
  ctx.db.jobs.insert({
    id: 0n,
    jobKey,
    companyId: c.companyId,
    caseId: c.id,
    caseRevision: c.inputRevision,
    role,
    status: 'QUEUED',
    attempts: 0,
    leaseToken: '',
    leaseExpiresAtMicros: 0n,
    leaseConnectionId: '',
    lastError: '',
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
}

/** Documents a case may cite: its imported documents plus the vendor's mailbox attachments. */
function caseDocumentIds(ctx: Ctx, c: CaseRow): Set<bigint> {
  const ids = new Set<bigint>([...ctx.db.caseDocuments.caseId.filter(c.id)].map(l => l.documentId));
  for (const e of ctx.db.emails.vendorId.filter(c.vendorId)) {
    if (e.companyId !== c.companyId) continue;
    for (const a of ctx.db.attachments.emailId.filter(e.id)) ids.add(a.documentId);
  }
  return ids;
}

/** Brief p.3: agent scope is bound to the job — evidence must belong to the case or vendor mailbox. */
function allowedEvidence(ctx: Ctx, c: CaseRow): Set<string> {
  const allowed = new Set<string>();
  for (const id of caseDocumentIds(ctx, c)) allowed.add(`doc:${id}`);
  for (const e of ctx.db.emails.vendorId.filter(c.vendorId)) if (e.companyId === c.companyId) allowed.add(`email:${e.id}`);
  for (const f of ctx.db.facts.caseId.filter(c.id)) if (f.inputRevision === c.inputRevision) allowed.add(`fact:${f.id}`);
  return allowed;
}

function requireEvidence(allowed: Set<string>, ids: string[], where: string) {
  for (const id of ids) check(allowed.has(id), `${where}: evidence "${id}" is outside this job's scope.`);
}

// --- import -----------------------------------------------------------------------------------------

const SourceRef = { documentId: t.u64(), pageOrRow: t.string(), excerpt: t.string() };

const FactIn = t.object('FactIn', { ...SourceRef, field: t.string(), value: t.string() });

const TimesheetRowIn = t.object('TimesheetRowIn', {
  ...SourceRef,
  contractor: t.string(),
  serviceDate: t.string(),
  approvedMinutes: t.u32(),
  claimedRateCents: t.option(t.string()),
  status: t.string(),
  approvedBy: t.string(),
});

const InvoiceRowIn = t.object('InvoiceRowIn', {
  ...SourceRef,
  invoiceNumber: t.string(),
  contractor: t.string(),
  serviceStart: t.string(),
  serviceEnd: t.string(),
  minutes: t.u32(),
  amountCents: t.string(),
  postingStatus: t.string(),
  postedDate: t.string(),
});

const LedgerRowIn = t.object('LedgerRowIn', {
  ...SourceRef,
  entryId: t.string(),
  vendorId: t.string(),
  period: t.string(),
  kind: t.string(),
  amountCents: t.string(),
  status: t.string(),
  description: t.string(),
});

/**
 * Gateway-only (brief p.4 imports.finalize). Creates the case, links its documents, and saves the
 * code-parsed rows of structured files (timesheet/invoice/ledger CSV, accrual JSON) as facts with
 * row references plus typed evidence rows. Idempotent on idempotencyKey.
 */
export const finalizeImport = spacetimedb.reducer(
  {
    companyId: t.string(),
    idempotencyKey: t.string(),
    vendorId: t.string(),
    servicePeriodFrom: t.string(),
    servicePeriodTo: t.string(),
    postingPeriod: t.string(),
    originalStatus: t.string(),
    originalAmountCents: t.string(),
    sourceEntryId: t.string(),
    documentIds: t.array(t.u64()),
    timesheetRows: t.array(TimesheetRowIn),
    invoiceRows: t.array(InvoiceRowIn),
    ledgerRows: t.array(LedgerRowIn),
    otherFacts: t.array(FactIn),
  },
  (ctx, a) => {
    requireGateway(ctx);
    requireCompany(ctx, a.companyId);
    const idempotencyKey = requireText(a.idempotencyKey, 'idempotencyKey', 128);
    const existing = ctx.db.cases.idempotencyKey.find(idempotencyKey);
    if (existing) {
      check(existing.sourceEntryId === a.sourceEntryId, `idempotencyKey "${idempotencyKey}" was used for a different import.`);
      return;
    }
    check(!ctx.db.cases.sourceEntryId.find(a.sourceEntryId), `A case already exists for source entry ${a.sourceEntryId}.`);
    requireText(a.vendorId, 'vendorId', 64);
    requireText(a.sourceEntryId, 'sourceEntryId', 128);
    check(DATE.test(a.servicePeriodFrom) && DATE.test(a.servicePeriodTo) && a.servicePeriodFrom <= a.servicePeriodTo, 'servicePeriod must be a valid date range.');
    check(PERIOD.test(a.postingPeriod), 'postingPeriod must be YYYY-MM.');
    check(a.originalStatus === 'DRAFT' || a.originalStatus === 'POSTED', 'originalStatus must be DRAFT or POSTED.');
    check(CENTS.test(a.originalAmountCents), 'originalAmountCents must be an integer-cent string.');
    check(a.documentIds.length > 0, 'At least one document is required.');

    // Documents: exist, same company, latest version, no duplicates (brief p.1 "check for duplicates").
    const docs = new Map<bigint, string>();
    const hashes = new Set<string>();
    for (const id of a.documentIds) {
      const d = ctx.db.documents.id.find(id);
      check(d && d.companyId === a.companyId, `Document ${id} not found.`);
      check(!docs.has(id), `Document ${id} is listed twice.`);
      check(!hashes.has(d.contentHash), `Document ${id} duplicates the content of another upload.`);
      check(![...ctx.db.documents.iter()].some(n => n.supersedesDocumentId === id), `Document ${id} has a newer version; import the latest.`);
      docs.set(id, d.type);
      hashes.add(d.contentHash);
    }
    const fromDoc = (documentId: bigint, type: string) =>
      check(docs.get(documentId) === type, `Row source document ${documentId} is not a ${type} in this import.`);

    const blockers: string[] = [];
    const present = new Set(docs.values());
    for (const type of REQUIRED_TYPES) if (!present.has(type)) blockers.push(`MISSING_INPUT: ${type} document required`);

    const c = ctx.db.cases.insert({
      id: 0n,
      companyId: a.companyId,
      vendorId: a.vendorId.trim(),
      servicePeriodFrom: a.servicePeriodFrom,
      servicePeriodTo: a.servicePeriodTo,
      postingPeriod: a.postingPeriod,
      originalStatus: a.originalStatus,
      originalAmountCents: a.originalAmountCents,
      sourceEntryId: a.sourceEntryId.trim(),
      inputRevision: 1,
      state: 'IMPORTED',
      currentProposalId: undefined,
      blockers: [],
      idempotencyKey,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    for (const documentId of docs.keys()) ctx.db.caseDocuments.insert({ id: 0n, caseId: c.id, documentId, inputRevision: 1 });

    const fact = (src: { documentId: bigint; pageOrRow: string; excerpt: string }, field: string, value: string, reason = '') =>
      ctx.db.facts.insert({
        id: 0n,
        companyId: a.companyId,
        caseId: c.id,
        inputRevision: 1,
        documentId: src.documentId,
        pageOrRow: requireText(src.pageOrRow, 'pageOrRow', 120),
        excerpt: src.excerpt.slice(0, 1000),
        field,
        value,
        validationStatus: reason ? 'REJECTED' : 'ACCEPTED',
        reason,
        source: 'CODE',
        jobId: undefined,
        modelRun: '',
        createdAt: ctx.timestamp,
      }).id;

    const seenWork = new Set<string>();
    for (const r of a.timesheetRows) {
      fromDoc(r.documentId, 'TIMESHEET');
      check(DATE.test(r.serviceDate), `${r.pageOrRow}: service date must be YYYY-MM-DD.`);
      check(r.approvedMinutes > 0 && r.approvedMinutes <= 1440, `${r.pageOrRow}: approved minutes must be 1-1440.`);
      check(r.claimedRateCents === undefined || CENTS.test(r.claimedRateCents), `${r.pageOrRow}: rate must be integer cents.`);
      const approved = r.status.toUpperCase() === 'APPROVED';
      const factId = fact(r, 'timesheet.row', `${r.contractor}|${r.serviceDate}|${r.approvedMinutes}|${r.claimedRateCents ?? ''}|${r.status}`, approved ? '' : `Status ${r.status} is not approved`);
      if (!approved) continue;
      const key = `${r.contractor}|${r.serviceDate}`;
      if (seenWork.has(key)) blockers.push(`DUPLICATE_WORK: ${r.contractor} on ${r.serviceDate} appears more than once`);
      seenWork.add(key);
      ctx.db.workItems.insert({
        id: 0n,
        caseId: c.id,
        inputRevision: 1,
        factId,
        vendorId: c.vendorId,
        contractor: r.contractor,
        serviceDate: r.serviceDate,
        approvedMinutes: r.approvedMinutes,
        claimedRateCents: r.claimedRateCents,
        approvedBy: r.approvedBy,
      });
    }

    for (const r of a.invoiceRows) {
      fromDoc(r.documentId, 'INVOICE');
      check(DATE.test(r.serviceStart) && DATE.test(r.serviceEnd) && r.serviceStart <= r.serviceEnd, `${r.pageOrRow}: invalid service dates.`);
      check(r.minutes > 0 && CENTS.test(r.amountCents), `${r.pageOrRow}: minutes and integer-cent amount required.`);
      check(r.postingStatus === 'POSTED' || r.postingStatus === 'UNPOSTED', `${r.pageOrRow}: postingStatus must be POSTED or UNPOSTED.`);
      check(r.postingStatus === 'UNPOSTED' || DATE.test(r.postedDate), `${r.pageOrRow}: posted invoices need a posted date.`);
      const factId = fact(r, 'invoice.line', `${r.invoiceNumber}|${r.serviceStart}..${r.serviceEnd}|${r.minutes}|${r.amountCents}|${r.postingStatus}`);
      ctx.db.invoiceLines.insert({ id: 0n, caseId: c.id, inputRevision: 1, factId, ...pick(r, ['invoiceNumber', 'contractor', 'serviceStart', 'serviceEnd', 'minutes', 'amountCents', 'postingStatus', 'postedDate']) });
    }

    for (const r of a.ledgerRows) {
      fromDoc(r.documentId, 'LEDGER');
      check(PERIOD.test(r.period), `${r.pageOrRow}: period must be YYYY-MM.`);
      check(CENTS.test(r.amountCents), `${r.pageOrRow}: amount must be integer cents.`);
      check(['ACCRUAL', 'INVOICE', 'OTHER'].includes(r.kind), `${r.pageOrRow}: kind must be ACCRUAL, INVOICE or OTHER.`);
      check(r.status === 'POSTED' || r.status === 'DRAFT', `${r.pageOrRow}: status must be POSTED or DRAFT.`);
      const factId = fact(r, 'ledger.record', `${r.entryId}|${r.kind}|${r.period}|${r.amountCents}|${r.status}`);
      ctx.db.ledgerRecords.insert({ id: 0n, caseId: c.id, inputRevision: 1, factId, ...pick(r, ['entryId', 'vendorId', 'period', 'kind', 'amountCents', 'status', 'description']) });
    }

    for (const f of a.otherFacts) {
      check(docs.has(f.documentId), `Fact source document ${f.documentId} is not in this import.`);
      fact(f, requireText(f.field, 'field', 120), f.value.slice(0, 1000));
    }

    if (blockers.length > 0) setCase(ctx, c, { state: 'WAITING_FOR_INPUT', blockers });
  }
);

function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = obj[k];
  return out;
}

/** Gateway-only (brief p.4 cases.startReview): IMPORTED -> EXTRACTING and queue the extraction job. */
export const startReview = spacetimedb.reducer({ caseId: t.u64(), expectedRevision: t.u32() }, (ctx, { caseId, expectedRevision }) => {
  requireGateway(ctx);
  const c = getCase(ctx, caseId);
  check(c.inputRevision === expectedRevision, `Stale revision: case is at revision ${c.inputRevision}.`);
  if (c.state !== 'IMPORTED') {
    check(ctx.db.jobs.jobKey.find(`${c.id}:${c.inputRevision}:EXTRACTION`), `Case is ${c.state}; review cannot start.`);
    return; // already started: idempotent
  }
  check(c.blockers.length === 0, 'Case has blockers.');
  enqueueJob(ctx, setCase(ctx, c, { state: 'EXTRACTING' }), 'EXTRACTION');
});

// --- mock mailbox -----------------------------------------------------------------------------------

/** Gateway-only: load a synthetic message into the mock mailbox. Attachments are uploaded documents. */
export const storeEmail = spacetimedb.reducer(
  {
    companyId: t.string(),
    messageKey: t.string(),
    vendorId: t.string(),
    threadId: t.string(),
    sender: t.string(),
    recipients: t.array(t.string()),
    subject: t.string(),
    sentAt: t.string(),
    body: t.string(),
    attachmentDocumentIds: t.array(t.u64()),
  },
  (ctx, a) => {
    requireGateway(ctx);
    requireCompany(ctx, a.companyId);
    const messageKey = requireText(a.messageKey, 'messageKey', 128);
    if (ctx.db.emails.messageKey.find(messageKey)) return; // idempotent
    check(ISO_TIME.test(a.sentAt), 'sentAt must be an ISO 8601 timestamp.');
    check(a.recipients.length > 0, 'At least one recipient is required.');
    for (const id of a.attachmentDocumentIds) {
      const d = ctx.db.documents.id.find(id);
      check(d && d.companyId === a.companyId, `Attachment document ${id} not found.`);
    }
    const email = ctx.db.emails.insert({
      id: 0n,
      companyId: a.companyId,
      vendorId: requireText(a.vendorId, 'vendorId', 64),
      threadId: requireText(a.threadId, 'threadId', 128),
      messageKey,
      sender: requireText(a.sender, 'sender'),
      recipients: a.recipients,
      subject: requireText(a.subject, 'subject', 500),
      sentAt: a.sentAt,
      body: a.body.slice(0, 20000),
    });
    for (const documentId of a.attachmentDocumentIds) ctx.db.attachments.insert({ id: 0n, emailId: email.id, documentId });
  }
);

// --- job queue ----------------------------------------------------------------------------------------

/** Owner-only: lease length and retry bound; also ensures the expired-lease sweep is scheduled. */
export const configureJobPolicy = spacetimedb.reducer({ leaseSeconds: t.u32(), maxAttempts: t.u32() }, (ctx, a) => {
  requireOwner(ctx);
  check(a.leaseSeconds >= 1 && a.leaseSeconds <= 3600, 'leaseSeconds must be 1-3600.');
  check(a.maxAttempts >= 1 && a.maxAttempts <= 10, 'maxAttempts must be 1-10.');
  const row = { id: 0, leaseSeconds: a.leaseSeconds, maxAttempts: a.maxAttempts };
  if (ctx.db.jobPolicy.id.find(0)) ctx.db.jobPolicy.id.update(row);
  else ctx.db.jobPolicy.insert(row);
  if ([...ctx.db.sweepSchedule.iter()].length === 0) {
    ctx.db.sweepSchedule.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(SWEEP_INTERVAL_MICROS) });
  }
});

function failJob(ctx: Ctx, j: JobRow, error: string, c?: CaseRow) {
  ctx.db.jobs.id.update({ ...j, status: 'FAILED', leaseToken: '', leaseConnectionId: '', lastError: error, updatedAt: ctx.timestamp });
  // Brief p.4: provider failure -> RETRYABLE_ERROR (only if the job is for the case's current revision).
  if (c && c.inputRevision === j.caseRevision) setCase(ctx, c, { state: 'RETRYABLE_ERROR', blockers: [...c.blockers, `JOB_FAILED: ${j.role} — ${error}`] });
}

/** Scheduled (brief p.4): requeue expired leases; fail jobs that exhausted their attempts. */
export const sweepExpiredLeases = spacetimedb.reducer({ onSchedule: sweepSchedule }, { timer: sweepSchedule.rowType }, ctx => {
  requireScheduler(ctx);
  const { maxAttempts } = policy(ctx);
  const now = ctx.timestamp.microsSinceUnixEpoch;
  for (const j of ctx.db.jobs.status.filter('RUNNING')) {
    if (j.leaseExpiresAtMicros >= now) continue;
    const c = ctx.db.cases.id.find(j.caseId);
    if (!c || c.inputRevision !== j.caseRevision) failJob(ctx, j, 'Superseded by a newer case revision');
    else if (j.attempts >= maxAttempts) failJob(ctx, j, `Lease expired after ${j.attempts} attempt(s)`, c);
    else ctx.db.jobs.id.update({ ...j, status: 'QUEUED', leaseToken: '', leaseConnectionId: '', lastError: 'Lease expired', updatedAt: ctx.timestamp });
  }
});

function requireCurrentJob(ctx: Ctx, jobId: bigint, caseId: bigint, expectedRevision: number) {
  const j = ctx.db.jobs.id.find(jobId);
  check(j && j.caseId === caseId, `Job ${jobId} not found for case ${caseId}.`);
  const c = getCase(ctx, caseId);
  check(c.inputRevision === expectedRevision && j.caseRevision === expectedRevision, `Stale revision: case is at revision ${c.inputRevision}.`);
  return { j, c };
}

function requireLease(ctx: Ctx, j: JobRow, leaseToken: string) {
  check(j.status === 'RUNNING' && j.leaseToken !== '' && j.leaseToken === leaseToken, 'Stale or unknown lease.');
  check(j.leaseExpiresAtMicros >= ctx.timestamp.microsSinceUnixEpoch, 'Lease expired.');
}

function newLeaseToken(ctx: Ctx): string {
  return [...ctx.random.fill(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Worker-only (brief p.4 claim_job). Workers compete atomically for a QUEUED job (or one whose lease
 * expired); the winner's connection id is recorded so it can find its lease in jobs_view.
 */
export const claimJob = spacetimedb.reducer({ jobId: t.u64(), caseId: t.u64(), expectedRevision: t.u32() }, (ctx, a) => {
  requireWorker(ctx);
  check(ctx.connectionId, 'A connection is required to hold a lease.');
  const { j } = requireCurrentJob(ctx, a.jobId, a.caseId, a.expectedRevision);
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const claimable = j.status === 'QUEUED' || (j.status === 'RUNNING' && j.leaseExpiresAtMicros < now);
  check(claimable, `Job ${j.id} is ${j.status}${j.status === 'RUNNING' ? ' under another lease' : ''}.`);
  const { leaseSeconds, maxAttempts } = policy(ctx);
  check(j.attempts < maxAttempts, `Job ${j.id} has used all ${maxAttempts} attempts.`);
  ctx.db.jobs.id.update({
    ...j,
    status: 'RUNNING',
    attempts: j.attempts + 1,
    leaseToken: newLeaseToken(ctx),
    leaseExpiresAtMicros: now + BigInt(leaseSeconds) * 1_000_000n,
    leaseConnectionId: ctx.connectionId.toHexString(),
    lastError: '',
    updatedAt: ctx.timestamp,
  });
});

/** Worker-only (brief p.4 heartbeat_job): extend a live lease. */
export const heartbeatJob = spacetimedb.reducer(
  { jobId: t.u64(), caseId: t.u64(), expectedRevision: t.u32(), leaseToken: t.string() },
  (ctx, a) => {
    requireWorker(ctx);
    const { j } = requireCurrentJob(ctx, a.jobId, a.caseId, a.expectedRevision);
    requireLease(ctx, j, a.leaseToken);
    const leaseExpiresAtMicros = ctx.timestamp.microsSinceUnixEpoch + BigInt(policy(ctx).leaseSeconds) * 1_000_000n;
    ctx.db.jobs.id.update({ ...j, leaseExpiresAtMicros, updatedAt: ctx.timestamp });
  }
);

const MatchIn = t.object('MatchIn', {
  workItemId: t.u64(),
  contractDocumentId: t.u64(),
  invoiceLineIds: t.array(t.u64()),
  ledgerRecordIds: t.array(t.u64()),
  evidenceIds: t.array(t.string()),
});

/**
 * Worker-only (brief p.4 complete_job; control-plane AgentOutput). Validates scope and shape, saves
 * proposed facts and matches, records the explanation, and advances the pipeline:
 * EXTRACTION -> MATCHING -> INVESTIGATION (when the agent reports unresolved questions).
 * Agents cannot approve, export, change policy or write accounting entries.
 */
export const completeJob = spacetimedb.reducer(
  {
    jobId: t.u64(),
    caseId: t.u64(),
    expectedRevision: t.u32(),
    leaseToken: t.string(),
    modelRun: t.string(),
    proposedFacts: t.array(FactIn),
    proposedMatches: t.array(MatchIn),
    evidenceIds: t.array(t.string()),
    unresolvedQuestions: t.array(t.string()),
    summary: t.string(),
    explanationEvidenceIds: t.array(t.string()),
  },
  (ctx, a) => {
    requireWorker(ctx);
    const { j, c } = requireCurrentJob(ctx, a.jobId, a.caseId, a.expectedRevision);
    requireLease(ctx, j, a.leaseToken);
    check(MODEL_RUNS.includes(a.modelRun), 'modelRun must be LIVE or REPLAYED.');
    requireText(a.summary, 'explanation.summary', 4000);
    check(j.role === 'MATCHING' || a.proposedMatches.length === 0, 'Only MATCHING jobs may propose matches.');

    const allowed = allowedEvidence(ctx, c);
    requireEvidence(allowed, a.evidenceIds, 'evidenceIds');
    requireEvidence(allowed, a.explanationEvidenceIds, 'explanation.evidenceIds');
    const docs = caseDocumentIds(ctx, c);

    for (const f of a.proposedFacts) {
      check(docs.has(f.documentId), `Proposed fact cites document ${f.documentId}, which is outside this case.`);
      ctx.db.facts.insert({
        id: 0n,
        companyId: c.companyId,
        caseId: c.id,
        inputRevision: c.inputRevision,
        documentId: f.documentId,
        pageOrRow: requireText(f.pageOrRow, 'pageOrRow', 120),
        excerpt: f.excerpt.slice(0, 1000),
        field: requireText(f.field, 'field', 120),
        value: f.value.slice(0, 1000),
        validationStatus: 'PROPOSED',
        reason: '',
        source: 'AGENT',
        jobId: j.id,
        modelRun: a.modelRun,
        createdAt: ctx.timestamp,
      });
    }

    const current = <T extends { caseId: bigint; inputRevision: number }>(row: T | undefined) =>
      !!row && row.caseId === c.id && row.inputRevision === c.inputRevision;
    for (const m of a.proposedMatches) {
      check(current(ctx.db.workItems.id.find(m.workItemId) ?? undefined), `Work item ${m.workItemId} is not in this case revision.`);
      const contract = ctx.db.documents.id.find(m.contractDocumentId);
      check(contract && docs.has(contract.id) && ['CONTRACT', 'AMENDMENT', 'OTHER'].includes(contract.type), `Contract document ${m.contractDocumentId} is not a contract or amendment in this case.`);
      for (const id of m.invoiceLineIds) check(current(ctx.db.invoiceLines.id.find(id) ?? undefined), `Invoice line ${id} is not in this case revision.`);
      for (const id of m.ledgerRecordIds) check(current(ctx.db.ledgerRecords.id.find(id) ?? undefined), `Ledger record ${id} is not in this case revision.`);
      requireEvidence(allowed, m.evidenceIds, `match for work item ${m.workItemId}`);
      ctx.db.allocations.insert({
        id: 0n,
        caseId: c.id,
        inputRevision: c.inputRevision,
        jobId: j.id,
        workItemId: m.workItemId,
        contractDocumentId: m.contractDocumentId,
        invoiceLineIds: m.invoiceLineIds,
        ledgerRecordIds: m.ledgerRecordIds,
        evidenceIds: m.evidenceIds,
        validationStatus: 'PROPOSED',
        createdAt: ctx.timestamp,
      });
    }

    const questions = a.unresolvedQuestions.map(q => q.trim()).filter(Boolean);
    ctx.db.jobResults.insert({
      id: 0n,
      jobId: j.id,
      caseId: c.id,
      modelRun: a.modelRun,
      summary: a.summary.trim(),
      explanationEvidenceIds: a.explanationEvidenceIds,
      evidenceIds: a.evidenceIds,
      unresolvedQuestions: questions,
      createdAt: ctx.timestamp,
    });
    ctx.db.jobs.id.update({ ...j, status: 'SUCCEEDED', leaseToken: '', leaseConnectionId: '', updatedAt: ctx.timestamp });

    // Pipeline (brief p.4 state transitions). After the last agent stage the case waits for
    // build_proposal (later phase): all current-revision jobs SUCCEEDED and none queued.
    if (j.role === 'EXTRACTION') {
      enqueueJob(ctx, setCase(ctx, c, { state: 'MATCHING' }), 'MATCHING');
    } else if (j.role === 'MATCHING' && questions.length > 0) {
      enqueueJob(ctx, setCase(ctx, c, { state: 'INVESTIGATING' }), 'INVESTIGATION');
    } else if (j.role === 'INVESTIGATION' && questions.length > 0) {
      // Missing evidence blocks the affected correction (brief p.1).
      setCase(ctx, c, { state: 'WAITING_FOR_INPUT', blockers: [...c.blockers, ...questions.map(q => `MISSING_EVIDENCE: ${q}`)] });
    }
  }
);

// --- views (brief p.3: private tables, sender-checked public views) --------------------------------

function caseIdsFor(ctx: VCtx, companyId: string): bigint[] {
  return [...ctx.db.cases.companyId.filter(companyId)].map(c => c.id);
}

export const casesView = spacetimedb.view({ name: 'cases_view', public: true }, t.array(cases.rowType), ctx => {
  const company = companyForService(ctx);
  return company ? [...ctx.db.cases.companyId.filter(company)] : [];
});

export const caseDocumentsView = spacetimedb.view({ name: 'case_documents_view', public: true }, t.array(caseDocuments.rowType), ctx => {
  const company = companyForService(ctx);
  return company ? caseIdsFor(ctx, company).flatMap(id => [...ctx.db.caseDocuments.caseId.filter(id)]) : [];
});

export const factsView = spacetimedb.view({ name: 'facts_view', public: true }, t.array(facts.rowType), ctx => {
  const company = companyForService(ctx);
  return company ? caseIdsFor(ctx, company).flatMap(id => [...ctx.db.facts.caseId.filter(id)]) : [];
});

export const workItemsView = spacetimedb.view({ name: 'work_items_view', public: true }, t.array(workItems.rowType), ctx => {
  const company = companyForService(ctx);
  return company ? caseIdsFor(ctx, company).flatMap(id => [...ctx.db.workItems.caseId.filter(id)]) : [];
});

export const invoiceLinesView = spacetimedb.view({ name: 'invoice_lines_view', public: true }, t.array(invoiceLines.rowType), ctx => {
  const company = companyForService(ctx);
  return company ? caseIdsFor(ctx, company).flatMap(id => [...ctx.db.invoiceLines.caseId.filter(id)]) : [];
});

export const ledgerRecordsView = spacetimedb.view({ name: 'ledger_records_view', public: true }, t.array(ledgerRecords.rowType), ctx => {
  const company = companyForService(ctx);
  return company ? caseIdsFor(ctx, company).flatMap(id => [...ctx.db.ledgerRecords.caseId.filter(id)]) : [];
});

export const allocationsView = spacetimedb.view({ name: 'allocations_view', public: true }, t.array(allocations.rowType), ctx => {
  const company = companyForService(ctx);
  return company ? caseIdsFor(ctx, company).flatMap(id => [...ctx.db.allocations.caseId.filter(id)]) : [];
});

export const emailsView = spacetimedb.view({ name: 'emails_view', public: true }, t.array(emails.rowType), ctx => {
  const company = companyForService(ctx);
  return ctx.from.emails.where(email => email.companyId.eq(company ?? '')).build();
});

export const attachmentsView = spacetimedb.view({ name: 'attachments_view', public: true }, t.array(attachments.rowType), ctx => {
  const company = companyForService(ctx);
  return ctx.from.emails.where(email => email.companyId.eq(company ?? '')).rightSemijoin(
    ctx.from.attachments, (email, attachment) => email.id.eq(attachment.emailId)).build();
});

export const jobsView = spacetimedb.view({ name: 'jobs_view', public: true }, t.array(jobs.rowType), ctx => {
  const company = companyForService(ctx);
  return company ? caseIdsFor(ctx, company).flatMap(id => [...ctx.db.jobs.caseId.filter(id)]) : [];
});

export const jobResultsView = spacetimedb.view({ name: 'job_results_view', public: true }, t.array(jobResults.rowType), ctx => {
  const company = companyForService(ctx);
  return company ? caseIdsFor(ctx, company).flatMap(id => [...ctx.db.jobResults.caseId.filter(id)]) : [];
});
