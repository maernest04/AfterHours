export interface Step {
  id: string;
  label: string;
  role: string;
  purpose: string;
  region: number;
  x: number;
  y: number;
  evidence: string[];
  kind?: "guard" | "exception";
}
export const regions = [
  { name: "Ingest & normalize", x: 0, width: 450 },
  { name: "Match & validate", x: 470, width: 450 },
  { name: "Investigate", x: 940, width: 680 },
  { name: "Correct & review", x: 1640, width: 450 },
];
export const steps: Step[] = [
  {
    id: "accrual",
    label: "Existing accrual",
    role: "Source",
    purpose:
      "Start from the posted $7,000 accrual JE-0098. This is a review of existing accounting work.",
    region: 0,
    x: 130,
    y: 85,
    evidence: ["ledger"],
  },
  {
    id: "read",
    label: "Read the evidence",
    role: "Extraction agent",
    purpose:
      "Extract cited facts from the contract, approved work, received invoice and ledger. Three AI roles serve the workflow; these boxes are states, not separate agents.",
    region: 0,
    x: 130,
    y: 210,
    evidence: ["contract", "work", "invoice", "ledger"],
  },
  {
    id: "contract",
    label: "Contract terms",
    role: "Source check",
    purpose:
      "Validate the original $100/hour contractual rate and amendment requirements.",
    region: 0,
    x: 20,
    y: 350,
    evidence: ["contract"],
  },
  {
    id: "work",
    label: "Approved work",
    role: "Source check",
    purpose: "Validate 70 approved hours performed September 15–30.",
    region: 0,
    x: 245,
    y: 350,
    evidence: ["work"],
  },
  {
    id: "invoice",
    label: "Invoice coverage",
    role: "Source check",
    purpose:
      "A received, unposted invoice suggests $110/hour. It is evidence of a discrepancy, not authority or an additional ledger expense.",
    region: 0,
    x: 20,
    y: 510,
    evidence: ["invoice"],
  },
  {
    id: "ledger",
    label: "Ledger balance",
    role: "Source check",
    purpose:
      "Confirm $7,000 has already been posted. An adjustment must record only the difference.",
    region: 0,
    x: 245,
    y: 510,
    evidence: ["ledger"],
  },
  {
    id: "schema",
    label: "Schema valid?",
    role: "Deterministic guard",
    purpose:
      "Require all four source checks and valid required fields before joining records. One completed check cannot satisfy this join.",
    region: 1,
    x: 490,
    y: 210,
    evidence: [],
    kind: "guard",
  },
  {
    id: "invalid",
    label: "Invalid source",
    role: "Wait for input",
    purpose:
      "Alternative: malformed source data blocks matching. Wait for corrected input and rerun the affected checks.",
    region: 1,
    x: 715,
    y: 85,
    evidence: [],
    kind: "exception",
  },
  {
    id: "match",
    label: "Connect the records",
    role: "Matching agent",
    purpose:
      "Join vendor, service dates, contract, invoice and posted entry only after required checks finish.",
    region: 1,
    x: 490,
    y: 350,
    evidence: ["contract", "work", "invoice", "ledger"],
  },
  {
    id: "agrees",
    label: "Evidence agrees?",
    role: "Decision guard",
    purpose:
      "Compare supported rates and amounts. An unexplained conflict requires investigation; agreement can verify an unchanged accrual.",
    region: 1,
    x: 715,
    y: 350,
    evidence: ["contract", "invoice"],
    kind: "guard",
  },
  {
    id: "unchanged",
    label: "Verified — no change",
    role: "Terminal",
    purpose:
      "Alternative: supported unchanged amount. No correction is created, and no adjustment export is available.",
    region: 1,
    x: 715,
    y: 570,
    evidence: ["ledger", "invoice-original"],
  },
  {
    id: "mailbox",
    label: "Search the mailbox",
    role: "Investigation agent",
    purpose:
      "Look for authorized evidence that resolves the $100 versus $110 rate conflict.",
    region: 2,
    x: 960,
    y: 210,
    evidence: ["invoice"],
  },
  {
    id: "threads",
    label: "Search email threads",
    role: "Investigation tool",
    purpose:
      "Find the signed amendment and a separate unapproved $130 request; preserve their source metadata.",
    region: 2,
    x: 1185,
    y: 210,
    evidence: ["amendment", "excluded"],
  },
  {
    id: "attachments",
    label: "Read attachments",
    role: "Extraction tool",
    purpose:
      "Read the signed September 14 amendment attachment. References without bytes display excerpts only.",
    region: 2,
    x: 1410,
    y: 210,
    evidence: ["amendment"],
  },
  {
    id: "authority",
    label: "Authorized & effective?",
    role: "Decision guard",
    purpose:
      "Require an authorized signature and an effective date covering the approved work. An unapproved request never changes the rate.",
    region: 2,
    x: 1185,
    y: 350,
    evidence: ["amendment", "excluded"],
    kind: "guard",
  },
  {
    id: "amendment",
    label: "Verify the amendment",
    role: "Evidence check",
    purpose:
      "The signed $110 amendment is effective September 15. All 70 approved hours qualify.",
    region: 2,
    x: 1410,
    y: 350,
    evidence: ["amendment", "work"],
  },
  {
    id: "retry",
    label: "Retry provider call",
    role: "Bounded retry · max 2",
    purpose:
      "Alternative: a temporary provider failure may retry twice. Exhaustion blocks the run and never produces a proposal.",
    region: 2,
    x: 960,
    y: 85,
    evidence: [],
    kind: "exception",
  },
  {
    id: "missing",
    label: "Evidence missing",
    role: "Wait for input",
    purpose:
      "Alternative: no signed amendment is available. Request the specific signed rate amendment; keep the correction blocked.",
    region: 2,
    x: 960,
    y: 570,
    evidence: ["invoice"],
    kind: "exception",
  },
  {
    id: "conflict",
    label: "Conflicting authority",
    role: "Blocked",
    purpose:
      "Alternative: conflicting authorized terms require human resolution. Do not pick a rate silently.",
    region: 2,
    x: 1185,
    y: 570,
    evidence: [],
    kind: "exception",
  },
  {
    id: "calculate",
    label: "Calculate correction",
    role: "Deterministic code",
    purpose:
      "Use exact minor units: target $7,700 minus posted $7,000 equals a $700 adjustment. The browser displays fixture/backend calculations.",
    region: 3,
    x: 1660,
    y: 210,
    evidence: ["ledger", "amendment", "work"],
  },
  {
    id: "balance",
    label: "Period + balance valid?",
    role: "Deterministic guard",
    purpose:
      "Verify the September period and balanced debit/credit lines. A failed validation blocks review and export.",
    region: 3,
    x: 1885,
    y: 210,
    evidence: [],
    kind: "guard",
  },
  {
    id: "review",
    label: "Your decision",
    role: "Human · demo email",
    purpose:
      "A human email decision binds to the current proposal version. Demo controls simulate an acknowledged email event only.",
    region: 3,
    x: 1885,
    y: 350,
    evidence: ["amendment", "ledger"],
  },
  {
    id: "question",
    label: "Question received",
    role: "Human question",
    purpose:
      "Ask why returns a concise, cited explanation and then resumes pending review. It is neither approval nor rejection.",
    region: 3,
    x: 1660,
    y: 510,
    evidence: ["amendment", "excluded"],
  },
  {
    id: "rejected",
    label: "Rejected / stale",
    role: "Revision required",
    purpose:
      "Keep the rejection reason and old proposal. Material input changes invalidate approval and rerun affected checks; a new version needs fresh approval.",
    region: 3,
    x: 1885,
    y: 570,
    evidence: [],
    kind: "exception",
  },
  {
    id: "export",
    label: "Journal-entry CSV",
    role: "Export · not posted",
    purpose:
      "Only current, valid, approved adjustments can export. CSV may require account mapping. Download does not post or pay anything.",
    region: 3,
    x: 1660,
    y: 730,
    evidence: [],
  },
];
export interface Link {
  source: string;
  target: string;
  label?: string;
}
export const links: Link[] = [
  { source: "accrual", target: "read" },
  ...["contract", "work", "invoice", "ledger"].map((target) => ({
    source: "read",
    target,
  })),
  ...["contract", "work", "invoice", "ledger"].map((source) => ({
    source,
    target: "schema",
  })),
  { source: "schema", target: "invalid", label: "invalid" },
  { source: "invalid", target: "read", label: "corrected input" },
  { source: "schema", target: "match", label: "valid" },
  { source: "match", target: "agrees" },
  { source: "agrees", target: "unchanged", label: "no difference" },
  { source: "agrees", target: "calculate", label: "supported" },
  { source: "agrees", target: "mailbox", label: "rate conflict" },
  { source: "mailbox", target: "threads" },
  { source: "threads", target: "attachments" },
  { source: "threads", target: "missing", label: "no match" },
  { source: "mailbox", target: "retry", label: "temporary error" },
  { source: "retry", target: "mailbox", label: "retry" },
  { source: "attachments", target: "authority" },
  { source: "authority", target: "amendment", label: "valid" },
  { source: "authority", target: "conflict", label: "conflict" },
  { source: "missing", target: "mailbox", label: "new evidence" },
  { source: "amendment", target: "calculate", label: "supported" },
  { source: "calculate", target: "balance" },
  { source: "balance", target: "review", label: "valid" },
  { source: "balance", target: "rejected", label: "invalid" },
  { source: "review", target: "export", label: "approve" },
  { source: "review", target: "question", label: "ask why" },
  { source: "question", target: "mailbox", label: "investigate" },
  { source: "question", target: "review", label: "answered" },
  { source: "review", target: "rejected", label: "reject" },
  { source: "rejected", target: "read", label: "new revision" },
];
export const edgeId = (a: string, b: string) => `${a}:${b}`;
