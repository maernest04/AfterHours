import type { GatewayContext, SystemContext } from "../context.ts";
import type { Proposal } from "../contracts.ts";
import type { DataPlane } from "../data_plane.ts";
import { validateParameters } from "../validation.ts";

export async function get(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<Proposal | null> {
  validateParameters("proposals.get", input);
  return dataPlane.execute("proposals.get", ctx, input);
}
export async function build(ctx: SystemContext, input: unknown, dataPlane: DataPlane): Promise<Proposal | null> {
  validateParameters("proposals.build", input);
  return dataPlane.execute("proposals.build", ctx, input);
}
