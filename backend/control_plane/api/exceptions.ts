import type { GatewayContext } from "../context.ts";
import type { CaseSummary, Id, RevisionRef } from "../contracts.ts";
import type { DataPlane } from "../data_plane.ts";
import { validateParameters } from "../validation.ts";

export interface ResolveRequest extends RevisionRef {
  exceptionId: Id;
  reviewerName: string;
  explanation: string;
  evidenceIds: readonly Id[];
  controllerTreatment?: string;
}
export async function resolve(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<CaseSummary> {
  validateParameters("exceptions.resolve", input);
  return dataPlane.execute("exceptions.resolve", ctx, input);
}
