import { anchor, at, col, CORRIDOR, NODE_H, NODE_W, rowY, SPINE, type Route } from "./layout";
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
// Each stage is a section of the top-to-bottom flowchart.
const section = (name: string, b: number, first: number, last: number) => {
  const y = rowY(b, first) - 58;
  return {
    name,
    x: col(0) - 30,
    y,
    width: col(3) + NODE_W - col(0) + 60,
    height: rowY(b, last) + NODE_H + 24 - y,
  };
};
export const regions = [
  section("Ingest & normalize", 0, 0, 4),
  section("Match & validate", 1, 5, 6),
  section("Investigate", 2, 7, 11),
  section("Correct & review", 3, 12, 17),
];
export const steps: Step[] = [
  {
    id: "import",
    label: "Import & verify files",
    role: "Gateway code",
    purpose:
      "Store each original file once by SHA-256, re-verify bytes on read, and parse CSV/JSON rows with code. Missing inputs or duplicate work block the case.",
    region: 0,
    ...at(0, SPINE, 0),
    evidence: ["contract", "work", "invoice", "ledger"],
  },
  {
    id: "accrual",
    label: "Existing accrual",
    role: "Source",
    purpose:
      "Start from the posted $7,000 accrual JE-0098. This is a review of existing accounting work.",
    region: 0,
    ...at(0, SPINE, 1),
    evidence: ["ledger"],
  },
  {
    id: "read",
    label: "Read the evidence",
    role: "Extraction agent",
    purpose:
      "Extract cited facts from the contract, approved work, received invoice and ledger. Three AI roles serve the workflow; these boxes are states, not separate agents.",
    region: 0,
    ...at(0, SPINE, 2),
    evidence: ["contract", "work", "invoice", "ledger"],
  },
  {
    id: "contract",
    label: "Contract terms",
    role: "Source check",
    purpose:
      "Validate the original $100/hour contractual rate and amendment requirements.",
    region: 0,
    ...at(0, 0, 3),
    evidence: ["contract"],
  },
  {
    id: "work",
    label: "Approved work",
    role: "Source check",
    purpose: "Validate 70 approved hours performed September 15–30.",
    region: 0,
    ...at(0, 1, 3),
    evidence: ["work"],
  },
  {
    id: "invoice",
    label: "Invoice coverage",
    role: "Source check",
    purpose:
      "A received, unposted invoice suggests $110/hour. It is evidence of a discrepancy, not authority or an additional ledger expense.",
    region: 0,
    ...at(0, 2, 3),
    evidence: ["invoice"],
  },
  {
    id: "ledger",
    label: "Ledger balance",
    role: "Source check",
    purpose:
      "Confirm $7,000 has already been posted. An adjustment must record only the difference.",
    region: 0,
    ...at(0, 3, 3),
    evidence: ["ledger"],
  },
  {
    id: "schema",
    label: "Schema valid?",
    role: "Deterministic guard",
    purpose:
      "Require all four source checks and valid required fields before joining records. One completed check cannot satisfy this join.",
    region: 0,
    ...at(0, SPINE, 4),
    evidence: [],
    kind: "guard",
  },
  {
    id: "invalid",
    label: "Invalid source",
    role: "Wait for input",
    purpose:
      "Alternative: malformed source data blocks matching. Wait for corrected input and rerun the affected checks.",
    region: 0,
    ...at(0, 3, 4),
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
    ...at(1, SPINE, 5),
    evidence: ["contract", "work", "invoice", "ledger"],
  },
  {
    id: "agrees",
    label: "Evidence agrees?",
    role: "Decision guard",
    purpose:
      "Compare supported rates and amounts. An unexplained conflict requires investigation; agreement can verify an unchanged accrual.",
    region: 1,
    ...at(1, SPINE, 6),
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
    ...at(1, 3, 6),
    evidence: ["ledger", "invoice-original"],
  },
  {
    id: "mailbox",
    label: "Search the mailbox",
    role: "Investigation agent",
    purpose:
      "Look for authorized evidence that resolves the $100 versus $110 rate conflict.",
    region: 2,
    ...at(2, SPINE, 7),
    evidence: ["invoice"],
  },
  {
    id: "threads",
    label: "Search email threads",
    role: "Investigation tool",
    purpose:
      "Find the signed amendment and a separate unapproved $130 request; preserve their source metadata.",
    region: 2,
    ...at(2, SPINE, 8),
    evidence: ["amendment", "excluded"],
  },
  {
    id: "attachments",
    label: "Read attachments",
    role: "Extraction tool",
    purpose:
      "Read the signed September 14 amendment attachment. References without bytes display excerpts only.",
    region: 2,
    ...at(2, SPINE, 9),
    evidence: ["amendment"],
  },
  {
    id: "authority",
    label: "Authorized & effective?",
    role: "Decision guard",
    purpose:
      "Require an authorized signature and an effective date covering the approved work. An unapproved request never changes the rate.",
    region: 2,
    ...at(2, SPINE, 10),
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
    ...at(2, SPINE, 11),
    evidence: ["amendment", "work"],
  },
  {
    id: "retry",
    label: "Retry provider call",
    role: "Bounded retry · max 2",
    purpose:
      "Alternative: a temporary provider failure may retry twice. Exhaustion blocks the run and never produces a proposal.",
    region: 2,
    ...at(2, 0, 7),
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
    ...at(2, 3, 8),
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
    ...at(2, 3, 10),
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
    ...at(3, SPINE, 12),
    evidence: ["ledger", "amendment", "work"],
  },
  {
    id: "balance",
    label: "Period + balance valid?",
    role: "Deterministic guard",
    purpose:
      "Verify the September period and balanced debit/credit lines. A failed validation blocks review and export.",
    region: 3,
    ...at(3, SPINE, 13),
    evidence: [],
    kind: "guard",
  },
  {
    id: "proposal",
    label: "Save proposal",
    role: "Versioned · hashed",
    purpose:
      "Persist an immutable, hashed proposal bound to the input revision and policy version. Any later input change creates a new version.",
    region: 3,
    ...at(3, SPINE, 14),
    evidence: ["ledger", "amendment"],
  },
  {
    id: "approved",
    label: "Approval recorded",
    role: "Human · email ack",
    purpose:
      "An approval binds to this exact proposal hash and revision. It never posts anything; it only unlocks export of the approved version.",
    region: 3,
    ...at(3, SPINE, 16),
    evidence: [],
  },
  {
    id: "review",
    label: "Your decision",
    role: "Human · demo email",
    purpose:
      "A human email decision binds to the current proposal version. Demo controls simulate an acknowledged email event only.",
    region: 3,
    ...at(3, SPINE, 15),
    evidence: ["amendment", "ledger"],
  },
  {
    id: "question",
    label: "Question received",
    role: "Human question",
    purpose:
      "Ask why returns a concise, cited explanation and then resumes pending review. It is neither approval nor rejection.",
    region: 3,
    ...at(3, 3, 15),
    evidence: ["amendment", "excluded"],
  },
  {
    id: "rejected",
    label: "Rejected / stale",
    role: "Revision required",
    purpose:
      "Keep the rejection reason and old proposal. Material input changes invalidate approval and rerun affected checks; a new version needs fresh approval.",
    region: 3,
    ...at(3, 0, 15),
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
    ...at(3, SPINE, 17),
    evidence: [],
  },
];
export interface Link {
  source: string;
  target: string;
  label?: string;
  route?: Route;
}
const node = (id: string) => steps.find((s) => s.id === id)!;
const pt = (id: string, side: Parameters<typeof anchor>[1], f = 0.5) => anchor(node(id), side, f);
const checks = ["contract", "work", "invoice", "ledger"];
export const links: Link[] = [
  { source: "import", target: "accrual" },
  { source: "accrual", target: "read" },
  // Org-chart style: one trunk, a shared bus, then a drop into each check (and back).
  ...checks.map((target) => {
    const bus = (pt("read", "bottom").y + pt(target, "top").y) / 2;
    return {
      source: "read",
      target,
      route: {
        via: [
          { x: pt("read", "bottom").x, y: bus },
          { x: pt(target, "top").x, y: bus },
        ],
      },
    };
  }),
  ...checks.map((source) => {
    const bus = (pt(source, "bottom").y + pt("schema", "top").y) / 2;
    return {
      source,
      target: "schema",
      route: {
        via: [
          { x: pt(source, "bottom").x, y: bus },
          { x: pt("schema", "top").x, y: bus },
        ],
      },
    };
  }),
  { source: "schema", target: "invalid", label: "invalid" },
  {
    source: "invalid",
    target: "read",
    label: "corrected input",
    route: {
      from: "right",
      to: "right",
      labelAt: 0.5,
      via: [
        { x: CORRIDOR.right, y: pt("invalid", "right").y },
        { x: CORRIDOR.right, y: pt("read", "right").y },
      ],
    },
  },
  // Label sits in the gap between stages, clear of the next stage border.
  { source: "schema", target: "match", label: "valid", route: { labelAt: 0.38 } },
  { source: "match", target: "agrees" },
  { source: "agrees", target: "unchanged", label: "no difference" },
  // Label sits in the gap between stages, clear of the next stage border.
  { source: "agrees", target: "mailbox", label: "rate conflict", route: { labelAt: 0.38 } },
  {
    source: "agrees",
    target: "calculate",
    label: "supported",
    route: {
      from: "left",
      to: "left",
      labelAt: 0.5,
      via: [
        { x: CORRIDOR.left, y: pt("agrees", "left").y },
        { x: CORRIDOR.left, y: pt("calculate", "left").y },
      ],
    },
  },
  {
    source: "mailbox",
    target: "retry",
    label: "temporary error",
    route: { fromAt: 0.3, toAt: 0.3 },
  },
  {
    source: "retry",
    target: "mailbox",
    label: "retry",
    route: { fromAt: 0.7, toAt: 0.7 },
  },
  { source: "mailbox", target: "threads" },
  { source: "threads", target: "missing", label: "no match" },
  {
    source: "missing",
    target: "mailbox",
    label: "new evidence",
    route: {
      from: "top",
      to: "right",
      toAt: 0.7,
      labelAt: 0.35,
      via: [{ x: pt("missing", "top").x, y: pt("mailbox", "right", 0.7).y }],
    },
  },
  { source: "threads", target: "attachments" },
  { source: "attachments", target: "authority" },
  { source: "authority", target: "amendment", label: "valid" },
  { source: "authority", target: "conflict", label: "conflict" },
  // Label sits in the gap between stages, clear of the next stage border.
  { source: "amendment", target: "calculate", label: "supported", route: { labelAt: 0.38 } },
  { source: "calculate", target: "balance" },
  { source: "balance", target: "proposal", label: "valid" },
  { source: "proposal", target: "review" },
  { source: "review", target: "approved", label: "approve" },
  { source: "approved", target: "export" },
  {
    source: "balance",
    target: "rejected",
    label: "invalid",
    route: {
      from: "left",
      to: "top",
      labelAt: 0.4,
      via: [{ x: pt("rejected", "top").x, y: pt("balance", "left").y }],
    },
  },
  { source: "review", target: "rejected", label: "reject" },
  {
    source: "review",
    target: "question",
    label: "ask why",
    route: { fromAt: 0.3, toAt: 0.3 },
  },
  {
    source: "question",
    target: "review",
    label: "answered",
    route: { fromAt: 0.7, toAt: 0.7 },
  },
  {
    source: "question",
    target: "mailbox",
    label: "investigate",
    route: {
      from: "right",
      to: "right",
      toAt: 0.3,
      labelAt: 0.5,
      via: [
        { x: CORRIDOR.right, y: pt("question", "right").y },
        { x: CORRIDOR.right, y: pt("mailbox", "right", 0.3).y },
      ],
    },
  },
  {
    source: "rejected",
    target: "read",
    label: "new revision",
    route: {
      from: "left",
      to: "left",
      labelAt: 0.91, // on the quiet stretch beside "Read the evidence"
      via: [
        { x: CORRIDOR.left2, y: pt("rejected", "left").y },
        { x: CORRIDOR.left2, y: pt("read", "left").y },
      ],
    },
  },
];
export const edgeId = (a: string, b: string) => `${a}:${b}`;
