// Document-storage repository: the API other components (agents, UI) should use.
// Writes go through reducers; reads come from the subscribed local replica.

import { createHash, randomUUID } from 'node:crypto';
import type { DbConnection } from '../bindings/index';
import { waitFor } from './client';

export const DOC_TYPES = ['ACCRUAL', 'CONTRACT', 'AMENDMENT', 'TIMESHEET', 'INVOICE', 'LEDGER', 'OTHER'] as const;
export type DocType = (typeof DOC_TYPES)[number];

type Rows<T extends { iter(): Iterable<unknown> }> = T extends { iter(): Iterable<infer R> } ? R : never;
export type FileRow = Rows<DbConnection['db']['files']>;
export type DocumentRow = Rows<DbConnection['db']['documents']>;
export type DocumentTextRow = Rows<DbConnection['db']['documentText']>;

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export type UploadInput = {
  bytes: Uint8Array;
  originalFilename: string;
  mimeType: string;
  docType: DocType;
  referenceId?: string;
  sourceLabel: string;
  /** Idempotency key; reuse it when retrying the same upload. Defaults to a random UUID. */
  uploadKey?: string;
};

/** Upload a file and create version 1 of a document. Resolves with the stored document row. */
export async function uploadDocument(conn: DbConnection, input: UploadInput): Promise<DocumentRow> {
  const uploadKey = input.uploadKey ?? randomUUID();
  await conn.reducers.storeDocument({
    uploadKey,
    originalFilename: input.originalFilename,
    mimeType: input.mimeType,
    bytes: input.bytes,
    expectedSha256: sha256(input.bytes),
    docType: input.docType,
    referenceId: input.referenceId,
    sourceLabel: input.sourceLabel,
  });
  return waitFor(() => findByUploadKey(conn, uploadKey), `document ${uploadKey}`);
}

export type VersionInput = Omit<UploadInput, 'docType' | 'referenceId'>;

/** Add a new version of a document; the previous version row is left unchanged. */
export async function addDocumentVersion(conn: DbConnection, previousDocumentId: bigint, input: VersionInput): Promise<DocumentRow> {
  const uploadKey = input.uploadKey ?? randomUUID();
  await conn.reducers.storeDocumentVersion({
    uploadKey,
    previousDocumentId,
    originalFilename: input.originalFilename,
    mimeType: input.mimeType,
    bytes: input.bytes,
    expectedSha256: sha256(input.bytes),
    sourceLabel: input.sourceLabel,
  });
  return waitFor(() => findByUploadKey(conn, uploadKey), `document version ${uploadKey}`);
}

export function findByUploadKey(conn: DbConnection, uploadKey: string): DocumentRow | undefined {
  return [...conn.db.documents.iter()].find(d => d.uploadKey === uploadKey);
}

export function getDocument(conn: DbConnection, id: bigint): DocumentRow | undefined {
  return conn.db.documents.id.find(id) ?? undefined;
}

export function getFile(conn: DbConnection, id: bigint): FileRow | undefined {
  return conn.db.files.id.find(id) ?? undefined;
}

export function getDocumentText(conn: DbConnection, documentId: bigint): DocumentTextRow | undefined {
  return conn.db.documentText.documentId.find(documentId) ?? undefined;
}

/** List documents, oldest first. `latestOnly` hides versions that have been superseded. */
export function listDocuments(
  conn: DbConnection,
  filter: { docType?: DocType; referenceId?: string; latestOnly?: boolean } = {}
): DocumentRow[] {
  const all = [...conn.db.documents.iter()];
  const superseded = new Set(all.map(d => d.supersedesDocumentId).filter((x): x is bigint => x !== undefined));
  return all
    .filter(d => !filter.docType || d.docType === filter.docType)
    .filter(d => filter.referenceId === undefined || d.referenceId === filter.referenceId)
    .filter(d => !filter.latestOnly || !superseded.has(d.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Every version in a document's chain, version 1 first. Accepts any version's id. */
export function getVersionHistory(conn: DbConnection, documentId: bigint): DocumentRow[] {
  const all = [...conn.db.documents.iter()];
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

/** Bytes and metadata for a document. */
export function readDocument(conn: DbConnection, documentId: bigint): { document: DocumentRow; file: FileRow; bytes: Uint8Array } {
  const document = getDocument(conn, documentId);
  if (!document) throw new Error(`Document ${documentId} not found`);
  const file = getFile(conn, document.fileId);
  if (!file) throw new Error(`File ${document.fileId} not found`);
  return { document, file, bytes: file.bytes };
}

/** Check stored bytes against the recorded size and hash, client-side (Node crypto). */
export function verifyFileLocally(conn: DbConnection, fileId: bigint): { ok: boolean; byteSize: number; sha256: string } {
  const file = getFile(conn, fileId);
  if (!file) throw new Error(`File ${fileId} not found`);
  const actual = sha256(file.bytes);
  return { ok: file.bytes.length === file.byteSize && actual === file.sha256, byteSize: file.bytes.length, sha256: actual };
}

/** Ask the database to recompute size and hash server-side. Rejects on mismatch. */
export function verifyFileOnServer(conn: DbConnection, fileId: bigint): Promise<void> {
  return conn.reducers.verifyStoredFile({ fileId });
}

/** Save (or replace) extracted text for a document. For future extraction agents. */
export function saveDocumentText(conn: DbConnection, documentId: bigint, text: string, extractionStatus: 'PENDING' | 'EXTRACTED' | 'FAILED') {
  return conn.reducers.storeDocumentText({ documentId, text, extractionStatus });
}
