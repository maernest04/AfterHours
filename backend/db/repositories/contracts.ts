// Payload shapes for cases, jobs and agent output. These are the same shapes the (since removed)
// TypeScript control-plane package defined, kept here so the job/lease/agent-output contract
// stays stable for whatever calls the database: the Python API, agent workers, tests.
// Transport types only; the database tables are in spacetimedb/src/schema.ts.
//
// Conventions: IDs are decimal strings, money is signed integer-cent strings, dates are
// YYYY-MM-DD, periods are YYYY-MM, evidence references are "doc:N", "fact:N" and "email:N".

export type Id = string;
export type Timestamp = string;

export type AgentRole = 'EXTRACTION' | 'MATCHING' | 'INVESTIGATION';
export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type CaseState =
  | 'IMPORTED' | 'EXTRACTING' | 'MATCHING' | 'INVESTIGATING'
  | 'READY_FOR_REVIEW' | 'APPROVED' | 'EXPORTED' | 'WAITING_FOR_INPUT'
  | 'VERIFIED_NO_CHANGE' | 'NEEDS_REVISION' | 'RETRYABLE_ERROR' | 'FAILED';

export interface DateRange { from: string; to: string }

export interface CaseSummary {
  id: Id;
  companyId: Id;
  vendorId: Id;
  servicePeriod: DateRange;
  postingPeriod: string;
  originalStatus: 'DRAFT' | 'POSTED';
  originalAmountCents: string;
  sourceEntryId: Id;
  inputRevision: number;
  state: CaseState;
  currentProposalId: Id | null;
  blockers: readonly string[];
}

export interface EvidenceFact {
  id: Id;
  documentId: Id;
  pageOrRow: string;
  excerpt: string;
  field: string;
  value: string;
  validationStatus: 'PROPOSED' | 'ACCEPTED' | 'REJECTED';
}

export interface CandidateMatch {
  workItemId: Id;
  /** documents.id of the governing contract or amendment. */
  contractId: Id;
  invoiceLineIds: readonly Id[];
  /** ledger_records ids. */
  ledgerEntryIds: readonly Id[];
  evidenceIds: readonly Id[];
}

/** What an agent submits when it completes a job. */
export interface AgentOutput {
  proposedFacts: readonly Omit<EvidenceFact, 'id' | 'validationStatus'>[];
  proposedMatches: readonly CandidateMatch[];
  evidenceIds: readonly Id[];
  unresolvedQuestions: readonly string[];
  explanation: { summary: string; evidenceIds: readonly Id[] };
}

export interface JobSummary {
  id: Id;
  caseId: Id;
  caseRevision: number;
  role: AgentRole;
  status: JobStatus;
  attempts: number;
}

/** What a worker receives when it wins a claim. */
export interface JobLease extends JobSummary {
  leaseToken: string;
  leaseExpiry: Timestamp;
  allowedEvidenceIds: readonly Id[];
  facts: readonly EvidenceFact[];
  policyVersion: string;
  outputSchema: Readonly<Record<string, unknown>>;
}
