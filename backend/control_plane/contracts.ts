/** Transport contracts only, not database schemas or runtime validators. */
export type Id = string;
/** Signed base-10 integer cents, never floating-point dollars. Validate at runtime. */
export type MoneyCents = string;
export type Timestamp = string;
export type AgentRole = "EXTRACTION" | "MATCHING" | "INVESTIGATION";
export type CaseState =
  | "IMPORTED" | "EXTRACTING" | "MATCHING" | "INVESTIGATING"
  | "READY_FOR_REVIEW" | "APPROVED" | "EXPORTED" | "WAITING_FOR_INPUT"
  | "VERIFIED_NO_CHANGE" | "NEEDS_REVISION" | "RETRYABLE_ERROR" | "FAILED";
export type JobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type DocumentType =
  | "ACCRUAL" | "CONTRACT" | "AMENDMENT" | "TIMESHEET" | "INVOICE" | "LEDGER" | "OTHER";

export interface PageRequest { cursor?: string; limit?: number }
export interface Page<T> { items: readonly T[]; nextCursor: string | null }
export interface CaseRef { caseId: Id }
export interface RevisionRef extends CaseRef { expectedRevision: number }
export interface ProposalRef extends RevisionRef { proposalId: Id; proposalHash: string }
export interface DateRange { from: string; to: string }

export interface CaseSummary {
  id: Id;
  companyId: Id;
  vendorId: Id;
  servicePeriod: DateRange;
  postingPeriod: string;
  originalStatus: "DRAFT" | "POSTED";
  originalAmountCents: MoneyCents;
  sourceEntryId: Id;
  inputRevision: number;
  state: CaseState;
  currentProposalId: Id | null;
  blockers: readonly string[];
}
/** Internal file reference. Never accept a browser-supplied filesystem path. */
export interface StoredFile {
  storageKey: string;
  contentHash: string;
  byteLength: number;
  mediaType: string;
}
export interface DocumentSummary {
  id: Id;
  type: DocumentType;
  version: number;
  contentHash: string;
}
export interface EvidenceFact {
  id: Id;
  documentId: Id;
  pageOrRow: string;
  excerpt: string;
  field: string;
  value: string;
  validationStatus: "PROPOSED" | "ACCEPTED" | "REJECTED";
}
export interface CandidateMatch {
  workItemId: Id;
  contractId: Id;
  invoiceLineIds: readonly Id[];
  ledgerEntryIds: readonly Id[];
  evidenceIds: readonly Id[];
}
export interface AgentOutput {
  proposedFacts: readonly Omit<EvidenceFact, "id" | "validationStatus">[];
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
export interface JobLease extends JobSummary {
  leaseToken: string;
  leaseExpiry: Timestamp;
  allowedEvidenceIds: readonly Id[];
  facts: readonly EvidenceFact[];
  policyVersion: string;
  outputSchema: Readonly<Record<string, unknown>>;
}
export interface LeaseRef extends RevisionRef { jobId: Id; leaseToken: string }

export interface JournalLine {
  entryDate: string;
  referenceId: string;
  accountCode: string;
  accountName: string;
  debitCents: MoneyCents;
  creditCents: MoneyCents;
  currency: "USD";
  description: string;
}
export interface Proposal {
  id: Id;
  caseId: Id;
  version: number;
  inputRevision: number;
  policyVersion: string;
  originalAmount: MoneyCents;
  correctedTarget: MoneyCents;
  adjustment: MoneyCents;
  exportAmount: MoneyCents;
  journalLines: readonly JournalLine[];
  evidenceIds: readonly Id[];
  hash: string;
}
export type ReviewDecision = { decision: "APPROVE" } | { decision: "REJECT"; reason: string };
export type Review = ReviewDecision & {
  id: Id;
  proposalId: Id;
  proposalHash: string;
  reviewerName: string;
  timestamp: Timestamp;
};
export interface Question {
  id: Id;
  proposalId: Id;
  proposalHash: string;
  reviewerName: string;
  question: string;
  answer: string | null;
  evidenceIds: readonly Id[];
  resolutionStatus: "PENDING" | "ANSWERED";
}
export interface ExportReceipt {
  id: Id;
  proposalId: Id;
  proposalHash: string;
  exportKey: string;
  contentHash: string;
  createdAt: Timestamp;
}
export interface Account { code: string; name: string }
export interface CompanySettings {
  companyId: Id;
  currency: "USD";
  expenseAccount: Account;
  liabilityAccount: Account;
  policyVersion: string;
}
export type CaseUpdate =
  | { kind: "CASE_UPDATED"; sequence: string; case: CaseSummary }
  | { kind: "JOB_UPDATED"; sequence: string; job: JobSummary }
  | { kind: "QUESTION_UPDATED"; sequence: string; question: Question };
