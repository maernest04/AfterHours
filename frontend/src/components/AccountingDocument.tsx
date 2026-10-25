import { money } from "../data/reviewAdapter";

const columnNames: Record<string, string> = {
  service_date: "Work date", contractor: "Contractor", approved_minutes: "Approved minutes",
  billing_rate: "Claimed hourly rate", status: "Status", approved_by: "Approved by",
  invoice_number: "Invoice no.", service_start: "Service from", service_end: "Service to",
  minutes: "Billed minutes", amount: "Amount", posting_status: "Posting status", posted_date: "Posted on",
  entry_id: "Entry reference", vendor_id: "Vendor ID", period: "Period", kind: "Entry type", description: "Description",
};
function columnLetter(index: number): string {
  let result = "";
  for (index++; index > 0; index = Math.floor((index - 1) / 26)) result = String.fromCharCode(65 + (index - 1) % 26) + result;
  return result;
}
function currency(value: string) {
  if (!/^-?\d+(\.\d{1,2})?$/.test(value.trim())) return value;
  const [whole, decimal = ""] = value.trim().split(".");
  return `${whole.startsWith("-") ? "−" : ""}$${BigInt(whole).toLocaleString("en-US").replace("-", "")}.${decimal.padEnd(2, "0")}`;
}

export function SpreadsheetDocument({ rows, highlight, citedRow }: { rows: string[][]; highlight: boolean; citedRow?: number }) {
  const headers = rows[0].map(h => h.trim().toLowerCase());
  const records = rows.slice(1);
  const timesheet = headers.includes("approved_minutes");
  const ledger = headers.includes("entry_id");
  const get = (row: string[], field: string) => row[headers.indexOf(field)] ?? "";
  const approved = records.filter(row => get(row, "status").toUpperCase() === "APPROVED");
  const minutes = approved.reduce((sum, row) => sum + (/^\d+$/.test(get(row, "approved_minutes")) ? Number(get(row, "approved_minutes")) : 0), 0);
  const rates = [...new Set(records.map(row => get(row, "billing_rate")).filter(Boolean))];
  const duplicateWork = new Set(approved.map(row => `${get(row, "contractor")}|${get(row, "service_date")}`)).size < approved.length;
  const postedAccruals = records.filter(row => get(row, "kind") === "ACCRUAL" && get(row, "status") === "POSTED");
  const title = timesheet ? "Approved contractor work" : ledger ? "General ledger detail" : "Vendor invoice register";
  return <div className="accounting-workbook">
    <div className="workbook-toolbar"><span className="workbook-file-icon">X</span><div><strong>{title}</strong><span>Source worksheet · {records.length} records</span></div><span className="document-readonly">Read only</span></div>
    <div className="worksheet-summary">
      {timesheet ? <><div><span>Approved work</span><strong>{(minutes / 60).toLocaleString("en-US", { maximumFractionDigits: 2 })} hours</strong><small>{approved.length} approved rows</small></div><div className={highlight ? "summary-attention" : ""}><span>Claimed rate</span><strong>{rates.length ? rates.map(currency).join(" / ") : "Not supplied"}</strong><small>Compare with contractual authority</small></div></>
        : ledger ? <><div><span>Posted accrual</span><strong>{postedAccruals.length === 1 ? currency(get(postedAccruals[0], "amount")) : `${postedAccruals.length} entries`}</strong><small>Already recorded in the ledger</small></div><div><span>Source records</span><strong>{records.length}</strong><small>Accruals and invoices kept separate</small></div></>
        : <><div><span>Invoice records</span><strong>{records.length}</strong><small>Review service dates and posting</small></div><div><span>Service period</span><strong>{records.length === 1 ? `${get(records[0], "service_start")} – ${get(records[0], "service_end")}` : "See individual rows"}</strong><small>Determines which work is covered</small></div></>}
    </div>
    {duplicateWork && <p className="worksheet-warning" role="status">Duplicate approved contractor/date rows appear in this source. Check for double-counted hours.</p>}
    <div className="spreadsheet-scroll"><table className="accounting-sheet" aria-label={title}>
      <thead><tr className="sheet-letters"><th aria-label="Row number" />{headers.map((_, i) => <th key={i}>{columnLetter(i)}</th>)}</tr>
        <tr><th className="sheet-row-number">1</th>{headers.map((header, i) => <th key={i} className={highlight && ["billing_rate", "service_start", "service_end", "posting_status", "amount", "status"].includes(header) ? "sheet-focus-heading" : ""}>{columnNames[header] || header.replaceAll("_", " ")}</th>)}</tr></thead>
      <tbody>{records.slice(0, 500).map((row, i) => <tr key={i} data-source-row={i + 2} aria-label={i + 2 === citedRow ? `Cited row ${citedRow}` : undefined} className={`${ledger && get(row, "kind") === "ACCRUAL" && highlight ? "accrual-source-row" : ""} ${i + 2 === citedRow ? "cited-source-row" : ""}`}>
        <th scope="row" className="sheet-row-number">{i + 2}</th>{headers.map((header, j) => {
          const value = row[j] || "";
          const numeric = ["amount", "billing_rate", "minutes", "approved_minutes"].includes(header);
          const status = ["status", "posting_status"].includes(header);
          return <td key={j} className={`${numeric ? "numeric-cell" : ""} ${highlight && header === "billing_rate" ? "rate-attention-cell" : ""}`}>
            {status ? <span className={`worksheet-status ${["APPROVED", "POSTED"].includes(value) ? "recorded" : "pending"}`}>{value}</span> : ["amount", "billing_rate"].includes(header) ? currency(value) : value}
          </td>;
        })}</tr>)}</tbody>
    </table></div>
    <div className="worksheet-bottom"><span className="sheet-tab">{timesheet ? "Approved work" : ledger ? "Ledger entries" : "Invoices"}</span><span>{records.length > 500 ? "First 500 rows shown" : `${records.length} source rows`} · Original values retained</span></div>
  </div>;
}

export function AccrualDocument({ text, highlight }: { text: string; highlight: boolean }) {
  let source: Record<string, unknown>;
  try { source = JSON.parse(text); if (!source || typeof source !== "object" || Array.isArray(source) || !("amountCents" in source)) return <pre className="upload-json">{text}</pre>; }
  catch { return <pre className="upload-json">{text}</pre>; }
  const period = source.servicePeriod && typeof source.servicePeriod === "object" ? source.servicePeriod as Record<string, unknown> : {};
  const amount = String(source.amountCents);
  const validAmount = /^-?\d+$/.test(amount);
  return <article className="accounting-paper accrual-paper">
    <div className="paper-topline"><span>ACCRUAL WORKPAPER</span><span className="document-readonly">Source record</span></div>
    <h3>Prepared expense accrual</h3><p className="paper-subtitle">{String(source.vendorName || source.vendorId || "Vendor not supplied")}</p>
    <div className={`accrual-total ${highlight ? "emphasized" : ""}`}><span>Original accrual amount</span><strong>{validAmount ? money(amount) : amount}</strong><span>{String(source.currency || "Currency not supplied")} · <b>{String(source.status || "Status not supplied")}</b></span></div>
    {!validAmount && <p className="worksheet-warning">Amount is not valid integer cents. This source needs correction before review.</p>}
    <dl className="accrual-fields"><dt>Entry reference</dt><dd>{String(source.entryId || "Not supplied")}</dd><dt>Vendor ID</dt><dd>{String(source.vendorId || "Not supplied")}</dd><dt>Service period</dt><dd>{String(period.from || "Not supplied")} → {String(period.to || "Not supplied")}</dd><dt>Posting period</dt><dd>{String(source.postingPeriod || "Not supplied")}</dd></dl>
    <p className="paper-source-note">Formatted from the selected accrual JSON. No source values have been changed.</p>
  </article>;
}

function markedLine(line: string, highlight: boolean) {
  if (!highlight) return line;
  return line.split(/(\$[\d,]+(?:\.\d{2})?|\d{4}-\d{2}-\d{2})/g).map((part, i) => /^(\$|\d{4}-\d{2}-\d{2})/.test(part) ? <mark key={i}>{part}</mark> : part);
}
export function ContractDocument({ text, highlight }: { text: string; highlight: boolean }) {
  const amendment = /AMENDMENT NO\.|^AMENDMENT$/m.test(text);
  const lines = text.split(/\r?\n/);
  const titleIndex = lines.findIndex(line => /^(MASTER SERVICES AGREEMENT|CONTRACT|AMENDMENT)/.test(line));
  return <article className="accounting-paper contract-paper">
    <div className="paper-topline"><span>{amendment ? "SIGNED RATE AMENDMENT" : "CONTRACT RECORD"}</span><span className="document-readonly">Source document</span></div>
    {lines.map((line, i) => {
      if (!line.trim()) return <div className="paper-paragraph-gap" key={i} />;
      if (i === titleIndex) return <h3 key={i}>{line}</h3>;
      const signature = /authorized signatory:|approved and signed:|^signed:/i.test(line);
      return <p key={i} className={`${signature ? "signature-line" : ""} ${highlight && /hourly rate|effective|only approved/i.test(line) ? "contract-key-clause" : ""}`}>{markedLine(line, highlight)}</p>;
    })}
    <p className="paper-source-note">Highlights are presentation cues. The original file remains the source of truth.</p>
  </article>;
}
