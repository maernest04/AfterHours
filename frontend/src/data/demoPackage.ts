export type DemoScenario = "amendment" | "missing-invoice" | "duplicate-work" | "invalid-accrual";

const sources = [
  ["acme_accrual_2026-09_frontend-test.json", "application/json"],
  ["acme_msa.txt", "text/plain"],
  ["acme_timesheet_2026-09_v2.csv", "text/csv"],
  ["acme_invoices_2026-08.csv", "text/csv"],
  ["ledger_2026-09.csv", "text/csv"],
  ["acme_amendment_1.txt", "text/plain"],
] as const;

/** Isolate synthetic runs by vendor, including every quoted party and ledger reference. */
export async function buildDemoPackage(scenario: DemoScenario, read: (name: string) => Promise<string>, runId: string = crypto.randomUUID()) {
  const vendorId = `V-DEMO-${runId}`;
  const vendorName = `Acme Demo ${runId} (SYNTHETIC)`;
  const entryId = `ACR-DEMO-${runId}`;
  return Promise.all(sources.filter(([name]) => scenario !== "missing-invoice" || !name.includes("invoices")).map(async ([name, type]) => {
    let text = await read(name);
    if (type === "application/json") {
      const accrual = JSON.parse(text);
      Object.assign(accrual, { entryId, vendorId, vendorName,
        servicePeriod: { from: "2026-11-01", to: "2026-11-30" }, postingPeriod: "2026-11" });
      if (scenario === "invalid-accrual") accrual.amountCents = "not-a-number";
      text = JSON.stringify(accrual, null, 2);
    } else {
      text = text.replaceAll("V-ACME", vendorId).replaceAll("Acme Contracting (SYNTHETIC)", vendorName);
      if (name.startsWith("ledger")) text = text.split(/\r?\n/).map((line) => {
        const cells = line.split(",");
        if (cells[3] === "ACCRUAL") { cells[0] = entryId; cells[2] = "2026-11"; }
        return cells.join(",");
      }).join("\n");
      if (name.includes("timesheet") && scenario === "duplicate-work") {
        text = text.trimEnd() + "\n" + text.split(/\r?\n/)[1] + "\n";
      }
    }
    return { name, type, text };
  }));
}
