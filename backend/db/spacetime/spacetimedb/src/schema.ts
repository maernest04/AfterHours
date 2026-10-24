// Document-storage schema, following the implementation brief (Accrual_Correction_Brief, p.3):
// - Tables stay private. Clients read through views that check ctx.sender against the configured
//   gateway/worker identities (see index.ts).
// - Original file bytes live on a persistent server volume; documents reference them by
//   storageKey and contentHash. No file bytes are stored in SpacetimeDB.
// - Every business record belongs to the fixed demo company (settings.companyId).

import { schema, table, t } from 'spacetimedb/server';

export const Account = t.object('Account', { code: t.string(), name: t.string() });

/** Private. The identity that published the module; only it may configure settings and identities. */
const moduleOwner = table(
  { name: 'module_owner' },
  {
    id: t.u32().primaryKey(),
    identity: t.identity(),
  }
);

/** Private. Single row (id = 0): fixed demo company and accounting policy. No memberships table. */
const settings = table(
  { name: 'settings' },
  {
    id: t.u32().primaryKey(),
    companyId: t.string(),
    currency: t.string(),
    expenseAccount: Account,
    liabilityAccount: Account,
    policyVersion: t.string(),
  }
);

/** Private. Configured server identities: GATEWAY (Next.js server) and WORKER (Node agent worker). */
const serviceIdentity = table(
  { name: 'service_identity' },
  {
    identity: t.identity().primaryKey(),
    role: t.string(),
    label: t.string(),
    createdAt: t.timestamp(),
  }
);

/**
 * Private. One version of a source document. Bytes are on the file store at `storageKey`.
 * Rows are never updated or deleted; a new version points at its predecessor.
 */
const documents = table(
  { name: 'documents' },
  {
    id: t.u64().primaryKey().autoInc(),
    companyId: t.string().index('btree'),
    storageKey: t.string(),
    type: t.string().index('btree'),
    version: t.u32(),
    contentHash: t.string().index('btree'),
    byteLength: t.u32(),
    mediaType: t.string(),
    originalFilename: t.string(),
    referenceId: t.option(t.string()),
    sourceLabel: t.string(),
    supersedesDocumentId: t.option(t.u64()),
    uploadKey: t.string().unique(),
    createdAt: t.timestamp(),
  }
);

const spacetimedb = schema({ moduleOwner, settings, serviceIdentity, documents });
export default spacetimedb;
export { documents, settings };
