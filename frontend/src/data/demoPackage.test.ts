import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { buildDemoPackage } from "./demoPackage";
import { nodesFor } from "./apiReviewAdapter";

const read = (name: string) => readFile(new URL(`../../public/demo-files/${name}`, import.meta.url), "utf8");

describe("repeatable demo packages", () => {
  it("isolates vendors and keeps source references and dates consistent on repeated runs", async () => {
    const runs = await Promise.all(["first", "second"].map(id => buildDemoPackage("amendment", read, id)));
    const vendors = runs.map(files => JSON.parse(files[0].text).vendorId);
    expect(vendors[0]).not.toBe(vendors[1]);
    for (const files of runs) {
      const accrual = JSON.parse(files[0].text);
      const ledger = files.find(f => f.name.startsWith("ledger"))!.text;
      expect(ledger).toContain(`${accrual.entryId},${accrual.vendorId},${accrual.postingPeriod}`);
      expect(files.find(f => f.name.includes("timesheet"))!.text).toContain(accrual.servicePeriod.from);
      expect(files.find(f => f.name.includes("amendment"))!.text).toContain(accrual.vendorName);
      expect(files.find(f => f.name.includes("msa"))!.text).toContain(accrual.vendorName);
    }
  });
  it("builds the failure scenarios without fetching nonexistent v1 fixtures", async () => {
    const missing = await buildDemoPackage("missing-invoice", read, "missing");
    expect(missing.some(f => f.name.includes("invoices"))).toBe(false);
    const duplicate = await buildDemoPackage("duplicate-work", read, "duplicate");
    const rows = duplicate.find(f => f.name.includes("timesheet"))!.text.trim().split(/\r?\n/);
    expect(rows.at(-1)).toBe(rows[1]);
  });
});

it("maps a proposal failure to the proposal node rather than invalid source", () => {
  const nodes = nodesFor("RETRYABLE_ERROR", ["PROPOSAL_FAILED: Another posted case may cover the same work."]);
  expect(nodes.proposal).toBe("blocked");
  expect(nodes.invalid).toBe("dormant");
  expect(nodes.match).toBe("dormant");
});
