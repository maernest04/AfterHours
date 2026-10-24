import type { GatewayContext } from "../context.ts";
import type { CaseSummary, DateRange, DocumentType, Id, MoneyCents } from "../contracts.ts";
import type { DataPlane } from "../data_plane.ts";
import { validateParameters } from "../validation.ts";

export interface UploadRequest {
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
  type: DocumentType;
}
export interface UploadReceipt { uploadId: Id; contentHash: string }
export interface FinalizeImportRequest {
  idempotencyKey: string;
  uploadIds: readonly Id[];
  vendorId: Id;
  servicePeriod: DateRange;
  postingPeriod: string;
  originalStatus: "DRAFT" | "POSTED";
  originalAmountCents: MoneyCents;
  sourceEntryId: Id;
}
export async function upload(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<UploadReceipt> {
  validateParameters("imports.upload", input);
  return dataPlane.execute("imports.upload", ctx, input);
}
export async function finalize(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<CaseSummary> {
  validateParameters("imports.finalize", input);
  return dataPlane.execute("imports.finalize", ctx, input);
}
