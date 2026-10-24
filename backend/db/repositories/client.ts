// Node-side SpacetimeDB connections. Each server process connects with its own persisted identity:
// "gateway" (Next.js server / control plane) or "worker" (Node agent worker). Tokens live in
// backend/.secrets/ (git-ignored) and never reach the browser. The module owner is the identity the
// `spacetime` CLI published with; only db:bootstrap uses it.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbConnection } from '../bindings/index';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const SECRETS_DIR = process.env.SPACETIMEDB_SECRETS_DIR ?? join(REPO_ROOT, 'backend', '.secrets');
export const DB_URI = process.env.SPACETIMEDB_URI ?? 'http://localhost:3000';
export const DB_NAME = process.env.SPACETIMEDB_DATABASE ?? 'accrual-docs';

export type ServiceRole = 'gateway' | 'worker';
export type Connected = { conn: DbConnection; identityHex: string; token: string };

/** Connect and resolve once the initial subscription to every public view is applied. */
export function connect(token?: string): Promise<Connected> {
  return new Promise((resolvePromise, reject) => {
    DbConnection.builder()
      .withUri(DB_URI)
      .withDatabaseName(DB_NAME)
      .withToken(token)
      .onConnect((conn, identity, newToken) => {
        conn
          .subscriptionBuilder()
          .onApplied(() => resolvePromise({ conn, identityHex: identity.toHexString(), token: newToken }))
          .onError(() => reject(new Error('Subscription to SpacetimeDB views failed')))
          .subscribeToAllTables();
      })
      .onConnectError((_ctx, err) => reject(err))
      .build();
  });
}

function tokenFile(role: ServiceRole): string {
  return join(SECRETS_DIR, `${role}.token`);
}

/** Connect with a service identity, creating and saving it on first use. */
export async function connectAs(role: ServiceRole): Promise<Connected> {
  const file = tokenFile(role);
  const saved = existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined;
  const c = await connect(saved);
  if (!saved) {
    mkdirSync(SECRETS_DIR, { recursive: true });
    writeFileSync(file, c.token, { mode: 0o600 });
  }
  return c;
}

/** Connect as a service and fail fast if db:bootstrap has not registered it. */
export async function connectService(role: ServiceRole): Promise<Connected> {
  const c = await connectAs(role);
  const me = [...c.conn.db.myServiceIdentity.iter()][0];
  if (!me || me.role !== role.toUpperCase()) {
    c.conn.disconnect();
    throw new Error(`Identity ${c.identityHex.slice(0, 12)}… is not registered as ${role.toUpperCase()}; run \`npm run db:bootstrap\`.`);
  }
  return c;
}

function spacetimeBin(): string {
  if (process.env.SPACETIME_BIN) return process.env.SPACETIME_BIN;
  const winDefault = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'SpacetimeDB', 'spacetime.exe');
  return winDefault && existsSync(winDefault) ? winDefault : 'spacetime';
}

/** Token of the identity the CLI publishes with (the module owner). */
export function ownerToken(): string {
  const out = execFileSync(spacetimeBin(), ['login', 'show', '--token'], { encoding: 'utf8' });
  const match = /(eyJ[\w\-.]+)/.exec(out);
  if (!match) throw new Error('Could not read the CLI token; run `npm run db:publish` first.');
  return match[1];
}

/** Poll the local replica until `fn` returns a value (not undefined/null/false). */
export async function waitFor<T>(fn: () => T | undefined | null | false, label: string, timeoutMs = 10000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(r => setTimeout(r, 25));
  }
}
