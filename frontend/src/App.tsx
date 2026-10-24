import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  FileText,
  Play,
  Pause,
  RotateCcw,
  Radio,
  ChevronRight,
  ArrowLeft,
  CircleHelp,
} from "lucide-react";
import { ExecutionGraph, CloseButton } from "./components/ExecutionGraph";
import { EvidenceViewer } from "./components/EvidenceViewer";
import { ReviewPanel } from "./components/ReviewPanel";
import { MockReviewAdapter } from "./data/mockReviewAdapter";
import { CASE_ID, variants } from "./data/fixtures";
import { steps } from "./data/topology";
import {
  acceptSnapshot,
  money,
  type CaseSnapshot,
  type EvidenceRecord,
  type Variant,
} from "./data/reviewAdapter";
const statusLabels: Record<CaseSnapshot["status"], string> = {
  ready: "Ready to review",
  running: "Review running",
  waiting: "Waiting for evidence",
  review: "Awaiting your review",
  approved: "Approved · demo",
  rejected: "Rejected · revision needed",
  exported: "Exported — not posted",
  verified: "Verified — no change",
  blocked: "Review blocked",
};
export default function App({
  providedAdapter,
}: {
  providedAdapter?: MockReviewAdapter;
}) {
  const [adapter] = useState(() => providedAdapter ?? new MockReviewAdapter());
  const [snapshot, setSnapshot] = useState<CaseSnapshot>(adapter.snapshot);
  const [screen, setScreen] = useState<"review" | "overview">("review");
  const [selected, setSelected] = useState<string | null>(null);
  const [inspector, setInspector] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [follow, setFollow] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceRecord | null>(null);
  const [error, setError] = useState("");
  const reviewRef = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      adapter.subscribeCase(CASE_ID, (incoming) =>
        setSnapshot((current) => acceptSnapshot(current, incoming)),
      ),
    [adapter],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (evidence) setEvidence(null);
        else if (inspector) setInspector(false);
        else setExpanded(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [evidence, inspector]);
  const openEvidence = async (id: string) => {
    try {
      setEvidence(
        await adapter.getEvidence(
          snapshot.variant === "no-change" && id === "invoice"
            ? "invoice-original"
            : id,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Evidence unavailable.");
    }
  };
  const select = (id: string) => {
    setSelected(id);
    setInspector(true);
  };
  const step = steps.find((s) => s.id === selected);
  const proposal = snapshot.proposal;
  const stale = proposal && proposal.inputRevision !== snapshot.inputRevision;
  const reset = (variant = snapshot.variant) => {
    adapter.reset(variant);
    setEvidence(null);
    setError("");
    setSelected(null);
    setInspector(false);
  };
  return (
    <div className="app-shell">
      <header className="app-header">
        <a
          href="#"
          className="wordmark"
          onClick={(e) => {
            e.preventDefault();
            setScreen("review");
          }}
        >
          <span className="brand-mark">
            a<span>h</span>
          </span>
          AfterHours
        </a>
        <nav aria-label="Main navigation">
          <button
            className={screen === "review" ? "active" : ""}
            onClick={() => setScreen("review")}
          >
            Review workspace
          </button>
          <button
            className={screen === "overview" ? "active" : ""}
            onClick={() => setScreen("overview")}
          >
            Overview
          </button>
        </nav>
        <div className="company">
          <strong>Cedar Labs</strong>
          <span>September 2026</span>
        </div>
        <span className="avatar" aria-label="Taylor Morgan, demo reviewer">
          TM
        </span>
      </header>
      <div className="demo-banner">
        <span>
          <Radio size={13} />
          <strong>Synthetic demo</strong> · deterministic replay · no live
          agents or email
        </span>
        <span className="connection">
          <i />
          Mock adapter connected
        </span>
      </div>
      <main>
        <div className="page-heading">
          <div className="page-context">
            Reviews <ChevronRight size={13} /> {CASE_ID}
          </div>
          <div className="title-row">
            <div>
              <h1>
                {screen === "overview"
                  ? "Accrual reviews"
                  : "A clearer close, one review at a time."}
              </h1>
              <p>
                {screen === "overview"
                  ? "One synthetic case, with a complete evidence trail."
                  : "Acme Services"}
                {screen === "review" && (
                  <>
                    <span className="divider">/</span>September services
                    <span className="divider">/</span>
                    <span className="mono">JE-0098</span>
                  </>
                )}
              </p>
            </div>
            <div className="title-note">
              <FileText size={16} />
              <span>
                Existing accrual review
                <br />
                <strong>No automatic posting</strong>
              </span>
            </div>
          </div>
        </div>
        {error && (
          <div className="notice rust" role="alert">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {screen === "overview" ? (
          <section className="overview-panel">
            <div className="section-heading">
              <h2>September 2026</h2>
              <span className="pill">1 synthetic case</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th>Case reference</th>
                    <th>Original accrual</th>
                    <th>Current status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <strong>Acme Services</strong>
                      <small>Cedar Labs</small>
                    </td>
                    <td className="mono">{CASE_ID}</td>
                    <td>
                      {money(snapshot.original)} <small>Already posted</small>
                    </td>
                    <td>
                      <span className="pill">
                        {statusLabels[snapshot.status]}
                      </span>
                    </td>
                    <td>
                      <button
                        className="secondary"
                        onClick={() => setScreen("review")}
                      >
                        Open review <ArrowUpRight size={15} />
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <>
            <section className="summary" aria-label="Review summary">
              <div>
                <span>Original accrual</span>
                <strong>{money(snapshot.original)}</strong>
                <small>
                  <span className="tiny-dot" />
                  Already posted · JE-0098
                </small>
              </div>
              <div>
                <span>Corrected target</span>
                <strong>
                  {snapshot.status === "verified"
                    ? money(snapshot.original)
                    : proposal
                      ? money(proposal.target)
                      : "—"}
                </strong>
                <small>
                  {stale
                    ? "Prior version · rerunning checks"
                    : proposal
                      ? "Validated computation"
                      : snapshot.status === "verified"
                        ? "No correction needed"
                        : "Waiting for validated computation"}
                </small>
              </div>
              <div>
                <span>Proposed adjustment</span>
                <strong className="green">
                  {proposal ? money(proposal.difference, true) : "—"}
                </strong>
                <small>
                  {proposal
                    ? `Proposal V${proposal.version}${stale ? " · stale" : ""}`
                    : "Only the difference will be proposed"}
                </small>
              </div>
              <div className="status-summary">
                <span>Case status</span>
                <strong className={`case-status ${snapshot.status}`}>
                  {statusLabels[snapshot.status]}
                </strong>
                <small>
                  {snapshot.status === "review"
                    ? "Human approval is the next step"
                    : snapshot.paused
                      ? "Demo playback paused"
                      : snapshot.status === "ready"
                        ? "Start the deterministic demo below"
                        : "Synthetic · replayed workflow"}
                </small>
              </div>
            </section>
            <div className="playback-bar">
              <div className="fixture-picker">
                <span>Demo playback</span>
                <select
                  aria-label="Demo fixture"
                  value={snapshot.variant}
                  onChange={(e) => reset(e.target.value as Variant)}
                >
                  {variants.map((v) => (
                    <option key={v.value} value={v.value}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="playback-actions">
                {snapshot.status === "ready" ? (
                  <button
                    className="primary"
                    onClick={() => void adapter.startReview(CASE_ID)}
                  >
                    <Play size={14} />
                    Start review
                  </button>
                ) : (
                  <>
                    <button
                      className="secondary"
                      disabled={snapshot.status !== "running"}
                      onClick={() => adapter.pause()}
                    >
                      {snapshot.paused ? (
                        <Play size={14} />
                      ) : (
                        <Pause size={14} />
                      )}{" "}
                      {snapshot.paused ? "Resume" : "Pause"}
                    </button>
                    <button
                      className="secondary"
                      onClick={() => {
                        reset();
                        void adapter.startReview(CASE_ID);
                      }}
                    >
                      <RotateCcw size={14} />
                      Replay
                    </button>
                  </>
                )}
                <button className="text-button" onClick={() => reset()}>
                  Reset
                </button>
              </div>
            </div>
            {snapshot.blocker && (
              <div className="notice amber" role="status">
                <strong>{statusLabels[snapshot.status]}</strong>
                <p>{snapshot.blocker}</p>
                {snapshot.status === "waiting" && (
                  <button
                    className="secondary"
                    onClick={() => adapter.revise()}
                  >
                    Simulate corrected evidence
                  </button>
                )}
              </div>
            )}
            <section
              className={`workspace ${expanded ? "expanded" : ""}`}
              aria-label="State machine workspace"
            >
              <div className="graph-panel">
                <ExecutionGraph
                  snapshot={snapshot}
                  selected={selected}
                  onSelect={select}
                  expanded={expanded}
                  onExpand={() => setExpanded(!expanded)}
                  follow={follow}
                  onFollow={() => setFollow(!follow)}
                  onInspector={() => {
                    if (!selected) setSelected("read");
                    setInspector(!inspector);
                  }}
                />
              </div>
              {inspector && step && (
                <aside className="step-inspector" aria-label="Step inspector">
                  <div className="inspector-header">
                    <span>Step inspector</span>
                    <CloseButton
                      label="Close step inspector"
                      onClick={() => setInspector(false)}
                    />
                  </div>
                  <div className="step-id">
                    {step.id.toUpperCase()}{" "}
                    <span className={`pill ${snapshot.nodeStates[step.id]}`}>
                      {snapshot.nodeStates[step.id]}
                    </span>
                  </div>
                  <h2>{step.label}</h2>
                  <p className="role-label">{step.role}</p>
                  <p>{step.purpose}</p>
                  {snapshot.nodeStates[step.id] === "dormant" && (
                    <div className="notice muted">
                      This alternative has not been visited in the current run.
                    </div>
                  )}
                  {snapshot.nodeStates[step.id] === "queued" && (
                    <div className="notice">
                      Waiting for all required parallel source checks.
                    </div>
                  )}
                  <h3>Linked evidence</h3>
                  {step.evidence.length ? (
                    <div className="inspector-evidence">
                      {step.evidence.map((id) => (
                        <button onClick={() => void openEvidence(id)} key={id}>
                          <FileText size={15} />
                          <span>
                            {id === "excluded"
                              ? "Unapproved $130 request"
                              : id === "amendment"
                                ? "Signed rate amendment"
                                : id === "invoice"
                                  ? "Received invoice · unposted"
                                  : id}
                          </span>
                          <ChevronRight size={14} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="muted small">
                      This state uses validated workflow results.
                    </p>
                  )}
                  {[
                    "review",
                    "export",
                    "question",
                    "rejected",
                    "calculate",
                    "balance",
                  ].includes(step.id) && (
                    <button
                      className="primary"
                      onClick={() => {
                        setExpanded(false);
                        setInspector(false);
                        setTimeout(
                          () =>
                            reviewRef.current?.scrollIntoView({
                              behavior: "smooth",
                              block: "start",
                            }),
                          0,
                        );
                      }}
                    >
                      View correction & decision <ArrowUpRight size={14} />
                    </button>
                  )}
                  <div className="inspector-note">
                    <CircleHelp size={16} />
                    <p>
                      Sources explain the result. Internal model reasoning is
                      never displayed.
                    </p>
                  </div>
                </aside>
              )}
            </section>
            <div className="detail-grid">
              <div ref={reviewRef} className="review-card">
                <ReviewPanel
                  key={snapshot.runId}
                  snapshot={snapshot}
                  adapter={adapter}
                  onEvidence={(id) => void openEvidence(id)}
                />
              </div>
              <section className="activity-panel">
                <div className="section-heading">
                  <h2>Activity</h2>
                  <span className="mono">{snapshot.events.length} events</span>
                </div>
                <p className="small muted">
                  Timestamped fixture events · replayed
                </p>
                {snapshot.events.length === 0 ? (
                  <div className="empty-activity">
                    <ClockIcon />
                    <p>The evidence trail starts when you run the review.</p>
                  </div>
                ) : (
                  <ol className="activity-list">
                    {[...snapshot.events].reverse().map((event) => (
                      <li key={event.id}>
                        <time>{event.time.slice(11, 19)} UTC</time>
                        <div>
                          <strong>{event.action}</strong>
                          <p>{event.outcome}</p>
                          <span className="actor">
                            {event.actor}
                            {event.proposalVersion
                              ? ` · V${event.proposalVersion}`
                              : ""}
                          </span>
                          {event.evidenceIds.length > 0 && (
                            <div className="activity-sources">
                              {event.evidenceIds.map((id) => (
                                <button
                                  key={id}
                                  onClick={() => void openEvidence(id)}
                                >
                                  {id}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          </>
        )}
        <footer>
          <span>
            AfterHours <span className="divider">/</span> Evidence before
            entries.
          </span>
          <span>
            Synthetic company · demo reviewer · no production identity controls
          </span>
        </footer>
      </main>
      {evidence && (
        <EvidenceViewer evidence={evidence} onClose={() => setEvidence(null)} />
      )}
    </div>
  );
}
function ClockIcon() {
  return <ArrowLeft size={20} />;
}
