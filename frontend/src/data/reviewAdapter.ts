export type Minor = string;
export type NodeStatus =
  | "dormant"
  | "queued"
  | "running"
  | "complete"
  | "waiting"
  | "blocked"
  | "skipped";
export type CaseStatus =
  | "ready"
  | "running"
  | "waiting"
  | "review"
  | "approved"
  | "rejected"
  | "exported"
  | "verified"
  | "blocked";
export type Variant =
  | "amendment"
  | "no-change"
  | "missing"
  | "provider-failure"
  | "rejection-revision"
  | "invalid-source"
  | "conflicting-authority"
  | "invalid-period";
export interface EvidenceRecord {
  id: string;
  name: string;
  type: string;
  reference: string;
  excerpt: string;
  disposition: string;
  sender?: string;
  recipient?: string;
  date?: string;
  thread?: string;
  attachments?: string[];
}
export interface JournalLine {
  entryDate: string;
  reference: string;
  accountCode: string;
  accountName: string;
  debit: Minor;
  credit: Minor;
  currency: string;
  description: string;
}
export interface Proposal {
  version: number;
  inputRevision: number;
  target: Minor;
  difference: Minor;
  explanation: string;
  evidenceIds: string[];
  lines: JournalLine[];
  valid: boolean;
}
export interface ReviewEvent {
  id: string;
  time: string;
  actor: string;
  action: string;
  outcome: string;
  evidenceIds: string[];
  proposalVersion?: number;
}
export interface CaseSnapshot {
  caseId: string;
  runId: string;
  revision: number;
  inputRevision: number;
  status: CaseStatus;
  original: Minor;
  originalStatus: "DRAFT" | "POSTED";
  nodeStates: Record<string, NodeStatus>;
  transitions: string[];
  events: ReviewEvent[];
  proposal: Proposal | null;
  approvedVersion: number | null;
  exportEligible: boolean;
  pendingQuestion: boolean;
  answer: string | null;
  rejectionReason: string | null;
  blocker: string | null;
  paused: boolean;
  connection: "demo" | "connecting" | "connected" | "disconnected" | "error";
  variant: Variant;
}
export interface ReviewAdapter {
  readonly mode: "demo" | "api";
  readonly snapshot: CaseSnapshot;
  subscribeCase(
    caseId: string,
    onSnapshot: (s: CaseSnapshot) => void,
  ): () => void;
  startReview(caseId: string): Promise<void>;
  askQuestion(
    caseId: string,
    proposalVersion: number,
    question: string,
  ): Promise<void>;
  approve(caseId: string, proposalVersion: number): Promise<void>;
  reject(
    caseId: string,
    proposalVersion: number,
    reason: string,
  ): Promise<void>;
  getEvidence(evidenceId: string): Promise<EvidenceRecord>;
  exportJournal(caseId: string, proposalVersion: number): Promise<Blob>;
  reset(variant?: Variant): void;
  pause(): void;
  revise(): void;
  dispose(): void;
}
export function acceptSnapshot(
  current: CaseSnapshot | null,
  incoming: CaseSnapshot,
): CaseSnapshot {
  if (
    current &&
    current.runId === incoming.runId &&
    incoming.revision <= current.revision
  )
    return current;
  return {
    ...incoming,
    events: Array.from(new Map(incoming.events.map((e) => [e.id, e])).values()),
  };
}
export function canExport(s: CaseSnapshot): boolean {
  const p = s.proposal;
  return (
    !!p &&
    p.valid &&
    p.inputRevision === s.inputRevision &&
    p.version === s.approvedVersion &&
    !s.pendingQuestion &&
    !s.blocker &&
    (s.status === "approved" || s.status === "exported") &&
    balanced(p.lines)
  );
}
export function balanced(lines: JournalLine[]): boolean {
  return (
    lines.length > 0 &&
    lines.every((l) => /^[0-9]+$/.test(l.debit) && /^[0-9]+$/.test(l.credit)) &&
    lines.reduce((n, l) => n + BigInt(l.debit) - BigInt(l.credit), 0n) === 0n
  );
}
export function decimal(cents: Minor): string {
  const n = BigInt(cents);
  const a = n < 0n ? -n : n;
  return `${n < 0n ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}
export function money(cents: Minor | null, signed = false): string {
  if (cents === null) return "—";
  const n = BigInt(cents);
  const a = n < 0n ? -n : n;
  return `${n < 0n ? "−" : signed && n > 0n ? "+" : ""}$${(a / 100n).toLocaleString("en-US")}${a % 100n ? "." + (a % 100n).toString().padStart(2, "0") : ""}`;
}
export function safeCell(value: string): string {
  return /^[\s]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value)
    ? "'" + value
    : value;
}
export function journalText(lines: JournalLine[], separator = ","): string {
  const rows = [
    [
      "entry_date",
      "reference_id",
      "account_code",
      "account_name",
      "debit",
      "credit",
      "currency",
      "description",
    ],
    ...lines.map((l) => [
      l.entryDate,
      l.reference,
      l.accountCode,
      l.accountName,
      decimal(l.debit),
      decimal(l.credit),
      l.currency,
      l.description,
    ]),
  ];
  return (
    rows
      .map((row) =>
        row
          .map((raw) => {
            const s = safeCell(raw);
            if (separator === "\t") return s.replace(/[\t\r\n]/g, " ");
            return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
          })
          .join(separator),
      )
      .join("\r\n") + "\r\n"
  );
}
