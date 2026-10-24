import type { EvidenceRecord, Proposal, Variant } from "./reviewAdapter";
export const CASE_ID = "ACC-SEP-042";
export const variants: { value: Variant; label: string }[] = [
  { value: "amendment", label: "Signed amendment" },
  { value: "no-change", label: "No change needed" },
  { value: "missing", label: "Missing evidence" },
  { value: "provider-failure", label: "Provider failure" },
  { value: "rejection-revision", label: "Reject → new revision" },
  { value: "invalid-source", label: "Invalid source" },
  { value: "conflicting-authority", label: "Conflicting authority" },
  { value: "invalid-period", label: "Period validation fails" },
];
export const evidence: EvidenceRecord[] = [
  {
    id: "ledger",
    name: "September accrual · JE-0098",
    type: "Ledger",
    reference: "General ledger, row 98",
    excerpt:
      "2026-09-30 | JE-0098 | POSTED\nDebit Contractor Expense (6100): $7,000.00\nCredit Accrued Contractor Liabilities (2100): $7,000.00\n70 approved hours × $100/hour. Vendor: Acme Services.",
    disposition:
      "Already posted. Correct only the difference; never record the full target a second time.",
  },
  {
    id: "contract",
    name: "Acme Services agreement",
    type: "Contract",
    reference: "Page 3, §4.1",
    excerpt:
      "Cedar Labs agrees to compensate Acme Services at $100.00 per approved hour. Changes require a signed amendment by authorized representatives.",
    disposition:
      "Original rate. Superseded only for qualifying work by the signed amendment.",
  },
  {
    id: "work",
    name: "Approved September work",
    type: "Timesheet",
    reference: "Rows 15–30, approval record TS-0926",
    excerpt:
      "Service dates: September 15–30, 2026\nApproved hours: 70\nApproved by: Morgan Chen, Cedar Labs operations\nApproved on September 30, 2026.",
    disposition: "All 70 hours occur on or after the amendment effective date.",
  },
  {
    id: "invoice",
    name: "Invoice INV-0926 · unposted",
    type: "Received invoice",
    reference: "Page 1, service line 1",
    excerpt:
      "Acme Services → Cedar Labs\nReceived September 30, 2026\n70 hours × $110/hour = $7,700.00\nPosting status: UNPOSTED. Not in the ledger.",
    disposition:
      "Triggers investigation of a rate conflict. The invoice is not authority to change the contract and is not a second recorded expense.",
  },
  {
    id: "amendment",
    name: "Signed rate amendment",
    type: "Email attachment",
    reference: "Amendment.pdf, page 1, §2",
    excerpt:
      "Signed September 14, 2026 by authorized representatives of Cedar Labs and Acme Services.\nEffective September 15, 2026, the approved hourly rate is $110.00. All other terms remain unchanged.",
    disposition: "Authorized and effective for all 70 approved hours.",
    sender: "Alex Rivera <alex@acme.example>",
    recipient: "Morgan Chen <morgan@cedarlabs.example>",
    date: "2026-09-14 14:32 UTC",
    thread: "Signed September services amendment",
    attachments: ["Amendment.pdf"],
  },
  {
    id: "excluded",
    name: "Unapproved $130 rate request",
    type: "Email",
    reference: "Message REQUEST-130, body",
    excerpt:
      "Could we move the September work to $130/hour? Please let me know if that is acceptable.\nNo signed amendment or approval is attached.",
    disposition:
      "Excluded: a request without approval does not change the authorized rate.",
    sender: "Alex Rivera <alex@acme.example>",
    recipient: "Morgan Chen <morgan@cedarlabs.example>",
    date: "2026-09-18 09:10 UTC",
    thread: "Proposed additional rate change",
    attachments: [],
  },
  {
    id: "invoice-original",
    name: "Invoice INV-0926 · original rate",
    type: "Received invoice",
    reference: "Page 1, service line 1",
    excerpt:
      "No-change fixture: 70 approved hours × $100/hour = $7,000.00. Received but UNPOSTED.",
    disposition:
      "Agrees with the original contract and posted accrual. No signed rate amendment applies in this fixture.",
  },
];
export function proposal(
  version = 1,
  inputRevision = 1,
  valid = true,
): Proposal {
  return {
    version,
    inputRevision,
    target: "770000",
    difference: "70000",
    valid,
    explanation:
      "JE-0098 already records $7,000. The signed September 14 amendment authorizes $110/hour from September 15. All 70 approved hours qualify: the validated target is $7,700, so only a $700 adjustment is proposed. The unposted invoice is corroborating evidence; the unapproved $130 request is excluded.",
    evidenceIds: ["ledger", "work", "invoice", "amendment", "excluded"],
    lines: [
      {
        entryDate: "2026-09-30",
        reference: `ACC-SEP-042-V${version}`,
        accountCode: "6100",
        accountName: "Contractor Expense",
        debit: "70000",
        credit: "0",
        currency: "USD",
        description: "Acme accrual rate adjustment",
      },
      {
        entryDate: "2026-09-30",
        reference: `ACC-SEP-042-V${version}`,
        accountCode: "2100",
        accountName: "Accrued Contractor Liabilities",
        debit: "0",
        credit: "70000",
        currency: "USD",
        description: "Acme accrual rate adjustment",
      },
    ],
  };
}
