import type { EvidenceRecord } from "../data/reviewAdapter";
import { CloseButton } from "./ExecutionGraph";
import { AccrualDocument, ContractDocument, SpreadsheetDocument } from "./AccountingDocument";
import { parseCsv } from "../data/documentFormatting";
export function EvidenceViewer({
  evidence,
  onClose,
}: {
  evidence: EvidenceRecord;
  onClose: () => void;
}) {
  const isCsv = evidence.mediaType?.includes("text/csv") || /\.csv$/i.test(evidence.name);
  const isJson = evidence.mediaType?.includes("application/json") || /\.json$/i.test(evidence.name);
  const citedRow = Number(evidence.reference.match(/\brow\s+(\d+)/i)?.[1]) || undefined;
  return (
    <dialog
      open
      aria-label="Source document viewer"
      className="evidence-dialog"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-head">
        <div>
          <span className="eyebrow">Source evidence · {evidence.id}</span>
          <h2>{evidence.name}</h2>
        </div>
        <CloseButton onClick={onClose} />
      </div>
      <p className="source-ref">{evidence.reference}</p>
      {evidence.sourceUrl && <a className="source-open-link" href={evidence.sourceUrl} target="_blank" rel="noopener noreferrer">Open original in new tab ↗</a>}
      {evidence.mediaType?.includes("application/pdf") && evidence.sourceUrl && <iframe
        className="source-pdf" title={`Original PDF: ${evidence.name}`} src={evidence.sourceUrl}
      />}
      <h3>Cited excerpt</h3>
      {evidence.sender && (
        <dl className="email-metadata">
          <dt>From</dt>
          <dd>{evidence.sender}</dd>
          <dt>To</dt>
          <dd>{evidence.recipient}</dd>
          <dt>Date</dt>
          <dd>{evidence.date}</dd>
          <dt>Thread</dt>
          <dd>{evidence.thread}</dd>
          <dt>Attachments</dt>
          <dd>{evidence.attachments?.join(", ") || "None"}</dd>
        </dl>
      )}
      <pre className="evidence-excerpt">{evidence.excerpt}</pre>
      {evidence.sourceText !== undefined && <section className="source-document formatted-evidence" aria-label="Formatted source document">
        <h3>Source document {citedRow && <span className="cited-row-badge">Row {citedRow} highlighted</span>}</h3>
        {isCsv ? <SpreadsheetDocument rows={parseCsv(evidence.sourceText)} highlight citedRow={citedRow} />
          : isJson ? <AccrualDocument text={evidence.sourceText} highlight />
          : <ContractDocument text={evidence.sourceText} highlight />}
      </section>}
      <div className="evidence-finding">
        <strong>How this evidence is used</strong>
        <p>{evidence.disposition}</p>
      </div>
      {!evidence.sourceUrl && <p className="muted small">
        Excerpt available. Original document bytes are not included in this
        demo; a full preview is unavailable.
      </p>}
      <button className="secondary" onClick={onClose}>
        Close evidence
      </button>
    </dialog>
  );
}
