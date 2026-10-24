// Document-storage schema. This is the stable contract other components (agents, UI) build on.
// Rows in `files` and `documents` are never updated or deleted: a change is a new version row.

import { schema, table, t } from 'spacetimedb/server';

/** Raw uploaded bytes plus integrity metadata. */
const files = table(
  { name: 'files', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    originalFilename: t.string(),
    mimeType: t.string(),
    bytes: t.byteArray(),
    byteSize: t.u32(),
    sha256: t.string().index('btree'),
    createdAt: t.timestamp(),
  }
);

/**
 * One version of a logical document. Version 1 has no supersedesDocumentId; version N+1 points
 * at version N. uploadKey is a caller-chosen idempotency key so retries never create duplicates.
 */
const documents = table(
  { name: 'documents', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    fileId: t.u64().index('btree'),
    docType: t.string().index('btree'),
    referenceId: t.option(t.string()),
    version: t.u32(),
    contentHash: t.string().index('btree'),
    sourceLabel: t.string(),
    supersedesDocumentId: t.option(t.u64()),
    uploadKey: t.string().unique(),
    createdAt: t.timestamp(),
  }
);

/** Optional extracted text for a document (one row per document; may be replaced). */
const documentText = table(
  { name: 'document_text', public: true },
  {
    documentId: t.u64().primaryKey(),
    text: t.string(),
    extractionStatus: t.string(),
    createdAt: t.timestamp(),
  }
);

const spacetimedb = schema({ files, documents, documentText });
export default spacetimedb;
