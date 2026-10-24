// Module entry: the schema is the default export; every named export is a registered reducer.
// Reducers return no data — clients read `files`, `documents` and `document_text` via subscription.

import { SenderError, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import spacetimedb from './schema';
import { sha256Hex } from './rules/hash';

export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

// Matches DocumentType in backend/control_plane/contracts.ts.
const DOC_TYPES = ['ACCRUAL', 'CONTRACT', 'AMENDMENT', 'TIMESHEET', 'INVOICE', 'LEDGER', 'OTHER'];
const MIME_TYPES = ['text/plain', 'text/csv', 'application/json', 'application/pdf'];
const EXTRACTION_STATUSES = ['PENDING', 'EXTRACTED', 'FAILED'];
const MAX_BYTES = 10 * 1024 * 1024; // Matches parameterLimits.maxUploadBytes in backend/control_plane.

function requireNonEmpty(value: string, field: string, max = 255): string {
  const v = value.trim();
  if (v.length === 0 || v.length > max) throw new SenderError(`${field} must be 1-${max} characters.`);
  return v;
}

/** Validate and store bytes; returns the new files row. */
function insertFile(ctx: Ctx, originalFilename: string, mimeType: string, bytes: Uint8Array, expectedSha256: string) {
  if (!MIME_TYPES.includes(mimeType)) throw new SenderError(`Unsupported MIME type ${mimeType}. Allowed: ${MIME_TYPES.join(', ')}.`);
  if (bytes.length === 0) throw new SenderError('File is empty.');
  if (bytes.length > MAX_BYTES) throw new SenderError(`File is larger than ${MAX_BYTES} bytes.`);
  const sha256 = sha256Hex(bytes);
  if (expectedSha256 !== '' && expectedSha256.toLowerCase() !== sha256) {
    throw new SenderError(`Integrity check failed: expected sha256 ${expectedSha256}, received ${sha256}.`);
  }
  return ctx.db.files.insert({
    id: 0n,
    originalFilename: requireNonEmpty(originalFilename, 'originalFilename'),
    mimeType,
    bytes,
    byteSize: bytes.length,
    sha256,
    createdAt: ctx.timestamp,
  });
}

/** Same uploadKey already stored: no-op if it is the same content, error otherwise. */
function alreadyStored(ctx: Ctx, uploadKey: string, bytes: Uint8Array): boolean {
  const existing = ctx.db.documents.uploadKey.find(uploadKey);
  if (!existing) return false;
  if (existing.contentHash !== sha256Hex(bytes)) {
    throw new SenderError(`uploadKey "${uploadKey}" was already used for different content.`);
  }
  return true;
}

/** Upload a file and create version 1 of a document. */
export const storeDocument = spacetimedb.reducer(
  {
    uploadKey: t.string(),
    originalFilename: t.string(),
    mimeType: t.string(),
    bytes: t.byteArray(),
    expectedSha256: t.string(),
    docType: t.string(),
    referenceId: t.option(t.string()),
    sourceLabel: t.string(),
  },
  (ctx, args) => {
    const uploadKey = requireNonEmpty(args.uploadKey, 'uploadKey', 128);
    if (!DOC_TYPES.includes(args.docType)) throw new SenderError(`docType must be one of ${DOC_TYPES.join(', ')}.`);
    if (alreadyStored(ctx, uploadKey, args.bytes)) return;
    const referenceId = args.referenceId === undefined ? undefined : requireNonEmpty(args.referenceId, 'referenceId', 128);
    const file = insertFile(ctx, args.originalFilename, args.mimeType, args.bytes, args.expectedSha256);
    ctx.db.documents.insert({
      id: 0n,
      fileId: file.id,
      docType: args.docType,
      referenceId,
      version: 1,
      contentHash: file.sha256,
      sourceLabel: requireNonEmpty(args.sourceLabel, 'sourceLabel'),
      supersedesDocumentId: undefined,
      uploadKey,
      createdAt: ctx.timestamp,
    });
  }
);

/**
 * Add version N+1 of a document. The previous row is not modified; the new row records
 * supersedesDocumentId and inherits docType and referenceId. Only the latest version can be
 * superseded, so each document's history is a single chain.
 */
export const storeDocumentVersion = spacetimedb.reducer(
  {
    uploadKey: t.string(),
    previousDocumentId: t.u64(),
    originalFilename: t.string(),
    mimeType: t.string(),
    bytes: t.byteArray(),
    expectedSha256: t.string(),
    sourceLabel: t.string(),
  },
  (ctx, args) => {
    const uploadKey = requireNonEmpty(args.uploadKey, 'uploadKey', 128);
    if (alreadyStored(ctx, uploadKey, args.bytes)) return;
    const previous = ctx.db.documents.id.find(args.previousDocumentId);
    if (!previous) throw new SenderError(`Document ${args.previousDocumentId} not found.`);
    const newer = [...ctx.db.documents.iter()].find(d => d.supersedesDocumentId === previous.id);
    if (newer) throw new SenderError(`Document ${previous.id} is already superseded by document ${newer.id}; version the latest one.`);
    if (sha256Hex(args.bytes) === previous.contentHash) throw new SenderError('New version has identical content to the previous version.');

    const file = insertFile(ctx, args.originalFilename, args.mimeType, args.bytes, args.expectedSha256);
    ctx.db.documents.insert({
      id: 0n,
      fileId: file.id,
      docType: previous.docType,
      referenceId: previous.referenceId,
      version: previous.version + 1,
      contentHash: file.sha256,
      sourceLabel: requireNonEmpty(args.sourceLabel, 'sourceLabel'),
      supersedesDocumentId: previous.id,
      uploadKey,
      createdAt: ctx.timestamp,
    });
  }
);

/** Recompute size and SHA-256 of stored bytes. Fails (rejects the call) on any mismatch. */
export const verifyStoredFile = spacetimedb.reducer({ fileId: t.u64() }, (ctx, { fileId }) => {
  const file = ctx.db.files.id.find(fileId);
  if (!file) throw new SenderError(`File ${fileId} not found.`);
  if (file.bytes.length !== file.byteSize) {
    throw new SenderError(`File ${fileId} size mismatch: stored ${file.byteSize}, actual ${file.bytes.length}.`);
  }
  const actual = sha256Hex(file.bytes);
  if (actual !== file.sha256) throw new SenderError(`File ${fileId} hash mismatch: stored ${file.sha256}, actual ${actual}.`);
});

/** Store (or replace) extracted text for a document. Extraction itself happens outside the DB. */
export const storeDocumentText = spacetimedb.reducer(
  { documentId: t.u64(), text: t.string(), extractionStatus: t.string() },
  (ctx, args) => {
    if (!ctx.db.documents.id.find(args.documentId)) throw new SenderError(`Document ${args.documentId} not found.`);
    if (!EXTRACTION_STATUSES.includes(args.extractionStatus)) {
      throw new SenderError(`extractionStatus must be one of ${EXTRACTION_STATUSES.join(', ')}.`);
    }
    const row = { documentId: args.documentId, text: args.text, extractionStatus: args.extractionStatus, createdAt: ctx.timestamp };
    if (ctx.db.documentText.documentId.find(args.documentId)) ctx.db.documentText.documentId.update(row);
    else ctx.db.documentText.insert(row);
  }
);
