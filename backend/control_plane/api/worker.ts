import type { WorkerContext } from "../context.ts";
import type { AgentOutput, JobLease, JobSummary, LeaseRef, RevisionRef } from "../contracts.ts";
import type { DataPlane } from "../data_plane.ts";
import { validateParameters } from "../validation.ts";

export interface ClaimRequest extends RevisionRef { jobId: string }
export interface CompleteRequest extends LeaseRef { output: AgentOutput; modelRun: "LIVE" | "REPLAYED" }

export async function claim(ctx: WorkerContext, input: unknown, dataPlane: DataPlane): Promise<JobLease> {
  validateParameters("worker.claim", input);
  return dataPlane.execute("worker.claim", ctx, input);
}
export async function heartbeat(ctx: WorkerContext, input: unknown, dataPlane: DataPlane): Promise<{ leaseExpiry: string }> {
  validateParameters("worker.heartbeat", input);
  return dataPlane.execute("worker.heartbeat", ctx, input);
}
export async function complete(ctx: WorkerContext, input: unknown, dataPlane: DataPlane): Promise<JobSummary> {
  validateParameters("worker.complete", input);
  return dataPlane.execute("worker.complete", ctx, input);
}
