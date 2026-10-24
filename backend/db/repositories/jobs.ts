// Worker side of the job queue (brief p.4 claim_job / heartbeat_job / complete_job).
// Use with connectService('worker'). Shapes follow JobLease / AgentOutput in ./contracts.ts.
// Model calls happen in the worker, never in reducers.

import type { AgentOutput, JobLease } from './contracts';
import type { DbConnection } from '../bindings/index';
import { waitFor } from './client';
import { caseDocumentIds, getCase, listFacts, toEvidenceFact, toJobSummary, type JobRow } from './cases';

export type JobRef = { jobId: bigint; caseId: bigint; expectedRevision: number };
export type LeaseRef = JobRef & { leaseToken: string };

/** JSON Schema for AgentOutput, handed to agents in every lease (brief p.3 "output schema"). */
export const AGENT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['proposedFacts', 'proposedMatches', 'evidenceIds', 'unresolvedQuestions', 'explanation'],
  properties: {
    proposedFacts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['documentId', 'pageOrRow', 'excerpt', 'field', 'value'],
        properties: {
          documentId: { type: 'string', description: 'documents.id, e.g. "12"' },
          pageOrRow: { type: 'string', description: 'e.g. "page 1", "line 6", "row 3"' },
          excerpt: { type: 'string' },
          field: { type: 'string', description: 'e.g. "rate.hourlyCents", "rate.effectiveFrom", "rate.approvedBy"' },
          value: { type: 'string' },
        },
      },
    },
    proposedMatches: {
      type: 'array',
      description: 'MATCHING jobs only',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['workItemId', 'contractId', 'invoiceLineIds', 'ledgerEntryIds', 'evidenceIds'],
        properties: {
          workItemId: { type: 'string' },
          contractId: { type: 'string', description: 'documents.id of the governing contract or amendment' },
          invoiceLineIds: { type: 'array', items: { type: 'string' } },
          ledgerEntryIds: { type: 'array', items: { type: 'string' }, description: 'ledger record ids' },
          evidenceIds: { type: 'array', items: { type: 'string', description: '"doc:N", "fact:N" or "email:N"' } },
        },
      },
    },
    evidenceIds: { type: 'array', items: { type: 'string' } },
    unresolvedQuestions: { type: 'array', items: { type: 'string' } },
    explanation: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'evidenceIds'],
      properties: { summary: { type: 'string' }, evidenceIds: { type: 'array', items: { type: 'string' } } },
    },
  },
} as const;

/** Evidence the job may cite: case documents, vendor mailbox emails/attachments, current facts. */
export function allowedEvidenceIds(conn: DbConnection, caseId: bigint): string[] {
  const c = getCase(conn, caseId);
  if (!c) return [];
  const ids = new Set<string>(caseDocumentIds(conn, caseId).map(id => `doc:${id}`));
  const vendorEmails = [...conn.db.emailsView.iter()].filter(e => e.vendorId === c.vendorId);
  for (const e of vendorEmails) {
    ids.add(`email:${e.id}`);
    for (const a of conn.db.attachmentsView.iter()) if (a.emailId === e.id) ids.add(`doc:${a.documentId}`);
  }
  for (const f of listFacts(conn, caseId)) ids.add(`fact:${f.id}`);
  return [...ids];
}

/** Queued jobs this worker could claim (oldest first). */
export function listClaimableJobs(conn: DbConnection, roles?: string[]): JobRow[] {
  return [...conn.db.jobsView.iter()]
    .filter(j => j.status === 'QUEUED' && (!roles || roles.includes(j.role)))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Claim a job; resolves with the lease if this connection won it, rejects otherwise. */
export async function claimJob(conn: DbConnection, ref: JobRef): Promise<JobLease> {
  const before = [...conn.db.jobsView.iter()].find(j => j.id === ref.jobId)?.attempts ?? 0;
  await conn.reducers.claimJob(ref);
  const me = conn.connectionId.toHexString();
  const job = await waitFor(
    () => [...conn.db.jobsView.iter()].find(j => j.id === ref.jobId && j.status === 'RUNNING' && j.attempts > before),
    `lease on job ${ref.jobId}`
  );
  if (job.leaseConnectionId !== me) throw new Error(`Job ${ref.jobId} was claimed by another worker.`);
  return toJobLease(conn, job);
}

export function toJobLease(conn: DbConnection, job: JobRow): JobLease {
  const policyVersion = [...conn.db.settingsView.iter()][0]?.policyVersion ?? '';
  return {
    ...toJobSummary(job),
    leaseToken: job.leaseToken,
    leaseExpiry: new Date(Number(job.leaseExpiresAtMicros / 1000n)).toISOString(),
    allowedEvidenceIds: allowedEvidenceIds(conn, job.caseId),
    facts: listFacts(conn, job.caseId).map(toEvidenceFact),
    policyVersion,
    outputSchema: AGENT_OUTPUT_SCHEMA,
  };
}

/** Extend a live lease; resolves with the new expiry. */
export async function heartbeatJob(conn: DbConnection, ref: LeaseRef): Promise<{ leaseExpiry: string }> {
  const before = [...conn.db.jobsView.iter()].find(j => j.id === ref.jobId)?.leaseExpiresAtMicros ?? 0n;
  await conn.reducers.heartbeatJob(ref);
  const job = await waitFor(() => [...conn.db.jobsView.iter()].find(j => j.id === ref.jobId && j.leaseExpiresAtMicros > before), 'heartbeat');
  return { leaseExpiry: new Date(Number(job.leaseExpiresAtMicros / 1000n)).toISOString() };
}

/** Submit a validated, evidence-linked result. Resolves with the finished job row. */
export async function completeJob(conn: DbConnection, ref: LeaseRef, modelRun: 'LIVE' | 'REPLAYED', output: AgentOutput): Promise<JobRow> {
  const id = (s: string, what: string) => {
    if (!/^\d+$/.test(s)) throw new Error(`${what} "${s}" must be a numeric id string`);
    return BigInt(s);
  };
  await conn.reducers.completeJob({
    ...ref,
    modelRun,
    proposedFacts: output.proposedFacts.map(f => ({ ...f, documentId: id(f.documentId, 'documentId') })),
    proposedMatches: output.proposedMatches.map(m => ({
      workItemId: id(m.workItemId, 'workItemId'),
      contractDocumentId: id(m.contractId, 'contractId'),
      invoiceLineIds: m.invoiceLineIds.map(x => id(x, 'invoiceLineId')),
      ledgerRecordIds: m.ledgerEntryIds.map(x => id(x, 'ledgerEntryId')),
      evidenceIds: [...m.evidenceIds],
    })),
    evidenceIds: [...output.evidenceIds],
    unresolvedQuestions: [...output.unresolvedQuestions],
    summary: output.explanation.summary,
    explanationEvidenceIds: [...output.explanation.evidenceIds],
  });
  return waitFor(() => [...conn.db.jobsView.iter()].find(j => j.id === ref.jobId && j.status === 'SUCCEEDED'), `job ${ref.jobId} completion`);
}
