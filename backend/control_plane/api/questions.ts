import type { GatewayContext } from "../context.ts";
import type { Page, ProposalRef, Question } from "../contracts.ts";
import type { DataPlane } from "../data_plane.ts";
import { validateParameters } from "../validation.ts";

export interface AskRequest extends ProposalRef { reviewerName: string; question: string }
export async function ask(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<Question> {
  validateParameters("questions.ask", input);
  return dataPlane.execute("questions.ask", ctx, input);
}
export async function list(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<Page<Question>> {
  validateParameters("questions.list", input);
  return dataPlane.execute("questions.list", ctx, input);
}
