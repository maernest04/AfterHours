import { evidence, CASE_ID, proposal } from "./fixtures";
import { steps, edgeId } from "./topology";
import {
  canExport,
  journalText,
  type CaseSnapshot,
  type ReviewAdapter,
  type Variant,
  type NodeStatus,
} from "./reviewAdapter";
let generation = 0;
type Frame = {
  nodes: Record<string, NodeStatus>;
  edges?: [string, string][];
  action: string;
  outcome: string;
  evidence?: string[];
  status?: CaseSnapshot["status"];
  blocker?: string;
  proposal?: boolean;
};
export class MockReviewAdapter implements ReviewAdapter {
  private listeners = new Set<(s: CaseSnapshot) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frames: Frame[] = [];
  private index = 0;
  private epoch = 0;
  private pendingCancel: (() => void) | null = null;
  snapshot: CaseSnapshot;
  constructor(
    variant: Variant = "amendment",
    private pace = 650,
  ) {
    this.snapshot = this.initial(variant);
  }
  private initial(variant: Variant): CaseSnapshot {
    return {
      caseId: CASE_ID,
      runId: `demo-run-${++generation}`,
      revision: 0,
      inputRevision: 1,
      status: "ready",
      original: "700000",
      originalStatus: "POSTED",
      nodeStates: Object.fromEntries(steps.map((s) => [s.id, "dormant"])),
      transitions: [],
      events: [],
      proposal: null,
      approvedVersion: null,
      exportEligible: false,
      pendingQuestion: false,
      answer: null,
      rejectionReason: null,
      blocker: null,
      paused: false,
      connection: "demo",
      variant,
    };
  }
  subscribeCase(id: string, callback: (s: CaseSnapshot) => void) {
    this.checkId(id);
    this.listeners.add(callback);
    callback(structuredClone(this.snapshot));
    return () => {
      this.listeners.delete(callback);
    };
  }
  private checkId(id: string) {
    if (id !== CASE_ID) throw new Error("Review not found.");
  }
  private publish() {
    this.snapshot.revision++;
    this.snapshot.exportEligible = canExport(this.snapshot);
    for (const f of this.listeners) f(structuredClone(this.snapshot));
  }
  private event(
    action: string,
    outcome: string,
    ids: string[] = [],
    actor = "Demo workflow",
  ) {
    const s = this.snapshot;
    s.events.push({
      id: `${s.runId}:${s.events.length + 1}`,
      time: new Date(
        Date.UTC(2026, 9, 1, 9, 0, s.events.length * 4),
      ).toISOString(),
      actor,
      action,
      outcome,
      evidenceIds: ids,
      proposalVersion: s.proposal?.version,
    });
  }
  private traverse(a: string, b: string) {
    const id = edgeId(a, b);
    if (!this.snapshot.transitions.includes(id))
      this.snapshot.transitions.push(id);
  }
  private cancel() {
    this.epoch++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingCancel?.();
    this.pendingCancel = null;
  }
  reset(variant: Variant = this.snapshot.variant) {
    this.cancel();
    this.frames = [];
    this.index = 0;
    this.snapshot = this.initial(variant);
    this.publish();
  }
  dispose() {
    this.cancel();
    this.listeners.clear();
  }
  pause() {
    if (this.snapshot.status !== "running") return;
    this.snapshot.paused = !this.snapshot.paused;
    clearTimeout(this.timer);
    if (!this.snapshot.paused) this.schedule();
    this.publish();
  }
  async startReview(id: string) {
    this.checkId(id);
    if (this.snapshot.status !== "ready")
      throw new Error("Reset the demo to start another run.");
    this.snapshot.status = "running";
    this.frames = this.makeFrames();
    this.index = 0;
    this.event(
      "Review started",
      "Deterministic fixture playback. No model calls or email is sent.",
    );
    this.publish();
    this.next();
  }
  private schedule() {
    this.timer = setTimeout(() => this.next(), this.pace);
  }
  private next() {
    if (this.snapshot.paused) return;
    const f = this.frames[this.index++];
    if (!f) return;
    Object.assign(this.snapshot.nodeStates, f.nodes);
    for (const [a, b] of f.edges ?? []) this.traverse(a, b);
    if (f.status) this.snapshot.status = f.status;
    if (f.blocker) this.snapshot.blocker = f.blocker;
    if (f.proposal)
      this.snapshot.proposal = proposal(
        this.snapshot.inputRevision,
        this.snapshot.inputRevision,
        this.snapshot.variant !== "invalid-period",
      );
    this.event(f.action, f.outcome, f.evidence);
    this.publish();
    if (this.index < this.frames.length) this.schedule();
  }
  private makeFrames(): Frame[] {
    const v = this.snapshot.variant;
    const frames: Frame[] = [
      {
        nodes: { accrual: "complete", read: "running" },
        edges: [["accrual", "read"]],
        action: "Reading evidence",
        outcome: "Posted JE-0098 is the baseline; original accrual is $7,000.",
        evidence: ["ledger"],
      },
      {
        nodes: {
          read: "complete",
          contract: "running",
          work: "running",
          invoice: "running",
          ledger: "running",
          schema: "queued",
        },
        edges: ["contract", "work", "invoice", "ledger"].map((x) => [
          "read",
          x,
        ]),
        action: "Parallel source checks",
        outcome:
          "Four independent checks are running. Matching waits for all four.",
      },
      {
        nodes: { contract: "complete", work: "complete" },
        edges: [
          ["contract", "schema"],
          ["work", "schema"],
        ],
        action: "Contract and hours checked",
        outcome:
          "Two checks complete; invoice and ledger checks are still running.",
        evidence: ["contract", "work"],
      },
      {
        nodes: { invoice: "complete", ledger: "complete", schema: "running" },
        edges: [
          ["invoice", "schema"],
          ["ledger", "schema"],
        ],
        action: "Source checks complete",
        outcome:
          v === "no-change"
            ? "Unposted invoice and posted accrual both support $100/hour."
            : "The invoice suggests $110/hour and is unposted.",
        evidence: [
          v === "no-change" ? "invoice-original" : "invoice",
          "ledger",
        ],
      },
    ];
    if (v === "invalid-source")
      return [
        ...frames,
        {
          nodes: { schema: "blocked", invalid: "waiting" },
          edges: [["schema", "invalid"]],
          status: "waiting",
          blocker:
            "Invoice lacks a readable service-period reference. Supply a corrected source.",
          action: "Invalid source",
          outcome: "Matching is locked until corrected input arrives.",
        },
      ];
    frames.push(
      {
        nodes: { schema: "complete", match: "running" },
        edges: [["schema", "match"]],
        action: "Joining the records",
        outcome: "All required source checks passed.",
      },
      {
        nodes: { match: "complete", agrees: "running" },
        edges: [["match", "agrees"]],
        action: "Comparing the evidence",
        outcome:
          v === "no-change"
            ? "The supported amount is unchanged."
            : "Contract and unposted invoice disagree on the hourly rate.",
        evidence: [
          "contract",
          v === "no-change" ? "invoice-original" : "invoice",
        ],
      },
    );
    if (v === "no-change")
      return [
        ...frames,
        {
          nodes: {
            agrees: "complete",
            unchanged: "complete",
            calculate: "skipped",
            review: "skipped",
            export: "skipped",
          },
          edges: [["agrees", "unchanged"]],
          status: "verified",
          action: "Verified — no change",
          outcome:
            "The existing $7,000 accrual is supported. There is no correction to export.",
        },
      ];
    frames.push({
      nodes: { agrees: "complete", mailbox: "running" },
      edges: [["agrees", "mailbox"]],
      action: "Investigating the rate conflict",
      outcome:
        "Search for an authorized amendment, not merely a requested rate.",
    });
    if (v === "provider-failure")
      return [
        ...frames,
        {
          nodes: { mailbox: "waiting", retry: "running" },
          edges: [["mailbox", "retry"]],
          action: "Provider temporarily unavailable",
          outcome: "Retry 1 of 2. No model call is made in this demo.",
        },
        {
          nodes: { mailbox: "running", retry: "waiting" },
          edges: [["retry", "mailbox"]],
          action: "Retrying mailbox search",
          outcome: "Retry 2 of 2.",
        },
        {
          nodes: { mailbox: "blocked", retry: "blocked" },
          status: "blocked",
          blocker:
            "Provider unavailable after 2 retries. Retry the review after service recovery.",
          action: "Retry limit reached",
          outcome: "Stopped safely without a proposal.",
        },
      ];
    frames.push({
      nodes: { mailbox: "complete", threads: "running" },
      edges: [["mailbox", "threads"]],
      action: "Searching email threads",
      outcome: "Reviewing rate amendments and source metadata.",
    });
    if (v === "missing")
      return [
        ...frames,
        {
          nodes: { threads: "complete", missing: "waiting" },
          edges: [["threads", "missing"]],
          status: "waiting",
          blocker:
            "Missing the signed amendment authorizing $110/hour effective September 15.",
          action: "Waiting for signed amendment",
          outcome:
            "The unposted invoice alone is insufficient authority. Supply the signed amendment.",
          evidence: ["invoice"],
        },
      ];
    frames.push(
      {
        nodes: { threads: "complete", attachments: "running" },
        edges: [["threads", "attachments"]],
        action: "Reading the signed attachment",
        outcome:
          "Found a September 14 amendment and a separate unapproved $130 request.",
        evidence: ["amendment", "excluded"],
      },
      {
        nodes: { attachments: "complete", authority: "running" },
        edges: [["attachments", "authority"]],
        action: "Checking authority and effective date",
        outcome: "Validate authorized signatures and the work dates.",
        evidence: ["amendment", "work"],
      },
    );
    if (v === "conflicting-authority")
      return [
        ...frames,
        {
          nodes: { authority: "blocked", conflict: "blocked" },
          edges: [["authority", "conflict"]],
          status: "blocked",
          blocker:
            "Two authorized rate records conflict. A reviewer must resolve authority before calculation.",
          action: "Conflicting authority",
          outcome: "This alternative fixture blocks the affected correction.",
        },
      ];
    frames.push(
      {
        nodes: { authority: "complete", amendment: "complete" },
        edges: [["authority", "amendment"]],
        action: "Amendment verified",
        outcome:
          "$110/hour applies to all 70 hours. Excluded the unapproved $130 request.",
        evidence: ["amendment", "work", "excluded"],
      },
      {
        nodes: { calculate: "running" },
        edges: [["amendment", "calculate"]],
        action: "Calculating the difference",
        outcome:
          "Deterministic fixture calculation: $7,700 target less $7,000 posted.",
      },
      {
        nodes: { calculate: "complete", balance: "running" },
        edges: [["calculate", "balance"]],
        proposal: true,
        action: "Validating journal and period",
        outcome:
          "Proposed debit and credit are each $700; this is an adjustment only.",
      },
    );
    if (v === "invalid-period")
      return [
        ...frames,
        {
          nodes: { balance: "blocked", rejected: "blocked" },
          edges: [["balance", "rejected"]],
          status: "blocked",
          blocker:
            "September 2026 is closed in this fixture. Resolve the accounting-period gate before review.",
          action: "Period validation failed",
          outcome: "Human approval and export remain blocked.",
        },
      ];
    return [
      ...frames,
      {
        nodes: { balance: "complete", review: "waiting" },
        edges: [["balance", "review"]],
        status: "review",
        action: "Awaiting demo reviewer",
        outcome: `Proposal V${this.snapshot.inputRevision} is ready. A fresh email decision is required.`,
        evidence: ["amendment", "ledger"],
      },
    ];
  }
  private current(id: string, version: number) {
    this.checkId(id);
    const s = this.snapshot;
    if (
      !s.proposal ||
      s.proposal.version !== version ||
      s.proposal.inputRevision !== s.inputRevision
    )
      throw new Error(
        "Version conflict. Refresh and review the current proposal.",
      );
    if (
      s.status !== "review" ||
      s.pendingQuestion ||
      s.blocker ||
      !s.proposal.valid
    )
      throw new Error("The current proposal is not available for a decision.");
  }
  async approve(id: string, version: number) {
    this.current(id, version);
    this.snapshot.approvedVersion = version;
    this.snapshot.status = "approved";
    this.snapshot.nodeStates.review = "complete";
    this.snapshot.nodeStates.export = "waiting";
    this.traverse("review", "export");
    this.event(
      "Simulated approval email acknowledged",
      `Demo reviewer approved proposal V${version}. Export is available; no entry has been posted.`,
      [],
      "Taylor Morgan · demo reviewer",
    );
    this.publish();
  }
  async reject(id: string, version: number, reason: string) {
    this.current(id, version);
    if (!reason.trim()) throw new Error("Enter a reason for rejection.");
    this.snapshot.rejectionReason = reason.trim();
    this.snapshot.approvedVersion = null;
    this.snapshot.status = "rejected";
    this.snapshot.nodeStates.review = "complete";
    this.snapshot.nodeStates.rejected = "waiting";
    this.traverse("review", "rejected");
    this.event(
      "Simulated rejection email acknowledged",
      reason.trim(),
      [],
      "Taylor Morgan · demo reviewer",
    );
    this.publish();
  }
  async askQuestion(id: string, version: number, question: string) {
    this.current(id, version);
    if (!question.trim()) throw new Error("Enter a question.");
    const epoch = this.epoch;
    this.snapshot.pendingQuestion = true;
    this.snapshot.nodeStates.review = "waiting";
    this.snapshot.nodeStates.question = "running";
    this.traverse("review", "question");
    this.event(
      "Simulated question email received",
      question.trim(),
      [],
      "Taylor Morgan · demo reviewer",
    );
    this.publish();
    await new Promise<void>((resolve) => {
      this.pendingCancel = resolve;
      this.timer = setTimeout(resolve, this.pace * 2);
    });
    this.pendingCancel = null;
    if (epoch !== this.epoch) return;
    this.snapshot.pendingQuestion = false;
    this.snapshot.answer =
      "The $700 adjustment reflects 70 approved hours at the signed $110 rate, less the $7,000 already posted. The amendment was signed September 14 and is effective September 15. The unposted invoice corroborates the amount; the unapproved $130 request was excluded. Sources: amendment page 1 §2, timesheet rows 15–30, ledger row 98.";
    this.snapshot.nodeStates.question = "complete";
    this.traverse("question", "review");
    this.event(
      "Question answered",
      this.snapshot.answer,
      ["amendment", "work", "ledger", "excluded"],
      "Investigation · replayed",
    );
    this.publish();
  }
  revise() {
    if (
      !["rejected", "approved", "exported", "waiting"].includes(
        this.snapshot.status,
      )
    )
      throw new Error("This run is not waiting for a revision.");
    this.cancel();
    const s = this.snapshot;
    s.inputRevision++;
    s.approvedVersion = null;
    s.pendingQuestion = false;
    s.answer = null;
    s.blocker = null;
    s.status = "running";
    s.paused = false;
    s.nodeStates = Object.fromEntries(steps.map((x) => [x.id, "dormant"]));
    s.nodeStates.rejected = "complete";
    s.transitions = [edgeId("rejected", "read")];
    if (s.variant === "invalid-source" || s.variant === "missing")
      s.variant = "amendment";
    this.event(
      "Revised evidence received",
      `Input revision ${s.inputRevision}. Prior approval is invalid; rerunning affected checks.`,
      [],
      "Demo evidence update",
    );
    this.frames = this.makeFrames();
    this.index = 0;
    this.publish();
    this.next();
  }
  async getEvidence(id: string) {
    const item = evidence.find((e) => e.id === id);
    if (!item) throw new Error("Evidence not found.");
    return { ...item };
  }
  async exportJournal(id: string, version: number) {
    this.checkId(id);
    if (
      !canExport(this.snapshot) ||
      this.snapshot.proposal?.version !== version
    )
      throw new Error(
        "Export requires approval of the current valid proposal.",
      );
    const blob = new Blob([journalText(this.snapshot.proposal.lines)], {
      type: "text/csv;charset=utf-8",
    });
    this.snapshot.status = "exported";
    this.snapshot.nodeStates.export = "complete";
    this.event(
      "CSV exported — not posted",
      `Generic journal-entry CSV for V${version}. Account mapping may be required.`,
      [],
      "Taylor Morgan · demo reviewer",
    );
    this.publish();
    return blob;
  }
}
