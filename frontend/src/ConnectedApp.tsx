import { useMemo, useState } from "react";
import App from "./App";
import { ApiReviewAdapter } from "./data/apiReviewAdapter";
import { ReviewApi } from "./services/reviewApi";
import { buildDemoPackage, type DemoScenario } from "./data/demoPackage";

const apiBase = import.meta.env.VITE_API_URL || "/api";

export default function ConnectedApp() {
  const [reviewId, setReviewId] = useState(() => {
    const fromEnv = import.meta.env.VITE_REVIEW_ID || "";
    if (fromEnv) return fromEnv;
    const fromQuery = new URLSearchParams(window.location.search).get("review") || "";
    return /^[1-9][0-9]{0,19}$/.test(fromQuery) ? fromQuery : "";
  });
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scenario, setScenario] = useState<DemoScenario>("amendment");
  const [loadedScenario, setLoadedScenario] = useState<string | null>(null);
  const adapter = useMemo(() => reviewId ? new ApiReviewAdapter(reviewId, apiBase) : null, [reviewId]);
  if (adapter) return <App key={reviewId} providedAdapter={adapter} />;

  const create = async () => {
    if (!files.length) return;
    setBusy(true); setError("");
    try {
      const names = files.map((file) => file.name.toLowerCase());
      const required = [".json", "msa", "timesheet", "invoice", "ledger"];
      const missing = required.filter((part) => !names.some((name) => name.includes(part)));
      if (!loadedScenario && names.some((name) => name.includes("timesheet") && name.includes("v1"))) {
        throw new Error("Select only the v2 timesheet; remove the v1 timesheet.");
      }
      if (!loadedScenario && missing.length) throw new Error(`Missing required source: ${missing.join(", ")}.`);
      setReviewId((await new ReviewApi(apiBase).create(files)).review_id);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create review."); }
    finally { setBusy(false); }
  };
  const useDemoFiles = async () => {
    setBusy(true); setError("");
    try {
      const documents = await buildDemoPackage(scenario, async (name) => {
        const response = await fetch(`/demo-files/${name}`);
        if (!response.ok) throw new Error(`Unable to load demo file ${name}.`);
        return response.text();
      });
      setFiles(documents.map(({ name, type, text }) => new File([text], name, { type })));
      setLoadedScenario(scenario);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load demo files."); }
    finally { setBusy(false); }
  };
  return (
    <main className="connected-start app-shell">
      <div className="connected-start-card">
        <div className="brand-mark">a<span>h</span></div>
        <p className="eyebrow">AfterHours · connected mode</p>
        <h1>Start an accrual review</h1>
        <p>Upload the accrual, contract, timesheet, invoice, and ledger sources. The backend validates them, starts the worker pipeline, and brings the live graph into the review workspace.</p>
        <label className="upload-dropzone">
          <strong>Select source files</strong>
          <span>{files.length ? `${files.length} file${files.length === 1 ? "" : "s"} selected` : "Choose the supported source files"}</span>
          <input type="file" multiple accept=".json,.csv,.txt,application/json,text/csv,text/plain" onChange={(event) => { setLoadedScenario(null); setFiles(Array.from(event.target.files ?? [])); }} />
        </label>
        <label className="scenario-picker">Demo package
          <select value={scenario} onChange={(event) => { setScenario(event.target.value as DemoScenario); setLoadedScenario(null); setFiles([]); }} disabled={busy}>
            <option value="amendment">Signed amendment · happy path</option>
            <option value="missing-invoice">Missing invoice · blocked evidence</option>
            <option value="duplicate-work">Duplicate timesheet · validation guard</option>
            <option value="invalid-accrual">Malformed accrual · validation guard</option>
          </select>
        </label>
        <button className="secondary demo-files-button" disabled={busy} onClick={() => void useDemoFiles()}>Use built-in demo files</button>
        <p className="small muted">Each demo package uses a separate synthetic vendor and includes its signed amendment. You can repeat runs without overlapping earlier reviews.</p>
        {files.length > 0 && <ul className="selected-files">{files.map((file) => <li key={`${file.name}-${file.size}`}>{file.name}</li>)}</ul>}
        <button className="primary start-button" disabled={!files.length || busy} onClick={() => void create()}>{busy ? "Creating review…" : "Create and watch review"}</button>
        {error && <p className="error" role="alert">{error}</p>}
        <p className="small muted">The browser only talks to the Python API. Provider credentials and database tokens remain server-side.</p>
      </div>
    </main>
  );
}
