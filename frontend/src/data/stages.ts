import { steps } from "./topology";
import type { NodeStatus } from "./reviewAdapter";

export const stages = [
  { id: "normalize", label: "Normalize", region: 0, description: "Read and validate the source evidence.", completeAt: ["schema"] },
  { id: "match", label: "Match", region: 1, description: "Connect the work, contracts, and ledger.", completeAt: ["agrees", "unchanged"] },
  { id: "investigate", label: "Investigate", region: 2, description: "Resolve questions when evidence disagrees.", completeAt: ["amendment"] },
  { id: "recalculate", label: "Recalculate", region: 3, description: "Calculate the correction and prepare review.", completeAt: ["calculate"] },
] as const;
export type Stage = (typeof stages)[number];

export function stageStatus(stage: Stage, states: Record<string, NodeStatus>): NodeStatus {
  const members = steps.filter(step => step.region === stage.region);
  const values = members.map(step => states[step.id] ?? "dormant");
  for (const status of ["blocked", "waiting", "running"] as const) {
    if (values.includes(status)) return status;
  }
  // Terminal guards establish completion; alternative/error branches need not run.
  if (stage.completeAt.some(id => states[id] === "complete")) return "complete";
  if (values.every(status => status === "skipped")) return "skipped";
  if (values.some(status => status === "queued" || status === "complete")) return "queued";
  return "dormant";
}
