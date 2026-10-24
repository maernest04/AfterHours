import type { GatewayContext } from "../context.ts";
import type { Account, CompanySettings } from "../contracts.ts";
import type { DataPlane } from "../data_plane.ts";
import { validateParameters } from "../validation.ts";

export interface ConfigureRequest {
  expenseAccount: Account;
  liabilityAccount: Account;
  expectedPolicyVersion: string;
}
export async function get(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<CompanySettings> {
  validateParameters("settings.get", input);
  return dataPlane.execute("settings.get", ctx, input);
}
export async function configure(ctx: GatewayContext, input: unknown, dataPlane: DataPlane): Promise<CompanySettings> {
  validateParameters("settings.configure", input);
  return dataPlane.execute("settings.configure", ctx, input);
}
