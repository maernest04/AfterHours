/** Hardcoded happy-path demo math. Matches the uploaded MSA $100, amendment/timesheet $110, and 70 approved hours. */
export const DEMO_POSTED_CENTS = "700000";
export const DEMO_TARGET_CENTS = "770000";
export const DEMO_ADJUSTMENT_CENTS = "70000";

export const DEMO_EXPLANATION =
  "The posted $7,000 accrual used the master agreement $100/hour rate for 70 approved November hours (10 days × 420 minutes). The signed amendment and approved timesheets support $110/hour, so the supported total is $7,700. The journal records only the $700 difference — it does not post $7,700 again.";

export const DEMO_JOURNAL_DESCRIPTION =
  "70 approved hours × $10 rate increase ($100 contract → $110 amendment)";

export function isDemoCorrection(amounts: {
  original?: string | null;
  target?: string | null;
  difference?: string | null;
}) {
  return amounts.original === DEMO_POSTED_CENTS
    && amounts.target === DEMO_TARGET_CENTS
    && amounts.difference === DEMO_ADJUSTMENT_CENTS;
}
