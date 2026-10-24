import type { GatewayContext } from "../context.ts";
import type { Page, ProposalRef, Review, ReviewDecision } from "../contracts.ts";
import type { DataPlane } from "../data_plane.ts";
import { validateParameters } from "../validation.ts";

export type DecideRequest = ProposalRef & ReviewDecision & { reviewerName: string };
export async function decide(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<Review> {
  validateParameters("reviews.decide", input);
  return dataPlane.execute("reviews.decide", ctx, input);
}
export async function list(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<Page<Review>> {
  validateParameters("reviews.list", input);
  return dataPlane.execute("reviews.list", ctx, input);
}
