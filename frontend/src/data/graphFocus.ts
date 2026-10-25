import type { CaseSnapshot } from "./reviewAdapter";
import { steps } from "./topology";

export function graphFocusStep(snapshot: CaseSnapshot): string {
  for (const status of ["blocked", "waiting", "running"] as const) {
    const active = steps.find(step => snapshot.nodeStates[step.id] === status);
    if (active) return active.id;
  }
  const terminal: Partial<Record<CaseSnapshot["status"], string>> = {
    review: "review", verified: "unchanged", approved: "approved", exported: "export",
  };
  return terminal[snapshot.status]
    ?? [...steps].reverse().find(step => snapshot.nodeStates[step.id] === "complete")?.id
    ?? "import";
}
