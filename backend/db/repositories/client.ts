// Node-side connection to the SpacetimeDB database: connect, subscribe to all public tables,
// and wait for replicated rows.

import { DbConnection } from '../bindings/index';

export const DB_URI = process.env.SPACETIMEDB_URI ?? 'http://localhost:3000';
export const DB_NAME = process.env.SPACETIMEDB_DATABASE ?? 'accrual-docs';

export type Connected = { conn: DbConnection; identityHex: string; token: string };

/**
 * Connect and resolve once the initial subscription to every public table is applied.
 * Pass a saved token to reuse an identity; omit it for a fresh anonymous identity.
 */
export function connect(token?: string): Promise<Connected> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(DB_URI)
      .withDatabaseName(DB_NAME)
      .withToken(token)
      .onConnect((conn, identity, newToken) => {
        conn
          .subscriptionBuilder()
          .onApplied(() => resolve({ conn, identityHex: identity.toHexString(), token: newToken }))
          .onError(() => reject(new Error('Subscription to document tables failed')))
          .subscribeToAllTables();
      })
      .onConnectError((_ctx, err) => reject(err))
      .build();
  });
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
