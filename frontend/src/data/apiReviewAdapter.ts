import { ReviewApi, type ApiReview } from "../services/reviewApi";
import type {
  CaseSnapshot,
  EvidenceRecord,
  ReviewAdapter,
  NodeStatus,
  ReviewEvent,
} from "./reviewAdapter";
import { edgeId, steps } from "./topology";

function statusFor(status: ApiReview["status"]): CaseSnapshot["status"] {
  switch (status) {
    case "IMPORTED": return "ready";
    case "EXTRACTING":
    case "MATCHING":
    case "INVESTIGATING": return "running";
    case "WAITING_FOR_INPUT": return "waiting";
    case "READY_FOR_REVIEW": return "review";
    case "VERIFIED_NO_CHANGE": return "verified";
    case "APPROVED": return "approved";
    case "EXPORTED": return "exported";
    case "NEEDS_REVISION": return "rejected";
    case "RETRYABLE_ERROR":
    case "FAILED": return "blocked";
  }
  throw new Error(`Unsupported API review status: ${status}`);
}

export function nodesFor(status: ApiReview["status"], blockers: string[] = []): Record<string, NodeStatus> {
  const nodes = Object.fromEntries(steps.map((step) => [step.id, "dormant" as NodeStatus]));
  const set = (id: string, value: NodeStatus) => { if (id in nodes) nodes[id] = value; };
  set("import", "complete");
  if (["NEEDS_REVISION", "RETRYABLE_ERROR", "FAILED"].includes(status)) {
    const proposalFailure = blockers.some((b) => b.startsWith("PROPOSAL_FAILED:"));
    set(proposalFailure ? "proposal" : status === "NEEDS_REVISION" ? "rejected" : "retry", "blocked");
    return nodes;
  }
  if (status === "IMPORTED") return nodes;
  set("accrual", "complete");
  set("read", status === "EXTRACTING" ? "running" : "complete");
  if (status === "EXTRACTING") return nodes;
  for (const id of ["contract", "work", "invoice", "ledger", "schema"]) set(id, "complete");
  set("match", status === "MATCHING" ? "running" : "complete");
  if (status === "MATCHING") return nodes;
  set("agrees", "complete");
  if (status === "INVESTIGATING" || status === "WAITING_FOR_INPUT") {
    set(status === "WAITING_FOR_INPUT" ? "missing" : "mailbox", status === "WAITING_FOR_INPUT" ? "waiting" : "running");
    return nodes;
  }
  if (["READY_FOR_REVIEW", "APPROVED", "EXPORTED", "VERIFIED_NO_CHANGE"].includes(status)) {
    for (const id of ["mailbox", "threads", "attachments", "authority", "amendment", "calculate", "balance", "proposal", "review"]) set(id, "complete");
  }
  return nodes;
}

function transitionsFor(status: ApiReview["status"]): string[] {
  const transitions = [edgeId("import", "accrual"), edgeId("accrual", "read")];
  if (status === "IMPORTED") return transitions.slice(0, 1);
  transitions.push(...["contract", "work", "invoice", "ledger"].flatMap((id) => [edgeId("read", id), edgeId(id, "schema")]));
  if (status === "EXTRACTING") return transitions;
  transitions.push(edgeId("schema", "match"), edgeId("match", "agrees"));
  if (status === "MATCHING") return transitions;
  transitions.push(edgeId("agrees", "mailbox"), edgeId("mailbox", "threads"), edgeId("threads", "attachments"), edgeId("attachments", "authority"), edgeId("authority", "amendment"));
  if (status === "INVESTIGATING" || status === "WAITING_FOR_INPUT") return transitions;
  transitions.push(edgeId("amendment", "calculate"), edgeId("calculate", "balance"), edgeId("balance", "proposal"), edgeId("proposal", "review"));
  return transitions;
}

function checkpointFor(api: ApiReview): ReviewEvent {
  const checkpoints: Record<string, [string, string, string]> = {
    IMPORTED: ["Gateway", "Review created", "Sources accepted; waiting for the pipeline worker."],
    EXTRACTING: ["Extraction worker", "Reading source evidence", "Parsing and citing contract, work, invoice, and ledger facts."],
    MATCHING: ["Matching worker", "Connecting source records", "Joining vendor, period, rates, invoice coverage, and the posted entry."],
    INVESTIGATING: ["Investigation worker", "Searching supporting authority", "Checking mailbox threads and attachments for an authorized rate change."],
    WAITING_FOR_INPUT: ["Pipeline guard", "Waiting for evidence", api.blockers[0] ?? "The review needs additional evidence before it can continue."],
    READY_FOR_REVIEW: ["Accounting pipeline", "Proposal ready", "Validated correction and balanced journal lines are ready for human review."],
    VERIFIED_NO_CHANGE: ["Accounting pipeline", "No change required", "The existing entry is supported by the available evidence."],
    APPROVED: ["Review workflow", "Approval recorded", "The proposal was approved by the review workflow."],
    EXPORTED: ["Export workflow", "Journal exported", "The approved journal entry is available for export."],
    NEEDS_REVISION: ["Review workflow", "Revision required", "The current proposal needs revised evidence or a new input revision."],
    RETRYABLE_ERROR: api.blockers.some((blocker) => blocker.startsWith("PROPOSAL_FAILED:"))
      ? ["Accounting pipeline", "Proposal handoff failed", api.blockers[0]]
      : ["Pipeline guard", "Provider call needs retry", "A bounded retry is available; no proposal has been created."],
    FAILED: ["Pipeline guard", "Pipeline blocked", "The run stopped with a blocking error."],
  };
  const [actor, action, outcome] = checkpoints[api.status] ?? ["Pipeline", api.status, "The review status changed."];
  return { id: `${api.review_id}:checkpoint:${api.status}`, time: api.updated_at, actor, action, outcome, evidenceIds: [] };
}

function mapSnapshot(api: ApiReview, revision: number, postedHash: string | null = null): CaseSnapshot {
  const posted = postedHash !== null && postedHash === api.proposal_hash;
  const status = posted ? "approved" : statusFor(api.status);
  const proposal = api.proposal_id && api.corrected_target_cents && api.difference_cents
    ? {
        version: 1,
        inputRevision: api.input_revision,
        target: api.corrected_target_cents,
        difference: api.difference_cents,
        explanation: "Validated proposal from the AfterHours backend.",
        evidenceIds: api.evidence.map((e) => e.evidence_id),
        lines: api.journal_lines.map((line) => ({
          entryDate: line.entry_date,
          reference: line.reference_id,
          accountCode: line.account_code,
          accountName: line.account_name,
          debit: line.debit_cents,
          credit: line.credit_cents,
          currency: line.currency,
          description: line.description,
        })),
        valid: api.blockers.length === 0,
        hash: api.proposal_hash ?? undefined,
      }
    : null;
  return {
    caseId: api.review_id,
    runId: `api-review-${api.review_id}`,
    revision,
    inputRevision: api.input_revision,
    status,
    original: api.original_amount_cents ?? "0",
    originalStatus: api.original_status ?? "POSTED",
    nodeStates: nodesFor(posted ? "APPROVED" : api.status, api.blockers),
    transitions: ["NEEDS_REVISION", "RETRYABLE_ERROR", "FAILED"].includes(api.status) ? [] : transitionsFor(api.status),
    events: api.history.map((event, index) => ({
      id: `${api.review_id}:${event.timestamp}:${index}`,
      time: event.timestamp,
      actor: event.actor,
      action: event.action,
      outcome: event.summary,
      evidenceIds: event.evidence_ids,
    })),
    proposal,
    approvedVersion: posted || status === "approved" || status === "exported" ? 1 : null,
    exportEligible: false,
    pendingQuestion: api.blockers.some((blocker) => /question/i.test(blocker)),
    answer: null,
    rejectionReason: status === "rejected" ? api.blockers.join(" ") : null,
    blocker: api.blockers[0] ?? null,
    paused: false,
    connection: "connected",
    variant: "amendment",
  };
}

export class ApiReviewAdapter implements ReviewAdapter {
  readonly mode = "api" as const;
  readonly snapshot: CaseSnapshot;
  private revision = 0;
  private readonly api: ReviewApi;
  private readonly checkpoints = new Map<string, ReviewEvent>();
  private latest: ApiReview | null = null;
  private postedHash: string | null = null;
  private emit: ((snapshot: CaseSnapshot) => void) | null = null;

  constructor(private readonly reviewId: string, baseUrl = "/api") {
    this.api = new ReviewApi(baseUrl);
    this.snapshot = {
      caseId: reviewId,
      runId: `api-review-${reviewId}`,
      revision: 0,
      inputRevision: 0,
      status: "ready",
      original: "0",
      originalStatus: "POSTED",
      nodeStates: Object.fromEntries(steps.map((step) => [step.id, "dormant"])),
      transitions: [],
      events: [],
      proposal: null,
      approvedVersion: null,
      exportEligible: false,
      pendingQuestion: false,
      answer: null,
      rejectionReason: null,
      blocker: "Connecting to the review API…",
      paused: false,
      connection: "connecting",
      variant: "amendment",
    };
  }

  subscribeCase(id: string, onSnapshot: (snapshot: CaseSnapshot) => void) {
    if (id !== this.reviewId) throw new Error("Review not found.");
    this.emit = onSnapshot;
    return this.api.subscribe(id, (review) => {
      this.latest = review;
      this.push(review, onSnapshot);
    }, (connection, message) => {
      this.snapshot.connection = connection === "connected" ? "connected" : connection === "error" ? "error" : "connecting";
      if (message) this.snapshot.blocker = message;
      onSnapshot(structuredClone(this.snapshot));
    });
  }

  private push(review: ApiReview, onSnapshot: (snapshot: CaseSnapshot) => void) {
    const next = mapSnapshot(review, ++this.revision, this.postedHash);
    const checkpoint = checkpointFor(review);
    this.checkpoints.set(checkpoint.id, checkpoint);
    next.events = [...next.events, ...this.checkpoints.values()]
      .sort((a, b) => a.time.localeCompare(b.time));
    Object.assign(this.snapshot, next);
    onSnapshot(structuredClone(this.snapshot));
  }

  async startReview(id: string) { if (id !== this.reviewId) throw new Error("Review not found."); }
  async askQuestion() { throw new Error("Questions are not exposed by the backend yet."); }
  async approve(caseId: string, _proposalVersion: number) {
    const hash = this.latest?.proposal_hash;
    if (caseId !== this.reviewId || !hash) throw new Error("The current proposal is not available for a decision.");
    await this.api.approve(caseId, hash);
    this.postedHash = hash;
    if (this.latest && this.emit) this.push(this.latest, this.emit);
  }
  async reject() { throw new Error("Rejection is not exposed by the backend yet."); }
  async getEvidence(evidenceId: string): Promise<EvidenceRecord> {
    const review = await this.api.get(this.reviewId);
    const evidence = review.evidence.find((item) => item.evidence_id === evidenceId);
    if (!evidence) throw new Error("Evidence is not available in this API snapshot.");
    return {
      id: evidence.evidence_id,
      name: evidence.document_id,
      type: "source",
      reference: evidence.page_or_row,
      excerpt: evidence.excerpt,
      disposition: "Backend evidence",
    };
  }
  async exportJournal(): Promise<Blob> { throw new Error("Export is not exposed by the backend yet."); }
  reset() { /* Server-side reviews cannot be reset from the browser. */ }
  pause() { /* Server-side workers are controlled by the orchestrator. */ }
  revise() { throw new Error("Input revision is not exposed by the backend yet."); }
  dispose() { /* EventSource cleanup is returned by subscribeCase. */ }
}
