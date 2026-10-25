import { Activity, CheckCircle2, Clock3, LoaderCircle, TriangleAlert } from "lucide-react";
import { steps } from "../data/topology";
import { graphFocusStep } from "../data/graphFocus";
import type { CaseSnapshot, NodeStatus } from "../data/reviewAdapter";

const copy: Record<string, { title: string; detail: string; inputs: string[] }> = {
  import: { title: "Validating uploaded sources", detail: "The gateway is storing the original files and checking schemas, dates, and duplicate work rows.", inputs: ["Accrual JSON", "Contract", "Timesheet", "Invoice", "Ledger"] },
  read: { title: "Extracting evidence", detail: "The extraction worker is reading source facts and attaching citations to the review.", inputs: ["Contract terms", "Approved work", "Invoice coverage", "Ledger balance"] },
  match: { title: "Connecting the records", detail: "The matching worker is joining vendor, dates, rates, invoice coverage, and the posted entry.", inputs: ["Vendor identity", "Service period", "Source facts"] },
  mailbox: { title: "Investigating the rate conflict", detail: "The investigation worker is searching the vendor mailbox for authorized evidence that resolves the rate difference.", inputs: ["Mailbox", "Email threads", "Attachments"] },
  threads: { title: "Reading relevant threads", detail: "The pipeline is separating signed authority from unapproved requests and unrelated messages.", inputs: ["Signed amendment", "Sender authority", "Effective date"] },
  attachments: { title: "Checking the attachment", detail: "The pipeline is extracting the signed amendment and verifying its source metadata.", inputs: ["Attachment bytes", "Signature", "Effective date"] },
  authority: { title: "Checking authority and effective date", detail: "A deterministic guard is deciding whether the evidence is authorized and covers the service period.", inputs: ["Authorized signatory", "Effective date", "Approved work"] },
  amendment: { title: "Verifying the amendment", detail: "The evidence check is applying the supported rate to the qualifying work.", inputs: ["Signed rate", "Effective period", "Approved minutes"] },
  calculate: { title: "Calculating the correction", detail: "Deterministic accounting code is calculating only the difference from the amount already posted.", inputs: ["Posted accrual", "Corrected target", "Adjustment"] },
  balance: { title: "Checking period and balance", detail: "The proposal is being checked for a valid period and balanced debit/credit lines.", inputs: ["Entry date", "Debit total", "Credit total"] },
  proposal: { title: "Saving the proposal", detail: "The validated correction is being versioned and hashed before human review.", inputs: ["Proposal version", "Evidence citations", "Journal lines"] },
  review: { title: "Ready for human review", detail: "The pipeline has finished its checks. Review the cited evidence and proposed journal entry.", inputs: ["Correction", "Evidence trail", "Journal entry"] },
};
function activeStep(snapshot: CaseSnapshot) {
  return steps.find((step) => step.id === graphFocusStep(snapshot))!;
}
function statusIcon(status: NodeStatus) {
  if (status === "running") return <LoaderCircle className="spin" size={16} />;
  if (status === "waiting") return <Clock3 size={16} />;
  if (status === "blocked") return <TriangleAlert size={16} />;
  return <CheckCircle2 size={16} />;
}
export function LiveProgress({ snapshot }: { snapshot: CaseSnapshot }) {
  const active = activeStep(snapshot);
  const detail = { ...(copy[active.id] ?? { title: active.label, detail: active.purpose, inputs: active.evidence }) };
  const meaningful = steps.filter((step) => !["invalid", "unchanged", "retry", "missing", "conflict", "rejected", "question", "approved", "export"].includes(step.id));
  const complete = meaningful.filter((step) => snapshot.nodeStates[step.id] === "complete").length;
  const current = snapshot.nodeStates[active.id];
  if (current === "blocked" && active.id === "proposal") detail.title = "Proposal validation blocked";
  const terminal = ["review", "approved", "exported", "verified"].includes(snapshot.status);
  const percent = terminal ? 100 : Math.min(96, Math.round(((complete + (current === "running" ? 0.45 : 0)) / meaningful.length) * 100));
  return <aside className="live-progress" aria-live="polite" aria-label="Live pipeline progress">
    <div className="live-progress-header"><span className="live-progress-kicker"><Activity size={14} /> Live pipeline</span><strong>{percent}%</strong></div>
    <div className="progress-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Pipeline progress"><span style={{ width: `${percent}%` }} /></div>
    <div className={`live-progress-state ${current}`}>{statusIcon(current)}<div><strong>{detail.title}</strong><span>{active.role} · {current}</span></div></div>
    <p>{snapshot.blocker || detail.detail}</p>
    <div className="live-progress-inputs">{detail.inputs.map((input) => <span key={input}>{input}</span>)}</div>
    {snapshot.events.length > 0 && <div className="execution-trace">
      <div className="execution-trace-title">Execution trace <span>observed checkpoints</span></div>
      <ol>{[...snapshot.events].reverse().map((event, index) => <li key={event.id}>{index === 0 && snapshot.status === "running" ? <LoaderCircle className="trace-spinner" size={12} /> : index === 0 && snapshot.blocker ? <TriangleAlert size={12} /> : <CheckCircle2 className="trace-check" size={12} />}<div><strong>{event.action}</strong><span>{event.outcome}</span></div></li>)}</ol>
    </div>}
    {snapshot.connection !== "connected" && <small>{snapshot.connection === "connecting" ? "Connecting to API…" : "API connection interrupted; retrying…"}</small>}
  </aside>;
}
