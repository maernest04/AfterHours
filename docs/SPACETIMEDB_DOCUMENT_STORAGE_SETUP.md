# SpacetimeDB document storage: setup and handoff

**Audience:** teammates and coding agents setting this up on another machine.
**Phase goal:** SpacetimeDB runs locally and can store, retrieve, version and list synthetic source documents and their metadata.

> **Not in this phase:** AI agents (Factory, Bitdeer), worker loops, job leasing, extraction, matching, investigation, accounting calculations, proposals, approvals, reviews, exports and CSV generation, the mock mailbox, and case workflows. This phase is **document storage only**. All data is synthetic, and no API keys are needed.

---

## 0. Quick start (copy-paste)

Run these from the repo root. Section numbers point to the details.

```powershell
# one-time per machine (§1)
iwr https://windows.spacetimedb.com -useb | iex      # macOS/Linux: curl -sSf https://install.spacetimedb.com | sh
# open a NEW terminal, then:
spacetime --version                                    # expect 2.13.x
node --version                                         # expect v22.x

# one-time per clone (§2)
npm install
npm run db:install

# terminal A: leave running (§3)
spacetime start

# terminal B (§4-§6)
npm run db:publish        # first run creates database "accrual-docs"
npm run db:generate       # regenerate TypeScript bindings
npm run typecheck
npm run db:seed           # synthetic documents (safe to re-run)
npm run smoke             # expect: 13/13 checks passed
```

**Done when:** `npm run smoke` ends with `13/13 checks passed`, and `npm run db:sql` lists document rows for `DEMO-ACME-2026-09`.

---

## 1. Prerequisites (one-time per machine)

| Tool | Required version | Check |
|---|---|---|
| Git | any | `git --version` |
| Node.js | **22.x** (22.18+ recommended, see §9) | `node --version` |
| SpacetimeDB CLI | **2.13.x**, matching the `spacetimedb` npm package | `spacetime --version` |

Install the SpacetimeDB CLI:

| OS | Command |
|---|---|
| Windows (PowerShell) | `iwr https://windows.spacetimedb.com -useb \| iex` |
| macOS / Linux | `curl -sSf https://install.spacetimedb.com \| sh` |

- **Windows:** the installer adds `%LOCALAPPDATA%\SpacetimeDB` to your user PATH, so **open a new terminal** afterwards. To refresh PATH in the current PowerShell session instead, run:
  ```powershell
  $env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path
  ```
- **Pin the version.** The CLI and the npm SDK must share a minor version (`2.13`). If `spacetime --version` reports something else, run:
  ```powershell
  spacetime version install 2.13.0
  spacetime version use 2.13.0
  ```

## 2. Install dependencies (one-time per clone)

```powershell
git clone <repo-url> AfterHours
cd AfterHours
npm install          # root: spacetimedb SDK, tsx, typescript (Node client, seed, smoke)
npm run db:install   # backend/db/spacetime/spacetimedb: module dependencies used by `spacetime publish`
```

## 3. Start the local server

Run this in its own terminal and leave it running:

```powershell
spacetime start
```

- The server listens on `http://localhost:3000`. To check it, run `spacetime server ping local`.
- Data persists between restarts in the CLI's data directory. Each machine has its **own** local server and data; nothing is shared between machines.

## 4. Environment variables

Every variable is optional; the defaults work for local development. To override them, copy the template:

```powershell
Copy-Item .env.example .env      # macOS/Linux: cp .env.example .env
```

Every npm script loads `.env` automatically when it exists (`--env-file-if-exists`), and `.env` is git-ignored.

| Variable | Default | Used by |
|---|---|---|
| `SPACETIMEDB_URI` | `http://localhost:3000` | publish, generate, sql, seed, smoke, client library |
| `SPACETIMEDB_DATABASE` | `accrual-docs` | same as above |
| `COMPANY_ID` | `demo` | the DataPlane adapter's fixed demo company (§11) |
| `SPACETIME_BIN` | auto-detected | path to the `spacetime` executable if it's not on PATH |
| `NEXT_PUBLIC_SPACETIMEDB_URI` / `NEXT_PUBLIC_SPACETIMEDB_DATABASE` | — | reserved for the future Next.js UI; keep them equal to the values above |

Database names must match `^[a-z0-9]+(-[a-z0-9]+)*$`: lowercase letters, digits and dashes, with **no underscores**.

## 5. Publish the module and generate bindings

```powershell
npm run db:publish    # create or update the database, keeping its data
npm run db:generate   # writes backend/db/bindings/ (committed; regenerate after every schema change)
npm run typecheck     # root Node code + module
```

- **First publish on a machine:** the CLI logs itself in to the **local server only** with a server-issued identity, and that identity becomes the database **owner**. It doesn't affect any Maincloud login.
- `npm run db:reset` republishes with `--delete-data=always`, which **wipes all rows**. Use it after breaking schema changes.
- The scripts call `scripts/db.mjs`, which passes `--no-config`, so `backend/db/spacetime/spacetime*.json` are ignored by npm scripts. Those files only matter if you run `spacetime` manually from that folder.

## 6. Seed and smoke test

```powershell
npm run db:seed    # 6 synthetic Acme documents + v2 of the timesheet under reference DEMO-ACME-2026-09
npm run smoke      # 13 checks; prints PASS/FAIL per check; exit code 1 on any failure
npm run db:sql                                                         # id, doc_type, version, reference_id
npm run db:sql -- "SELECT id, original_filename, byte_size, sha256 FROM files"
```

Expected seed output, with IDs 1-7 on a fresh database (`npm run db:reset` first):

```text
[seed] CONTRACT      doc 1 v1  acme_msa.txt
[seed] AMENDMENT     doc 2 v1  acme_amendment_1.txt
[seed] TIMESHEET     doc 3 v1  acme_timesheet_2026-09_v1.csv
[seed] INVOICE       doc 4 v1  acme_invoices_2026-08.csv
[seed] LEDGER        doc 5 v1  ledger_2026-09.csv
[seed] ACCRUAL       doc 6 v1  acme_accrual_2026-09.json
[seed] TIMESHEET     doc 7 v2  supersedes doc 3
```

- The seed is idempotent because it uses fixed upload keys. Each smoke run uses a new `SMOKE-xxxxxxxx` reference ID, so you can re-run it any time without resetting.
- The smoke test checks that:
  - upload stores the file and its metadata
  - the bytes read back are identical
  - size and hash verify on both the client and the server
  - an upload with a wrong hash is rejected
  - an invalid document type or MIME type is rejected
  - an idempotent retry creates no duplicate
  - v2 is stored without changing v1
  - versioning a superseded document or uploading identical content is rejected
  - list filters work
  - extracted text round-trips
  - `api.imports.upload` and `api.evidence.readDocument` from `backend/control_plane` work end to end through the adapter (§11)
  - a 10 MiB upload, the control plane's limit, is accepted
  - the adapter rejects other companies, documents from another case, and operations that aren't built yet

## 7. Schema (the document-storage contract)

`files` and `documents` rows are **never updated or deleted**. A change is always a new version row. All three tables are public, so any client can subscribe to them.

### `files`
| Column | Type | Notes |
|---|---|---|
| `id` | u64, primary key, auto-increment | |
| `original_filename` | string | |
| `mime_type` | string | `text/plain`, `text/csv`, `application/json` or `application/pdf` |
| `bytes` | byte array | Raw content, up to **10 MiB** (matches the control plane's `maxUploadBytes`) |
| `byte_size` | u32 | |
| `sha256` | string, btree index | Lowercase hex, computed **by the server** |
| `created_at` | timestamp | Server time |

### `documents`
| Column | Type | Notes |
|---|---|---|
| `id` | u64, primary key, auto-increment | |
| `file_id` | u64, btree index | Refers to `files.id` |
| `doc_type` | string, btree index | `ACCRUAL`, `CONTRACT`, `AMENDMENT`, `TIMESHEET`, `INVOICE`, `LEDGER` or `OTHER`, the same list as `DocumentType` in `backend/control_plane/contracts.ts` |
| `reference_id` | option\<string\> | A free-form case or reference ID for future linking |
| `version` | u32 | 1, 2, 3 and so on |
| `content_hash` | string, btree index | Equal to `files.sha256` |
| `source_label` | string | Where the document came from, e.g. `seed (SYNTHETIC)` or `ui upload` |
| `supersedes_document_id` | option\<u64\> | The previous version. Empty for v1 |
| `upload_key` | string, unique | Idempotency key chosen by the caller |
| `created_at` | timestamp | |

### `document_text` (optional)
| Column | Type | Notes |
|---|---|---|
| `document_id` | u64, primary key | Refers to `documents.id` |
| `text` | string | Extracted text |
| `extraction_status` | string | `PENDING`, `EXTRACTED` or `FAILED` |
| `created_at` | timestamp | |

Unlike the other two tables, a `document_text` row **may be replaced**, for example when text is re-extracted.

## 8. Reducer and repository reference

Reducers are transactional and **return no data**. A call resolves on success and rejects with an error message on failure. Read results from the subscribed tables. There are no procedures in this phase.

| Reducer (TS accessor) | Arguments | Behavior |
|---|---|---|
| `store_document` (`storeDocument`) | `uploadKey`, `originalFilename`, `mimeType`, `bytes`, `expectedSha256` (`''` skips the check), `docType`, `referenceId?`, `sourceLabel` | Validates the type, MIME type and size, computes the SHA-256, and rejects the call if `expectedSha256` doesn't match. Inserts a `files` row and a `documents` row at v1. If the `uploadKey` was already used with the same content, it does nothing; with different content, it errors. |
| `store_document_version` (`storeDocumentVersion`) | `uploadKey`, `previousDocumentId`, `originalFilename`, `mimeType`, `bytes`, `expectedSha256`, `sourceLabel` | Adds version N+1, which inherits `docType` and `referenceId` and sets `supersedesDocumentId`. The old row is unchanged. Rejects the call if the previous document isn't the latest version or the content is identical. |
| `verify_stored_file` (`verifyStoredFile`) | `fileId` | Recomputes the size and SHA-256 on the server and rejects the call on any mismatch. |
| `store_document_text` (`storeDocumentText`) | `documentId`, `text`, `extractionStatus` | Inserts or replaces the extracted text for a document. |

**Node code should use the repository helpers** in `backend/db/repositories/` instead of calling reducers directly. The helpers compute `expectedSha256`, generate upload keys and wait for the replicated row:

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
conn.disconnect();
```

- IDs are `bigint` (`u64`), and optional columns are `undefined` when unset.
- Uploads go through a websocket message. A 10 MiB upload takes about 1 second locally.

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `spacetime` is not recognized | PATH wasn't refreshed. Open a new terminal or refresh it (§1). Or set `SPACETIME_BIN` to the full path. |
| `Server is not responding` / `ECONNREFUSED 127.0.0.1:3000` | `spacetime start` isn't running, or another process holds port 3000. |
| Publish fails with a permission or owner error | The database was created by a different identity (for example after `spacetime logout`). Use another name (`$env:SPACETIMEDB_DATABASE="accrual-docs-2"`), or run `spacetime delete accrual-docs --server local` and publish again. |
| Publish fails with a breaking-change or schema-conflict error | Run `npm run db:reset`. This wipes the data; re-run the seed afterwards. |
| TypeScript errors about missing reducers or tables | The bindings are stale. Run `npm run db:generate` after every module change. |
| Invalid database name | Underscores and uppercase letters aren't allowed (§4). |
| Seed or smoke hangs on "Connecting to SpacetimeDB WS…" | Wrong `SPACETIMEDB_URI`/`SPACETIMEDB_DATABASE`, or the module isn't published. Run `npm run db:publish`. |
| `backend/control_plane` tests fail with a TypeScript syntax error | They need Node **22.18+** (native TypeScript). On older 22.x versions, run `node --experimental-strip-types --test control_plane.test.mjs`. |
| `npm` is blocked by the PowerShell execution policy | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or run `npm.cmd`. |
| Inspect server-side errors | `spacetime logs accrual-docs --server local -n 50`. A few `ERROR` lines after a smoke run are expected: those are the deliberate rejection checks (bad MIME type, superseded version, identical content and so on). |

## 10. Repository layout (database parts)

```text
.env.example                                         environment template (§4)
package.json                                         npm scripts (db:*, smoke, typecheck)
scripts/db.mjs                                       publish / reset / generate / sql wrapper (env-driven)
backend/db/spacetime/spacetimedb/src/schema.ts       tables (§7)
backend/db/spacetime/spacetimedb/src/index.ts        reducers (§8)
backend/db/spacetime/spacetimedb/src/rules/hash.ts   pure-TS SHA-256 (module runtime has no node:crypto)
backend/db/spacetime/CLAUDE.md                       SpacetimeDB TypeScript API reference for coding agents
backend/db/bindings/                                 generated client bindings — never edit by hand
backend/db/repositories/client.ts                    connect() + waitFor()
backend/db/repositories/documents.ts                 document API (§8)
backend/db/repositories/data_plane.ts                DataPlane adapter for the control plane (§11)
backend/db/seed/seed.ts, seed/documents/*            synthetic seed data
backend/db/test/smoke.ts                             smoke test
backend/control_plane/                               request validation + DataPlane interface (separate package, see §11)
```

## 11. Adding agent features later without breaking this contract

- **Treat the three tables and four reducers above as a stable API.** Add new tables (cases, jobs, facts, proposals and so on) and new reducers alongside them. Don't rename, retype or remove these columns.
- **Link by ID, don't copy.** New tables should store `documents.id`, plus a page or row reference where useful, instead of duplicating bytes or metadata. `reference_id` is a plain string precisely so a future `cases` table can adopt it without a migration.
- **Agents read documents** through `listDocuments`, `readDocument` and `getDocumentText`. They write extracted text through `saveDocumentText`, using `PENDING`, `EXTRACTED` or `FAILED`.
- **Never mutate or delete document versions.** A corrected source is a new version created with `addDocumentVersion`. Anything derived from a document should record which `documents.id` (version) it used, so downstream logic can tell when its inputs changed.
- **Connecting the control plane.** `backend/control_plane/` (Matthew's commit) defines the `DataPlane.execute(operation, context, input)` port. This database layer implements it in `backend/db/repositories/data_plane.ts` (`createSpacetimeDataPlane(conn)`) **without modifying any control-plane file**. The database follows the control plane's contracts: same document types, same 10 MiB limit, and string IDs at the boundary (`"7"`, converted to `7n` inside the adapter).

  | DataPlane operation | Status | Implemented with |
  |---|---|---|
  | `imports.upload` | Done | `uploadDocument`; returns `{ uploadId, contentHash }` |
  | `evidence.readDocument` | Done | `readDocument`; a document whose `reference_id` is set must match `caseId` |
  | all other operations | `DATA_PLANE_UNAVAILABLE` (503) | need new tables and reducers in a later phase |

  The adapter also rejects any `context.companyId` other than `COMPANY_ID` (env, default `demo`). To add an operation, put a handler in the `handlers` map in `data_plane.ts` and add a smoke check. The control-plane files stay as they are.
- **Schema migrations:**
  - Adding a table, or appending a column with `.default(...)`, is safe with `npm run db:publish`.
  - Renaming or removing columns is breaking and requires `npm run db:reset`, which wipes the data.
  - After any change, run `npm run db:generate`, then `npm run typecheck`, then `npm run smoke`, and commit the regenerated `backend/db/bindings/`.
- **Authorization is open in this phase.** Any client can call these reducers. When agents arrive, add identity checks with `ctx.sender` in new reducers. Don't trust identities passed as arguments.
- **Large files:** bytes live in the row, which suits files up to the 10 MiB limit. If you need bigger files, add an external blob store and keep `files.sha256` as the integrity anchor.

## 12. Checklist for a coding agent picking this up

1. Read §0 and run the quick start. Stop and report if `npm run smoke` is not 13/13.
2. Read `backend/db/spacetime/CLAUDE.md` before changing the module. Two rules to keep in mind: reducers are deterministic and return nothing, and `ctx.sender` is the only trusted identity.
3. Don't modify the §7 columns or the §8 reducer signatures. Extend them instead.
4. After changing the module, run `db:publish` (or `db:reset`), then `db:generate`, `typecheck` and `smoke`.
5. Keep all demo data synthetic and labeled `(SYNTHETIC)`.
