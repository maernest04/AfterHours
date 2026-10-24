// Shared caller and company checks (brief p.3: "Reducers check the caller and atomically validate
// state changes"; "the backend rejects other company IDs").

import { SenderError, type InferSchema, type ReducerCtx, type ViewCtx } from 'spacetimedb/server';
import spacetimedb from './schema';

export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
export type VCtx = ViewCtx<InferSchema<typeof spacetimedb>>;

export function requireOwner(ctx: Ctx) {
  const owner = ctx.db.moduleOwner.id.find(0);
  if (!owner || !owner.identity.isEqual(ctx.sender)) throw new SenderError('Only the module owner may do this.');
}

function requireRole(ctx: Ctx, role: 'GATEWAY' | 'WORKER') {
  if (ctx.db.serviceIdentity.identity.find(ctx.sender)?.role !== role) {
    throw new SenderError(`Only the configured ${role.toLowerCase()} identity may do this.`);
  }
}

/** Python API gateway: imports, case actions, mailbox seeding. */
export function requireGateway(ctx: Ctx) {
  requireRole(ctx, 'GATEWAY');
}

/** Python agent worker: job claims, heartbeats and completions only. */
export function requireWorker(ctx: Ctx) {
  requireRole(ctx, 'WORKER');
}

/** Scheduled reducers run as the module itself; nobody else may call them. */
export function requireScheduler(ctx: Ctx) {
  if (!ctx.sender.isEqual(ctx.identity)) throw new SenderError('This reducer runs only on schedule.');
}

export function requireCompany(ctx: Ctx, companyId: string) {
  const s = ctx.db.settings.id.find(0);
  if (!s) throw new SenderError('Settings are not configured; run `npm run db:bootstrap`.');
  if (companyId !== s.companyId) throw new SenderError(`Unknown company "${companyId}".`);
  return s;
}

export function requireText(value: string, field: string, max = 255): string {
  const v = value.trim();
  if (v.length === 0 || v.length > max) throw new SenderError(`${field} must be 1-${max} characters.`);
  return v;
}

/** Views expose rows only to configured gateway/worker identities. */
export function companyForService(ctx: VCtx): string | undefined {
  if (!ctx.db.serviceIdentity.identity.find(ctx.sender)) return undefined;
  return ctx.db.settings.id.find(0)?.companyId;
}
