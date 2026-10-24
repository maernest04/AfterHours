import type { GatewayContext } from "../context.ts";
import type { DocumentSummary, EvidenceFact, Page } from "../contracts.ts";
import type { DataPlane } from "../data_plane.ts";
import { validateParameters } from "../validation.ts";

export async function list(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<Page<EvidenceFact>> {
  validateParameters("evidence.list", input);
  return dataPlane.execute("evidence.list", ctx, input);
}
export async function readDocument(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<{ document: DocumentSummary; mediaType: string; bytes: Uint8Array }> {
  validateParameters("evidence.readDocument", input);
  return dataPlane.execute("evidence.readDocument", ctx, input);
}
