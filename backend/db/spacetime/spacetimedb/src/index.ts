// Module entry. The schema is the default export; named exports are registered reducers/views.
// Reducers check the caller (ctx.sender) and validate atomically; they return no data.
// Clients read through the views below, which expose rows only to configured service identities.

import { SenderError, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import spacetimedb, { Account, documents, settings } from './schema';

export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

// Shared document types and upload limits for document storage.
const DOCUMENT_TYPES = ['ACCRUAL', 'CONTRACT', 'AMENDMENT', 'TIMESHEET', 'INVOICE', 'LEDGER', 'OTHER'];
const MEDIA_TYPES = ['text/csv', 'application/json', 'text/plain', 'application/pdf'];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ROLES = ['GATEWAY', 'WORKER'];
const SHA256_HEX = /^[0-9a-f]{64}$/;

// --- authorization ---------------------------------------------------------------------------

function requireOwner(ctx: Ctx) {
  const owner = ctx.db.moduleOwner.id.find(0);
  if (!owner || !owner.identity.isEqual(ctx.sender)) throw new SenderError('Only the module owner may do this.');
}

/** Brief: the gateway saves validated bytes to the file store, then reducers save metadata. */
function requireGateway(ctx: Ctx) {
  if (ctx.db.serviceIdentity.identity.find(ctx.sender)?.role !== 'GATEWAY') {
    throw new SenderError('Only the configured gateway identity may do this.');
  }
}

function requireCompany(ctx: Ctx, companyId: string) {
  const s = ctx.db.settings.id.find(0);
  if (!s) throw new SenderError('Settings are not configured; run `npm run db:bootstrap`.');
  if (companyId !== s.companyId) throw new SenderError(`Unknown company "${companyId}".`);
}

function requireText(value: string, field: string, max = 255): string {
  const v = value.trim();
  if (v.length === 0 || v.length > max) throw new SenderError(`${field} must be 1-${max} characters.`);
  return v;
}

export const init = spacetimedb.init(ctx => {
  ctx.db.moduleOwner.insert({ id: 0, identity: ctx.sender });
});

// --- owner setup -----------------------------------------------------------------------------

/** Owner-only. Fixed demo company and accounting policy (single row). */
export const configureSettings = spacetimedb.reducer(
  { companyId: t.string(), currency: t.string(), expenseAccount: Account, liabilityAccount: Account, policyVersion: t.string() },
  (ctx, args) => {
    requireOwner(ctx);
    const existing = ctx.db.settings.id.find(0);
    if (existing && existing.companyId !== args.companyId) throw new SenderError('This database is bound to a different company.');
    if (args.currency !== 'USD') throw new SenderError('Initial scope is USD only.');
    const row = {
      id: 0,
      companyId: requireText(args.companyId, 'companyId', 64),
      currency: args.currency,
      expenseAccount: { code: requireText(args.expenseAccount.code, 'expenseAccount.code', 32), name: requireText(args.expenseAccount.name, 'expenseAccount.name') },
      liabilityAccount: { code: requireText(args.liabilityAccount.code, 'liabilityAccount.code', 32), name: requireText(args.liabilityAccount.name, 'liabilityAccount.name') },
      policyVersion: requireText(args.policyVersion, 'policyVersion', 64),
    };
    if (existing) ctx.db.settings.id.update(row);
    else ctx.db.settings.insert(row);
  }
);

/** Owner-only. Configure a gateway or worker service identity (idempotent). */
export const registerServiceIdentity = spacetimedb.reducer(
  { identity: t.identity(), role: t.string(), label: t.string() },
  (ctx, args) => {
    requireOwner(ctx);
    if (!ROLES.includes(args.role)) throw new SenderError(`role must be one of ${ROLES.join(', ')}.`);
    if (ctx.db.moduleOwner.id.find(0)!.identity.isEqual(args.identity)) {
      throw new SenderError('The owner identity cannot be a service identity.');
    }
    const existing = ctx.db.serviceIdentity.identity.find(args.identity);
    if (existing && existing.role !== args.role) throw new SenderError(`Identity is already registered as ${existing.role}.`);
    if (!existing) {
      ctx.db.serviceIdentity.insert({ identity: args.identity, role: args.role, label: requireText(args.label, 'label', 64), createdAt: ctx.timestamp });
    }
  }
);

// --- documents ---------------------------------------------------------------------------------

type FileMetadata = {
  storageKey: string;
  contentHash: string;
  byteLength: number;
  mediaType: string;
  originalFilename: string;
  sourceLabel: string;
};

/** Validate metadata for bytes the gateway has already written to the file store. */
function validateFileMetadata(m: FileMetadata) {
  if (!SHA256_HEX.test(m.contentHash)) throw new SenderError('contentHash must be a lowercase SHA-256 hex digest.');
  if (m.storageKey !== `sha256/${m.contentHash}`) throw new SenderError('storageKey must be "sha256/<contentHash>".');
  if (!MEDIA_TYPES.includes(m.mediaType)) throw new SenderError(`Unsupported media type ${m.mediaType}.`);
  if (m.byteLength < 1 || m.byteLength > MAX_UPLOAD_BYTES) throw new SenderError(`byteLength must be 1 to ${MAX_UPLOAD_BYTES}.`);
  requireText(m.originalFilename, 'originalFilename');
  requireText(m.sourceLabel, 'sourceLabel');
}

/** Same uploadKey seen before: no-op for identical content (retry), error otherwise. */
function isRetry(ctx: Ctx, uploadKey: string, contentHash: string): boolean {
  const existing = ctx.db.documents.uploadKey.find(uploadKey);
  if (!existing) return false;
  if (existing.contentHash !== contentHash) throw new SenderError(`uploadKey "${uploadKey}" was already used for different content.`);
  return true;
}

/** Gateway-only. Record version 1 of a document whose bytes are already on the file store. */
export const storeDocument = spacetimedb.reducer(
  {
    companyId: t.string(),
    uploadKey: t.string(),
    storageKey: t.string(),
    contentHash: t.string(),
    byteLength: t.u32(),
    mediaType: t.string(),
    originalFilename: t.string(),
    type: t.string(),
    referenceId: t.option(t.string()),
    sourceLabel: t.string(),
  },
  (ctx, args) => {
    requireGateway(ctx);
    requireCompany(ctx, args.companyId);
    const uploadKey = requireText(args.uploadKey, 'uploadKey', 128);
    if (isRetry(ctx, uploadKey, args.contentHash)) return;
    if (!DOCUMENT_TYPES.includes(args.type)) throw new SenderError(`type must be one of ${DOCUMENT_TYPES.join(', ')}.`);
    validateFileMetadata(args);
    ctx.db.documents.insert({
      id: 0n,
      companyId: args.companyId,
      storageKey: args.storageKey,
      type: args.type,
      version: 1,
      contentHash: args.contentHash,
      byteLength: args.byteLength,
      mediaType: args.mediaType,
      originalFilename: args.originalFilename.trim(),
      referenceId: args.referenceId === undefined ? undefined : requireText(args.referenceId, 'referenceId', 128),
      sourceLabel: args.sourceLabel.trim(),
      supersedesDocumentId: undefined,
      uploadKey,
      createdAt: ctx.timestamp,
    });
  }
);

/**
 * Gateway-only. Record version N+1 (brief: "preserve source versions"). The previous row is not
 * modified; only the latest version can be superseded, and identical content is rejected.
 */
export const storeDocumentVersion = spacetimedb.reducer(
  {
    companyId: t.string(),
    uploadKey: t.string(),
    previousDocumentId: t.u64(),
    storageKey: t.string(),
    contentHash: t.string(),
    byteLength: t.u32(),
    mediaType: t.string(),
    originalFilename: t.string(),
    sourceLabel: t.string(),
  },
  (ctx, args) => {
    requireGateway(ctx);
    requireCompany(ctx, args.companyId);
    const uploadKey = requireText(args.uploadKey, 'uploadKey', 128);
    if (isRetry(ctx, uploadKey, args.contentHash)) return;
    const previous = ctx.db.documents.id.find(args.previousDocumentId);
    if (!previous || previous.companyId !== args.companyId) throw new SenderError(`Document ${args.previousDocumentId} not found.`);
    const newer = [...ctx.db.documents.iter()].find(d => d.supersedesDocumentId === previous.id);
    if (newer) throw new SenderError(`Document ${previous.id} is already superseded by document ${newer.id}; version the latest one.`);
    if (args.contentHash === previous.contentHash) throw new SenderError('New version has identical content to the previous version.');
    validateFileMetadata(args);
    ctx.db.documents.insert({
      id: 0n,
      companyId: args.companyId,
      storageKey: args.storageKey,
      type: previous.type,
      version: previous.version + 1,
      contentHash: args.contentHash,
      byteLength: args.byteLength,
      mediaType: args.mediaType,
      originalFilename: args.originalFilename.trim(),
      referenceId: previous.referenceId,
      sourceLabel: args.sourceLabel.trim(),
      supersedesDocumentId: previous.id,
      uploadKey,
      createdAt: ctx.timestamp,
    });
  }
);

// --- views (brief: public views check ctx.sender against configured identities) --------------

/** Documents visible to the configured gateway and worker identities; empty for anyone else. */
export const documentsView = spacetimedb.view(
  { name: 'documents_view', public: true },
  t.array(documents.rowType),
  ctx => {
    if (!ctx.db.serviceIdentity.identity.find(ctx.sender)) return [];
    const s = ctx.db.settings.id.find(0);
    return s ? [...ctx.db.documents.companyId.filter(s.companyId)] : [];
  }
);

/** Company settings for the configured service identities. */
export const settingsView = spacetimedb.view(
  { name: 'settings_view', public: true },
  t.array(settings.rowType),
  ctx => {
    if (!ctx.db.serviceIdentity.identity.find(ctx.sender)) return [];
    const s = ctx.db.settings.id.find(0);
    return s ? [s] : [];
  }
);

/** The caller's own service role (empty if unregistered), so services can self-check at startup. */
export const myServiceIdentity = spacetimedb.view(
  { name: 'my_service_identity', public: true },
  t.array(t.object('ServiceRole', { role: t.string(), label: t.string() })),
  ctx => {
    const me = ctx.db.serviceIdentity.identity.find(ctx.sender);
    return me ? [{ role: me.role, label: me.label }] : [];
  }
);
