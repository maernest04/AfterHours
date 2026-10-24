import type { GatewayContext } from "../context.ts";
import type { ExportReceipt, Id, ProposalRef } from "../contracts.ts";
import type { DataPlane } from "../data_plane.ts";
import { validateParameters } from "../validation.ts";

export interface CreateExportRequest extends ProposalRef { idempotencyKey: string }
export interface DownloadRequest { caseId: Id; exportId: Id }
export interface CsvDownload { filename: string; mediaType: "text/csv"; bytes: Uint8Array }

export async function create(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<ExportReceipt> {
  validateParameters("exports.create", input);
  return dataPlane.execute("exports.create", ctx, input);
}
export async function download(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<CsvDownload> {
  validateParameters("exports.download", input);
  return dataPlane.execute("exports.download", ctx, input);
}
