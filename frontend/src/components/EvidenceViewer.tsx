import { useEffect, useRef } from "react";
import type { EvidenceRecord } from "../data/reviewAdapter";
import { CloseButton } from "./ExecutionGraph";
export function EvidenceViewer({
  evidence,
  onClose,
}: {
  evidence: EvidenceRecord;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="evidence-dialog"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-head">
        <div>
          <span className="eyebrow">Synthetic evidence · {evidence.type}</span>
          <h2>{evidence.name}</h2>
        </div>
        <CloseButton onClick={onClose} />
      </div>
      <p className="source-ref">{evidence.reference}</p>
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
      <div className="evidence-finding">
        <strong>How this evidence is used</strong>
        <p>{evidence.disposition}</p>
      </div>
      <p className="muted small">
        Excerpt available. Original document bytes are not included in this
        demo; a full preview is unavailable.
      </p>
      <button className="secondary" onClick={onClose}>
        Close evidence
      </button>
    </dialog>
  );
}
