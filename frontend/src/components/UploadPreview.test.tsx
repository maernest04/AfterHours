// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { parseCsv, UploadPreview } from "./UploadPreview";
import { AccrualDocument, SpreadsheetDocument } from "./AccountingDocument";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
});
afterEach(cleanup);

it("renders quoted CSV fields, escaped quotes, CRLF and embedded newlines correctly", () => {
  expect(parseCsv('name,note\r\n"Rivera, J.","Approved ""yes""\nand signed"\r\n'))
    .toEqual([["name", "note"], ["Rivera, J.", 'Approved "yes"\nand signed']]);
});

it("browses local documents using arrows and tabs without closing the popup", async () => {
  const files = [new File(["MASTER SERVICES AGREEMENT\nRate: $100 per hour"], "contract.txt", { type: "text/plain" }),
    new File(["contractor,approved_minutes\nRivera,420\n"], "timesheet.csv", { type: "text/csv" })];
  function Preview() {
    const [index, setIndex] = useState(0);
    const [open, setOpen] = useState(true);
    return open ? <UploadPreview files={files} index={index} onIndex={setIndex} onClose={() => setOpen(false)} /> : <p>Closed</p>;
  }
  render(<Preview />);
  await screen.findByRole("heading", { name: "MASTER SERVICES AGREEMENT" });
  expect(screen.getByRole("dialog").textContent).toContain("Rate: $100 per hour");
  expect(screen.getByRole("dialog", { name: "Contract" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next document" }));
  await screen.findByRole("cell", { name: "420" });
  expect(screen.getByRole("dialog", { name: "Approved timesheet" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
  await screen.findByRole("heading", { name: "MASTER SERVICES AGREEMENT" });
  fireEvent.click(screen.getByRole("button", { name: "Approved timesheet" }));
  await screen.findByRole("cell", { name: "420" });
  fireEvent.click(screen.getByRole("button", { name: "Close document preview" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
});

it("formats an accrual from actual source values and preserves invalid amounts", () => {
  const { rerender } = render(<AccrualDocument highlight text={JSON.stringify({ amountCents: "700000", status: "POSTED", currency: "USD", entryId: "ACR-1" })} />);
  expect(screen.getByText("$7,000")).toBeTruthy();
  expect(screen.getByText("ACR-1")).toBeTruthy();
  rerender(<AccrualDocument highlight text={JSON.stringify({ amountCents: "not-a-number" })} />);
  expect(screen.getByText("not-a-number")).toBeTruthy();
  expect(screen.getByText(/not valid integer cents/)).toBeTruthy();
});

it("calculates approved hours from the source and highlights the claimed rate", () => {
  const { container, rerender } = render(<SpreadsheetDocument highlight rows={[
    ["contractor", "service_date", "approved_minutes", "billing_rate", "status"],
    ["Rivera", "2026-11-01", "420", "110.00", "APPROVED"],
    ["Rivera", "2026-11-02", "420", "110.00", "UNAPPROVED"],
  ]} />);
  expect(screen.getByText("7 hours")).toBeTruthy();
  expect(container.querySelectorAll(".rate-attention-cell").length).toBe(2);
  expect(screen.queryByText("What to look for")).toBe(null);
  rerender(<SpreadsheetDocument highlight={false} rows={[["amount"], ["1234.50"]]} />);
  expect(screen.getByRole("cell", { name: "$1,234.50" })).toBeTruthy();
  expect(screen.queryByText("What to look for")).toBe(null);
});
