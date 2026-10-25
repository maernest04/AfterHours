import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, X } from "lucide-react";
import { AccrualDocument, ContractDocument, SpreadsheetDocument } from "./AccountingDocument";
import { parseCsv } from "../data/documentFormatting";
export { parseCsv } from "../data/documentFormatting";

export function documentLabel(file: File): string {
  const name = file.name.toLowerCase();
  if (name.includes("timesheet")) return "Approved timesheet";
  if (name.includes("amendment")) return "Signed amendment";
  if (name.includes("msa") || name.includes("contract")) return "Contract";
  if (name.includes("invoice")) return "Invoices";
  if (name.includes("ledger")) return "Ledger records";
  if (name.includes("accrual")) return "Prepared accrual";
  return file.name;
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Unable to read this file."));
    reader.readAsText(file);
  });
}

export function UploadPreview({ files, index, onIndex, onClose }: {
  files: File[]; index: number; onIndex: (index: number) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState({ text: "", pdf: "", error: "", ready: false });
  const [highlight, setHighlight] = useState(true);
  const file = files[index];
  const move = (direction: number) => onIndex((index + direction + files.length) % files.length);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    let pdf = "";
    setPreview({ text: "", pdf: "", error: "", ready: false });
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
      pdf = URL.createObjectURL(file);
      setPreview({ text: "", pdf, error: "", ready: true });
    } else {
      void readText(file).then(text => {
        if (/\.json$/i.test(file.name)) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Show original malformed JSON for inspection. */ } }
        if (active) setPreview({ text, pdf: "", error: "", ready: true });
      }).catch(error => { if (active) setPreview({ text: "", pdf: "", error: String(error), ready: true }); });
    }
    return () => { active = false; if (pdf) URL.revokeObjectURL(pdf); };
  }, [file]);
  const rows = /\.csv$/i.test(file.name) && preview.ready ? parseCsv(preview.text) : null;
  return <dialog ref={dialog} className="upload-preview" aria-labelledby="upload-preview-title"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={event => {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); move(event.key === "ArrowRight" ? 1 : -1); }
    }}>
    <header className="upload-preview-header">
      <div><span className="upload-preview-eyebrow">Source documents · {index + 1} of {files.length}</span>
        <h2 id="upload-preview-title">{documentLabel(file)}</h2><p>{file.name}</p></div>
      <div className="preview-header-actions"><button className="presentation-toggle" aria-pressed={highlight} onClick={() => setHighlight(!highlight)}>Presentation highlights {highlight ? "on" : "off"}</button>
      <button className="upload-preview-close" aria-label="Close document preview" onClick={onClose}><X size={22} /></button></div>
    </header>
    <nav className="upload-preview-documents" aria-label="Select document">
      {files.map((source, position) => <button key={`${source.name}-${position}`} aria-current={position === index ? "true" : undefined}
        onClick={() => onIndex(position)}><FileText size={16} />{documentLabel(source)}</button>)}
    </nav>
    <div className="upload-preview-body">
      <button className="document-arrow previous" aria-label="Previous document" disabled={files.length < 2} onClick={() => move(-1)}><ChevronLeft size={28} /></button>
      <div className="upload-preview-content" key={file.name}>
        {!preview.ready ? <p role="status">Opening document…</p> : preview.error ? <p role="alert">{preview.error}</p>
          : preview.pdf ? <iframe src={preview.pdf} title={`PDF: ${file.name}`} />
          : rows?.length ? <SpreadsheetDocument rows={rows} highlight={highlight} />
          : /\.json$/i.test(file.name) ? <AccrualDocument text={preview.text} highlight={highlight} />
          : <ContractDocument text={preview.text} highlight={highlight} />}
      </div>
      <button className="document-arrow next" aria-label="Next document" disabled={files.length < 2} onClick={() => move(1)}><ChevronRight size={28} /></button>
    </div>
    <footer className="upload-preview-footer"><span>Previewing selected files locally</span><span>Use ← → to switch documents · Esc to close</span></footer>
  </dialog>;
}
