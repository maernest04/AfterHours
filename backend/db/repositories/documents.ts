// Document-storage repository: the API the gateway (control plane) and worker use.
// Writes: bytes to the file store, then metadata through gateway-only reducers.
// Reads: the `documents_view` replica (visible only to configured service identities) + file store.

import { randomUUID } from 'node:crypto';
import type { DbConnection } from '../bindings/index';
import { waitFor } from './client';
import { getFile, putFile } from './file_store';

// Shared document types and upload limits for document storage.
export const DOCUMENT_TYPES = ['ACCRUAL', 'CONTRACT', 'AMENDMENT', 'TIMESHEET', 'INVOICE', 'LEDGER', 'OTHER'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const MEDIA_TYPES = ['text/csv', 'application/json', 'text/plain', 'application/pdf'] as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

type Rows<T> = T extends { iter(): Iterable<infer R> } ? R : never;
export type DocumentRow = Rows<DbConnection['db']['documentsView']>;

export type UploadInput = {
  companyId: string;
  bytes: Uint8Array;
  originalFilename: string;
  mediaType: string;
  type: DocumentType;
  referenceId?: string;
  sourceLabel: string;
  /** Idempotency key; reuse it when retrying the same upload. Defaults to a random UUID. */
  uploadKey?: string;
};

function checkBytes(bytes: Uint8Array, mediaType: string) {
  if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) throw new Error(`Upload must be 1 to ${MAX_UPLOAD_BYTES} bytes`);
  if (!(MEDIA_TYPES as readonly string[]).includes(mediaType)) throw new Error(`Unsupported media type ${mediaType}`);
}

/** Gateway: save bytes to the file store, then record version 1. Resolves with the document row. */
export async function uploadDocument(conn: DbConnection, input: UploadInput): Promise<DocumentRow> {
  checkBytes(input.bytes, input.mediaType);
  const uploadKey = input.uploadKey ?? randomUUID();
  const stored = putFile(input.bytes);
  await conn.reducers.storeDocument({
    companyId: input.companyId,
    uploadKey,
    ...stored,
    mediaType: input.mediaType,
    originalFilename: input.originalFilename,
    type: input.type,
    referenceId: input.referenceId,
    sourceLabel: input.sourceLabel,
  });
  return waitFor(() => findByUploadKey(conn, uploadKey), `document ${uploadKey}`);
}

export type VersionInput = Omit<UploadInput, 'type' | 'referenceId'>;

/** Gateway: add a new version of a document; the previous version row is left unchanged. */
export async function addDocumentVersion(conn: DbConnection, previousDocumentId: bigint, input: VersionInput): Promise<DocumentRow> {
  checkBytes(input.bytes, input.mediaType);
  const uploadKey = input.uploadKey ?? randomUUID();
  const stored = putFile(input.bytes);
  await conn.reducers.storeDocumentVersion({
    companyId: input.companyId,
    uploadKey,
    previousDocumentId,
    ...stored,
    mediaType: input.mediaType,
    originalFilename: input.originalFilename,
    sourceLabel: input.sourceLabel,
  });
  return waitFor(() => findByUploadKey(conn, uploadKey), `document version ${uploadKey}`);
}

export function findByUploadKey(conn: DbConnection, uploadKey: string): DocumentRow | undefined {
  return [...conn.db.documentsView.iter()].find(d => d.uploadKey === uploadKey);
}

export function getDocument(conn: DbConnection, id: bigint): DocumentRow | undefined {
  return [...conn.db.documentsView.iter()].find(d => d.id === id);
}

/** Documents with identical content (duplicate check). */
export function findByContentHash(conn: DbConnection, contentHash: string): DocumentRow[] {
  return [...conn.db.documentsView.iter()].filter(d => d.contentHash === contentHash);
}

/** List documents, oldest first. `latestOnly` hides versions that have been superseded. */
export function listDocuments(
  conn: DbConnection,
  filter: { type?: DocumentType; referenceId?: string; latestOnly?: boolean } = {}
): DocumentRow[] {
  const all = [...conn.db.documentsView.iter()];
  const superseded = new Set(all.map(d => d.supersedesDocumentId).filter((x): x is bigint => x !== undefined));
  return all
    .filter(d => !filter.type || d.type === filter.type)
    .filter(d => filter.referenceId === undefined || d.referenceId === filter.referenceId)
    .filter(d => !filter.latestOnly || !superseded.has(d.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Every version in a document's chain, version 1 first. Accepts any version's id. */
export function getVersionHistory(conn: DbConnection, documentId: bigint): DocumentRow[] {
  const all = [...conn.db.documentsView.iter()];
  let first = all.find(d => d.id === documentId);
  if (!first) return [];
  while (first.supersedesDocumentId !== undefined) {
    const prev = all.find(d => d.id === first!.supersedesDocumentId);
    if (!prev) break;
    first = prev;
  }
  const chain = [first];
  for (;;) {
    const next = all.find(d => d.supersedesDocumentId === chain[chain.length - 1].id);
    if (!next) return chain;
    chain.push(next);
  }
}

/** Metadata plus bytes from the file store, verified against the recorded hash and size. */
export function readDocument(conn: DbConnection, documentId: bigint): { document: DocumentRow; bytes: Uint8Array } {
  const document = getDocument(conn, documentId);
  if (!document) throw new Error(`Document ${documentId} not found`);
  return { document, bytes: getFile(document.storageKey, document) };
}

/** Re-hash a document's stored bytes. */
export function verifyDocument(conn: DbConnection, documentId: bigint): { ok: boolean; error?: string } {
  try {
    readDocument(conn, documentId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
