// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EvidenceViewer } from "./EvidenceViewer";
import type { EvidenceRecord } from "../data/reviewAdapter";

afterEach(cleanup);
const evidence: EvidenceRecord = { id: "fact:123", name: "timesheet.csv", type: "source",
  reference: "row 2", excerpt: "Rivera,420,110.00,APPROVED", disposition: "Backend evidence",
  mediaType: "text/csv", sourceText: "contractor,approved_minutes,billing_rate,status\nRivera,420,110.00,APPROVED\n",
  sourceUrl: "/api/review-source?review_id=1&evidence_id=fact:123" };

it("opens a formatted spreadsheet with the cited row highlighted", () => {
  const { container } = render(<EvidenceViewer evidence={evidence} onClose={() => {}} />);
  expect(screen.getByRole("table", { name: "Approved contractor work" })).toBeTruthy();
  expect(screen.getByRole("row", { name: "Cited row 2" }).classList.contains("cited-source-row")).toBe(true);
  expect(screen.getByText("7 hours")).toBeTruthy();
  expect(container.querySelector(".source-document > pre")).toBe(null);
  expect(screen.getByRole("link", { name: /Open original/ }).getAttribute("href")).toBe(evidence.sourceUrl);
});

it("formats accrual facts as a workpaper instead of raw JSON", () => {
  render(<EvidenceViewer evidence={{ ...evidence, name: "accrual.json", reference: "json $.amountCents",
    mediaType: "application/json", sourceText: JSON.stringify({ amountCents: "700000", status: "POSTED", currency: "USD" }) }} onClose={() => {}} />);
  expect(screen.getByRole("heading", { name: "Prepared expense accrual" })).toBeTruthy();
  expect(screen.getByText("$7,000")).toBeTruthy();
});
