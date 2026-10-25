import type { CaseSnapshot } from "./reviewAdapter";
import { steps } from "./topology";

// These are confirmed milestone displays, never simulated worker-running states.
const replayable = new Set(["accrual", "contract", "work", "invoice", "ledger", "schema", "agrees", "amendment", "calculate", "review"]);
export function traversalFrames(previous: CaseSnapshot, next: CaseSnapshot): CaseSnapshot[] {
  if (previous.runId !== next.runId || previous.inputRevision !== next.inputRevision || next.blocker || next.status === "blocked" || next.status === "waiting") return [];
  const completed = steps.filter(step => replayable.has(step.id) && next.nodeStates[step.id] === "complete" && previous.nodeStates[step.id] !== "complete");
  if (completed.length < 2) return [];
  return completed.map((step, index) => {
    const nodeStates = { ...next.nodeStates };
    for (const pending of completed.slice(index + 1)) nodeStates[pending.id] = "queued";
    return { ...next, presentationStep: step.id, nodeStates,
      transitions: next.transitions.filter(edge => !completed.slice(index + 1).some(pending => edge.endsWith(`:${pending.id}`))) };
  });
}
