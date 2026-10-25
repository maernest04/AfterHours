import { useState } from "react";
import {
  Download,
  Copy,
  MessageCircle,
  Check,
  XCircle,
  RefreshCw,
} from "lucide-react";
import type { CaseSnapshot, ReviewAdapter } from "../data/reviewAdapter";
import { canExport, journalText, money } from "../data/reviewAdapter";
export function ReviewPanel({
  snapshot: s,
  adapter,
  onEvidence,
}: {
  snapshot: CaseSnapshot;
  adapter: ReviewAdapter;
  onEvidence: (id: string) => void;
}) {
  const [pending, setPending] = useState(false),
    [question, setQuestion] = useState("Why did the $100 contract post $7,000 when the timesheets are at $110?"),
    [reason, setReason] = useState(""),
    [action, setAction] = useState<"question" | "reject" | null>(null),
    [error, setError] = useState(""),
    [copy, setCopy] = useState(""),
    [fallback, setFallback] = useState("");
  const p = s.proposal;
  const run = async (fn: () => Promise<void>) => {
    setPending(true);
    setError("");
    try {
      await fn();
      setAction(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setPending(false);
    }
  };
  const downloadable = canExport(s) && s.exportEligible;
  const download = async () => {
    if (!p) return;
    const blob = await adapter.exportJournal(s.caseId, p.version);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${s.caseId}-V${p.version}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copyTable = async () => {
    if (!p || !canExport(s)) return;
    const text = journalText(p.lines, "\t");
    try {
      await navigator.clipboard.writeText(text);
      setCopy("Table copied as spreadsheet rows.");
    } catch {
      setFallback(text);
      setCopy("Clipboard access unavailable. Select and copy the table below.");
    }
  };
  if (!p)
    return (
      <div className="empty-review">
        <h3>
          {s.status === "verified"
            ? "Verified — no change"
            : "Correction review"}
        </h3>
        <p>
          {s.status === "verified"
            ? "The existing $7,000 accrual is supported. There is no adjustment or CSV to approve."
            : "The correction and journal lines will appear after evidence and calculation checks pass."}
        </p>
      </div>
    );
  const stale = p.inputRevision !== s.inputRevision;
  const canDecide =
    s.status === "review" &&
    !s.pendingQuestion &&
    !pending &&
    !s.blocker &&
    p.valid &&
    !stale;
  return (
    <section className="review-panel">
      <div className="section-heading">
        <h3>
          Proposed correction <span className="version">V{p.version}</span>
        </h3>
        <span className={`pill ${stale ? "amber" : ""}`}>
          {stale
            ? "Stale proposal"
            : s.approvedVersion === p.version
              ? s.connection === "demo"
                ? "Demo approval recorded"
                : "Posted to QuickBooks"
              : "Human review required"}
        </span>
      </div>
      <div className="review-amounts">
        <div>
          <span>Posted original</span>
          <strong>{money(s.original)}</strong>
        </div>
        <div>
          <span>Corrected target</span>
          <strong>{money(p.target)}</strong>
        </div>
        <div>
          <span>Adjustment only</span>
          <strong>{money(p.difference, true)}</strong>
        </div>
      </div>
      <p>{p.explanation}</p>
      <div className="source-links">
        {p.evidenceIds.map((id) => (
          <button key={id} onClick={() => onEvidence(id)}>
            {id === "excluded" ? "Excluded rate request" : id}
          </button>
        ))}
      </div>
      <div className="table-scroll">
        <table className="journal-table">
          <caption>
            {p.lines[0]?.entryDate || "Entry date unavailable"} · {s.caseId}-V{p.version}
          </caption>
          <thead>
            <tr>
              <th>Account</th>
              <th>Debit</th>
              <th>Credit</th>
            </tr>
          </thead>
          <tbody>
            {p.lines.map((l) => (
              <tr key={l.accountCode}>
                <td>
                  <span>{l.accountCode}</span> {l.accountName}
                  {l.description ? <small>{l.description}</small> : null}
                </td>
                <td>{money(l.debit)}</td>
                <td>{money(l.credit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        {s.connection === "demo"
          ? "Generic journal-entry format. Account and column mapping may be required. Exporting does not post an entry."
          : "Approve binds this proposal hash and posts the journal through the gateway. The browser never talks to QuickBooks."}
      </p>
      {s.rejectionReason && (
        <div className="notice rust">
          <strong>Rejection retained</strong>
          <p>{s.rejectionReason}</p>
        </div>
      )}
      {s.pendingQuestion && (
        <div role="status" className="notice amber">
          Preparing a cited response. Approval is locked while the question is
          pending.
        </div>
      )}
      {s.answer && (
        <div className="notice">
          <strong>Answer · replayed investigation</strong>
          <p>{s.answer}</p>
          <button
            className="text-button"
            onClick={() => onEvidence("amendment")}
          >
            Read cited amendment
          </button>
        </div>
      )}
      <div className="review-identity">
        {s.connection === "demo" ? (
          <>
            Taylor Morgan · demo reviewer{" "}
            <span>Simulated email actions; no email is sent.</span>
          </>
        ) : (
          <>
            Live reviewer{" "}
            <span>Approve posts case {s.caseId} to QuickBooks.</span>
          </>
        )}
      </div>
      <div className="review-actions">
        <button
          className="primary"
          disabled={!canDecide}
          onClick={() => void run(() => adapter.approve(s.caseId, p.version))}
        >
          <Check size={15} />
          Approve
        </button>
        <button
          className="secondary"
          disabled={!canDecide}
          onClick={() => setAction("reject")}
        >
          <XCircle size={15} />
          Reject
        </button>
        <button
          className="secondary"
          disabled={!canDecide}
          onClick={() => setAction("question")}
        >
          <MessageCircle size={15} />
          Ask why
        </button>
      </div>
      {action && (
        <form
          className="decision-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              action === "reject"
                ? adapter.reject(s.caseId, p.version, reason)
                : adapter.askQuestion(s.caseId, p.version, question),
            );
          }}
        >
          <label htmlFor="decision-text">
            {action === "reject" ? "Reason for rejection" : "Your question"}
          </label>
          <textarea
            id="decision-text"
            autoFocus
            required
            value={action === "reject" ? reason : question}
            onChange={(e) =>
              action === "reject"
                ? setReason(e.target.value)
                : setQuestion(e.target.value)
            }
            disabled={pending}
          />
          <button
            className="primary"
            disabled={
              pending || !(action === "reject" ? reason : question).trim()
            }
          >
            {pending
              ? "Waiting for acknowledgement…"
              : `Simulate ${action === "reject" ? "rejection" : "question"} email`}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={pending}
            onClick={() => setAction(null)}
          >
            Cancel
          </button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="export-actions">
        <button
          disabled={!downloadable || pending}
          className="primary"
          onClick={() => void run(download)}
        >
          <Download size={15} />
          Download CSV
        </button>
        <button
          disabled={!downloadable || pending}
          className="secondary"
          onClick={() => void copyTable()}
        >
          <Copy size={15} />
          Copy table
        </button>
      </div>
      {!downloadable && (
        <p className="small muted">
          Export is locked until this exact, valid proposal has a current
          approval.
        </p>
      )}
      {s.status === "exported" && (
        <p className="success">Exported — not posted</p>
      )}
      {copy && (
        <p role="status" className="small">
          {copy}
        </p>
      )}
      {fallback && downloadable && (
        <textarea
          className="copy-fallback"
          aria-label="Manual spreadsheet copy"
          readOnly
          value={fallback}
          onFocus={(e) => e.target.select()}
        />
      )}{" "}
      {s.connection === "demo" &&
        ["rejected", "approved", "exported"].includes(s.status) &&
        adapter.revise && (
        <button
          className="text-button revision-button"
          onClick={() => {
            setCopy("");
            setFallback("");
            adapter.revise?.();
          }}
        >
          <RefreshCw size={14} />
          Simulate revised evidence · requires fresh approval
        </button>
      )}
      {s.status === "approved" && s.connection !== "demo" && (
        <p className="success">Posted to QuickBooks</p>
      )}
    </section>
  );
}
