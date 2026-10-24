# SpacetimeDB document storage: setup and handoff

**Phase goal:** SpacetimeDB runs locally and can store, retrieve, version and list synthetic source documents and their metadata.

> **Not in this phase:** AI agents (Factory, Bitdeer), worker loops, job leasing, extraction, matching, investigation, accounting calculations, proposals, approvals, reviews, exports and CSV generation, the mock mailbox, and case workflows. This phase is **document storage only**. All data is synthetic.

## 1. Prerequisites (Windows PowerShell)

| Tool | Version | Check |
|---|---|---|
| Node.js | 22.x | `node --version` |
| SpacetimeDB CLI | 2.13.x | `spacetime --version` |

Install the SpacetimeDB CLI once:

```powershell
iwr https://windows.spacetimedb.com -useb | iex
```

The installer adds `%LOCALAPPDATA%\SpacetimeDB` to your user PATH, so **open a new terminal** afterwards. If `spacetime` still isn't found, refresh the PATH in the current terminal:

```powershell
$env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path
```

Install the dependencies from the repo root:

```powershell
cd C:\path\to\AfterHours
npm install          # Node client, seed, smoke test
npm run db:install   # SpacetimeDB module dependencies
```

## 2. Start the local server

Run this in a dedicated terminal and leave it running:

```powershell
spacetime start
```

The server listens on `http://localhost:3000`. To check it, run `spacetime server ping local`.

## 3. Environment variables

All variables are optional; the defaults work for local development. To override them, copy the template: `Copy-Item .env.example .env`. Every npm script loads `.env` automatically when it exists, and `.env` is git-ignored.

| Variable | Default | Used by |
|---|---|---|
| `SPACETIMEDB_URI` | `http://localhost:3000` | publish, generate, seed, smoke, and the client library |
| `SPACETIMEDB_DATABASE` | `accrual-docs` | same as above |
| `SPACETIME_BIN` | auto-detected | path to `spacetime.exe`, if it isn't on PATH |

Database names must match `^[a-z0-9]+(-[a-z0-9]+)*$`: lowercase letters, digits and dashes, with **no underscores**.

```powershell
$env:SPACETIMEDB_DATABASE = "accrual-docs"   # optional
```

No API keys or external providers are needed.

## 4. Publish the module

```powershell
npm run db:publish   # create or update the database, keeping its data
npm run db:reset     # wipe all data and republish (use after breaking schema changes)
```

The first publish logs the CLI in to the **local server only** and makes that identity the database owner.

## 5. Generate TypeScript bindings

Run this after every schema or reducer change:

```powershell
npm run db:generate   # writes backend/db/bindings/
npm run typecheck
```

## 6. Seed and smoke test

```powershell
npm run db:seed    # 5 synthetic documents, plus a v2 of the timesheet (idempotent)
npm run smoke      # 10 checks; prints PASS/FAIL and exits non-zero on failure
npm run db:sql     # SELECT id, doc_type, version, reference_id FROM documents
npm run db:sql -- "SELECT id, original_filename, byte_size, sha256 FROM files"
```

The seed uses reference ID `DEMO-ACME-2026-09`. Each smoke run uses a fresh `SMOKE-xxxxxxxx` reference ID, so it can be re-run against the same database.

## 7. Schema (the document-storage contract)

`files` and `documents` rows are **never updated or deleted**. A change is always a new version row.

### `files` (public)
| Column | Type | Notes |
|---|---|---|
| `id` | u64, primary key, auto-increment | |
| `original_filename` | string | |
| `mime_type` | string | One of `text/plain`, `text/csv`, `application/json`, `application/pdf` |
| `bytes` | byte array | Raw file content, up to 2 MB |
| `byte_size` | u32 | |
| `sha256` | string, btree index | Lowercase hex, computed **by the server** |
| `created_at` | timestamp | Server time |

### `documents` (public)
| Column | Type | Notes |
|---|---|---|
| `id` | u64, primary key, auto-increment | |
| `file_id` | u64, btree index | Refers to `files.id` |
| `doc_type` | string, btree index | `CONTRACT`, `AMENDMENT`, `TIMESHEET`, `INVOICE`, `LEDGER_EXPORT` or `OTHER` |
| `reference_id` | option\<string\> | A free-form case or reference ID for future linking |
| `version` | u32 | 1, 2, 3 and so on |
| `content_hash` | string, btree index | Equal to `files.sha256` |
| `source_label` | string | Where the document came from, e.g. `seed (SYNTHETIC)` or `ui upload` |
| `supersedes_document_id` | option\<u64\> | The previous version. Empty for v1 |
| `upload_key` | string, unique | Idempotency key chosen by the caller |
| `created_at` | timestamp | |

### `document_text` (public, optional)
| Column | Type | Notes |
|---|---|---|
| `document_id` | u64, primary key | Refers to `documents.id` |
| `text` | string | Extracted text |
| `extraction_status` | string | `PENDING`, `EXTRACTED` or `FAILED` |
| `created_at` | timestamp | |

Unlike the other two tables, a `document_text` row **may be replaced**, for example when text is re-extracted.

## 8. Reducer reference

Reducers are transactional and **return no data**. A call resolves on success and rejects with an error message on failure. Read results from the subscribed tables. There are no procedures in this phase.

| Reducer (TS accessor) | Arguments | Behavior |
|---|---|---|
| `store_document` (`storeDocument`) | `uploadKey`, `originalFilename`, `mimeType`, `bytes`, `expectedSha256` (`''` skips the check), `docType`, `referenceId?`, `sourceLabel` | Validates the type, MIME type and size, computes the SHA-256, and rejects the call if `expectedSha256` doesn't match. Inserts a `files` row and a `documents` row at v1. If the `uploadKey` was already used with the same content, it does nothing; with different content, it errors. |
| `store_document_version` (`storeDocumentVersion`) | `uploadKey`, `previousDocumentId`, `originalFilename`, `mimeType`, `bytes`, `expectedSha256`, `sourceLabel` | Adds version N+1, which inherits `docType` and `referenceId` and sets `supersedesDocumentId`. The old row is unchanged. Rejects the call if the previous document isn't the latest version or the content is identical. |
| `verify_stored_file` (`verifyStoredFile`) | `fileId` | Recomputes the size and SHA-256 on the server and rejects the call on any mismatch. |
| `store_document_text` (`storeDocumentText`) | `documentId`, `text`, `extractionStatus` | Inserts or replaces the extracted text for a document. |

### Node repository API: `backend/db/repositories/`
Use these helpers instead of calling reducers directly.

```ts
import { connect } from './backend/db/repositories/client';
import * as docs from './backend/db/repositories/documents';

const { conn } = await connect();                          // subscribes to all tables
const doc = await docs.uploadDocument(conn, { bytes, originalFilename, mimeType, docType: 'INVOICE', referenceId, sourceLabel });
const v2  = await docs.addDocumentVersion(conn, doc.id, { bytes: newBytes, originalFilename, mimeType, sourceLabel });
docs.getDocument(conn, id);  docs.getFile(conn, fileId);  docs.readDocument(conn, id);   // includes bytes
docs.listDocuments(conn, { docType: 'TIMESHEET', referenceId, latestOnly: true });
docs.getVersionHistory(conn, anyVersionId);                 // v1 first
docs.verifyFileLocally(conn, fileId);  await docs.verifyFileOnServer(conn, fileId);
await docs.saveDocumentText(conn, id, text, 'EXTRACTED');  docs.getDocumentText(conn, id);
```

## 9. File layout

```
backend/db/spacetime/spacetimedb/src/schema.ts       tables
backend/db/spacetime/spacetimedb/src/index.ts        reducers
backend/db/spacetime/spacetimedb/src/rules/hash.ts   pure-TS SHA-256 (module runtime has no node:crypto)
backend/db/bindings/                                 generated - do not edit
backend/db/repositories/client.ts                    connect + waitFor
backend/db/repositories/documents.ts                 document API (above)
backend/db/seed/seed.ts, seed/documents/*            synthetic seed data
backend/db/test/smoke.ts                             smoke test
scripts/db.mjs                                       publish / reset / generate / sql wrapper
```

## 10. Adding agent features later without breaking this contract

- **Treat the three tables and four reducers above as a stable API.** Add new tables (jobs, facts, cases and so on) and new reducers alongside them. Don't change these columns.
- **Link by ID, don't copy.** New tables should store `documents.id`, plus a page or row reference where useful, instead of duplicating bytes or metadata. `reference_id` is a plain string precisely so a future `cases` table can adopt it without a migration.
- **Agents read documents** through `listDocuments`, `readDocument` and `getDocumentText`. They write extracted text through `saveDocumentText`, using `PENDING`, `EXTRACTED` or `FAILED`.
- **Never mutate or delete document versions.** A corrected source is a new version created with `addDocumentVersion`. Anything derived from a document should record which `documents.id` (version) it used, so downstream logic can tell when its inputs changed.
- **Schema migrations:** adding a table or appending a column with `.default(...)` is safe under `npm run db:publish`. Renaming or removing columns is a breaking change that requires `npm run db:reset`, which wipes all data. After any change, run `npm run db:generate`, then `npm run typecheck`, then `npm run smoke`.
- **Authorization is open in this phase.** Any client can call these reducers. When agents arrive, add identity checks with `ctx.sender` in new reducers. Don't trust identities passed as arguments.
- **Large files:** bytes live in the row, so keep the 2 MB limit for demo data. If you need bigger files, add an external blob store and keep `files.sha256` as the integrity anchor.
