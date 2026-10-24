import type { GatewayContext } from "../context.ts";
import type { CaseRef, CaseSummary, CaseState, CaseUpdate, JobSummary, Page, PageRequest } from "../contracts.ts";
import type { DataPlane } from "../data_plane.ts";
import { validateParameters } from "../validation.ts";

export interface ListCasesRequest extends PageRequest { state?: CaseState }
export interface SubscribeRequest extends CaseRef { afterSequence?: string }

export async function list(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<Page<CaseSummary>> {
  validateParameters("cases.list", input);
  return dataPlane.execute("cases.list", ctx, input);
}
export async function get(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<CaseSummary | null> {
  validateParameters("cases.get", input);
  return dataPlane.execute("cases.get", ctx, input);
}
export async function startReview(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<CaseSummary> {
  validateParameters("cases.startReview", input);
  return dataPlane.execute("cases.startReview", ctx, input);
}
export async function listJobs(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<Page<JobSummary>> {
  validateParameters("cases.listJobs", input);
  return dataPlane.execute("cases.listJobs", ctx, input);
}
export async function subscribe(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<AsyncIterable<CaseUpdate>> {
  validateParameters("cases.subscribe", input);
  return dataPlane.execute("cases.subscribe", ctx, input);
}
