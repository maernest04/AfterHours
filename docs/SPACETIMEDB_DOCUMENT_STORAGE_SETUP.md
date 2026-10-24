# SpacetimeDB document storage: setup and handoff

**Audience:** teammates and coding agents setting this up on another machine.
**Source of truth:** `Accrual_Correction_Brief` (revised: SpacetimeDB edition). This layer implements the brief's process boundaries for documents. Its pages are cited below as "brief p.N".
**Phase goal:** SpacetimeDB runs locally and can store, retrieve, version and list synthetic source documents and their metadata.

> **Not in this phase:** AI agents (Factory, Bitdeer), worker loops, job leasing, extraction, matching, investigation, accounting calculations, proposals, approvals, reviews, exports and CSV generation, the mock mailbox, and case workflows. This phase is **document storage only**. All data is synthetic, and no API keys are needed.

---

## 0. Quick start (copy-paste)

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

# terminal B (§5-§7)
npm run db:publish        # first run creates database "accrual-docs"; the CLI identity becomes owner
npm run db:generate       # regenerate TypeScript bindings
npm run typecheck
npm run db:bootstrap      # owner: configure company + register gateway/worker identities (safe to re-run)
npm run db:seed           # synthetic documents via the gateway identity (safe to re-run)
npm run smoke             # expect: 13/13 checks passed
```

**Done when:** `npm run smoke` ends with `13/13 checks passed`, and `npm run db:sql` lists document rows for `DEMO-ACME-2026-09`.

---

## 1. Architecture (brief p.2-3, documents only)

The current application direction is Python services in local Docker containers. The brief quotes below describe the original Node/Next.js design; the existing database module and storage tooling remain TypeScript. Python integration is not implemented yet.

```text
Browser ──► Python API (integration pending) ──► SpacetimeDB (private tables, reducers check caller)
                 │  server-held GATEWAY identity              ▲ public views filter by ctx.sender
                 └─► file store (persistent volume)           │
Python worker (planned; WORKER identity) ──── reads views ──────┘ + reads file store
```

| Brief requirement | Implementation |
|---|---|
| "Browser requests go through a Next.js server gateway; it uses a server-held SpacetimeDB identity" | The `GATEWAY` service identity. Its token is in `backend/.secrets/gateway.token` and never reaches the browser. |
| "Tables stay private; public views check `ctx.sender` against configured gateway/worker identities" | All 4 tables are private. `documents_view`, `settings_view` and `my_service_identity` return rows only to registered identities. |
| "A Node worker connects with a separate approved service identity" | The `WORKER` identity (`backend/.secrets/worker.token`). It can read the views but **can't write** documents. |
| "Reducers check the caller and atomically validate state changes" | `store_document*` accept only `GATEWAY`. `configure_settings` and `register_service_identity` accept only the owner. |
| "Original files … live on a persistent server volume … referenced by storageKey and hash" | Content-addressed file store at `FILE_STORE_DIR` (default `data/files/`). `storageKey = "sha256/<contentHash>"`, and every read is re-hashed. |
| "Every business record belongs to the fixed demo company; the backend rejects other company IDs" | `settings.companyId` (default `demo`). Company-scoped reducers reject any other company. |
| "Index companyId, caseId and job status for view lookups" | `documents.companyId` is indexed. `caseId` and job status come with later phases. |
| "Preserve source versions" | New versions are new rows linked by `supersedes_document_id`. Rows are never updated or deleted. |

## 2. Prerequisites (one-time per machine)

| Tool | Required version | Check |
|---|---|---|
| Git | any | `git --version` |
| Node.js | **22.x** (22.18+ recommended, see §10) | `node --version` |
| SpacetimeDB CLI | **2.13.x**, matching the `spacetimedb` npm package | `spacetime --version` |

| OS | Install the SpacetimeDB CLI |
|---|---|
| Windows (PowerShell) | `iwr https://windows.spacetimedb.com -useb \| iex` |
| macOS / Linux | `curl -sSf https://install.spacetimedb.com \| sh` |

- **Windows:** **open a new terminal** after installing. To refresh PATH in the current session instead, run:
  ```powershell
  $env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path
  ```
- **Pin the version** if `spacetime --version` isn't 2.13.x:
  ```powershell
  spacetime version install 2.13.0
  spacetime version use 2.13.0
  ```

Install dependencies once per clone:

```powershell
git clone <repo-url> AfterHours
cd AfterHours
npm install          # root: spacetimedb SDK, tsx, typescript
npm run db:install   # module dependencies used by `spacetime publish`
```

## 3. Start the local server

Run this in its own terminal and leave it running:

```powershell
spacetime start
```

The server listens on `http://localhost:3000`; check it with `spacetime server ping local`. Each machine has its own server, data, identities and file store.

## 4. Environment variables

All variables are optional. To override them, run `Copy-Item .env.example .env`; npm scripts load `.env` automatically. Everything here is **server-side only**.

| Variable | Default | Purpose |
|---|---|---|
| `SPACETIMEDB_URI` | `http://localhost:3000` | SpacetimeDB server |
| `SPACETIMEDB_DATABASE` | `accrual-docs` | Database name. Lowercase letters, digits and dashes; **no underscores** |
| `COMPANY_ID` | `demo` | Fixed demo company set by `db:bootstrap`. Must match the company configured for backend services |
| `FILE_STORE_DIR` | `<repo>/data/files` | Persistent volume for original files (git-ignored) |
| `SPACETIMEDB_SECRETS_DIR` | `<repo>/backend/.secrets` | Gateway and worker identity tokens (git-ignored) |
| `SPACETIME_BIN` | auto-detected | Path to the `spacetime` executable if it isn't on PATH |

## 5. Publish, generate and bootstrap

```powershell
npm run db:publish     # create or update the database, keeping its data
npm run db:generate    # writes backend/db/bindings/ (committed; regenerate after module changes)
npm run typecheck
npm run db:bootstrap   # as owner: configure_settings + register GATEWAY and WORKER identities
```

- **Owner:** the first publish logs the CLI in to the **local server only**. That identity becomes the module owner, recorded by `init`. `db:bootstrap` reads the owner token with `spacetime login show --token`.
- **Service identities:** on first run, `db:bootstrap` creates the gateway and worker identities and saves their tokens in `backend/.secrets/`. Re-running it is a no-op.
- **`npm run db:reset`** republishes with `--delete-data=always`, which wipes all rows and the owner/identity registrations. **Re-run `db:bootstrap` afterwards.** The file store isn't wiped. Content-addressed files are harmless to keep; delete `data/files/` if you want it clean.

## 6. Seed and smoke test

```powershell
npm run db:seed    # 6 synthetic Acme documents + v2 of the timesheet under reference DEMO-ACME-2026-09
npm run smoke      # 13 checks; exit code 1 on any failure
npm run db:sql                                                       # id, type, version, reference_id (owner query)
npm run db:sql -- "SELECT id, type, storage_key, byte_length FROM documents"
```

Expected seed output on a fresh database:

```text
[seed] CONTRACT  doc 1 v1  acme_msa.txt
[seed] AMENDMENT doc 2 v1  acme_amendment_1.txt
[seed] TIMESHEET doc 3 v1  acme_timesheet_2026-09_v1.csv
[seed] INVOICE   doc 4 v1  acme_invoices_2026-08.csv
[seed] LEDGER    doc 5 v1  ledger_2026-09.csv
[seed] ACCRUAL   doc 6 v1  acme_accrual_2026-09.json
[seed] TIMESHEET doc 7 v2  supersedes doc 3
```

The smoke test uses a fresh `SMOKE-xxxxxxxx` reference each run, so it can run repeatedly. It proves:
- **Storage and integrity:**
  - gateway upload puts the bytes on the file store and the metadata in SpacetimeDB
  - bytes read back are identical and verified against their hash
  - a tampered file is detected on read
- **Reducer validation:** a mismatched storage key, an invalid type or media type, and another company are all rejected.
- **Access rules:**
  - only the gateway can write; the worker and unregistered clients are rejected, and only the owner can configure
  - the gateway and worker can see documents through the views; an unregistered client sees nothing
- **Versioning:**
  - an idempotent retry creates no duplicate
  - v2 is stored without changing v1
  - versioning a superseded document or uploading identical content is rejected
  - list filters work
- **Repository access:**
  - ledger upload and read return identical bytes and expected metadata
  - the gateway can read the configured company settings
  - a 10 MiB upload is accepted at the repository limit

## 7. Schema (the document-storage contract)

All tables are **private**. Clients read through views (§8). Only the owner can query tables directly, with `npm run db:sql`.

### `documents` (brief p.3: `companyId, storageKey, type, version, contentHash`)
| Column | Type | Notes |
|---|---|---|
| `id` | u64, primary key, auto-increment | |
| `company_id` | string, btree index | Always `settings.company_id` |
| `storage_key` | string | `sha256/<content_hash>`, a file-store reference |
| `type` | string, btree index | `ACCRUAL`, `CONTRACT`, `AMENDMENT`, `TIMESHEET`, `INVOICE`, `LEDGER` or `OTHER` |
| `version` | u32 | 1, 2, 3 and so on |
| `content_hash` | string, btree index | Lowercase SHA-256 hex |
| `byte_length` | u32 | Up to 10 MiB (repository upload limit) |
| `media_type` | string | `text/csv`, `application/json`, `text/plain` or `application/pdf` |
| `original_filename` | string | |
| `reference_id` | option\<string\> | Optional case or reference link |
| `source_label` | string | e.g. `gateway:<serviceIdentity>` or `seed (SYNTHETIC)` |
| `supersedes_document_id` | option\<u64\> | The previous version. Empty for v1 |
| `upload_key` | string, unique | Idempotency key, so a retry never duplicates |
| `created_at` | timestamp | |

### `settings` (brief p.3: "fixed demo companyId; currency, expenseAccount, liabilityAccount, policyVersion. No memberships table")
`id` (always 0), `company_id`, `currency` (`USD`), `expense_account {code, name}`, `liability_account {code, name}`, `policy_version`.

### `service_identity`
`identity` (primary key), `role` (`GATEWAY` or `WORKER`), `label`, `created_at`. These are the brief's "configured gateway/worker identities".

### `module_owner`
`id` (always 0), `identity`. Recorded by `init` from the publishing identity.

## 8. Reducers, views and the Node API

Reducers are transactional and **return no data**. A call resolves on success and rejects with an error message on failure. Read results through the views.

| Reducer (TS accessor) | Caller | Behavior |
|---|---|---|
| `configure_settings` (`configureSettings`) | owner | Creates or updates the company settings. USD only, and the company can't change once set. |
| `register_service_identity` (`registerServiceIdentity`) | owner | Registers an identity as `GATEWAY` or `WORKER`. Idempotent. |
| `store_document` (`storeDocument`) | gateway | Records v1 of a document whose bytes are already on the file store. Validates the company, type, media type, size, hash format and storage key. Same `uploadKey` with the same content: no-op. With different content: error. |
| `store_document_version` (`storeDocumentVersion`) | gateway | Records v N+1, which inherits `type` and `referenceId` and sets `supersedesDocumentId`. Rejects the call if the previous document isn't the latest version or the content is identical. |

| View | Returns |
|---|---|
| `documents_view` | All documents for the company, to registered gateway and worker identities only |
| `settings_view` | The settings row, to registered identities only |
| `my_service_identity` | The caller's own role (empty if unregistered), so services can check themselves at startup |

**The existing Node storage API (`backend/db/repositories/`)** supports the seed and smoke tools. Python service integration is pending:

```ts
import { connectService } from './backend/db/repositories/client';
import * as docs from './backend/db/repositories/documents';

const { conn } = await connectService('gateway');         // or 'worker' (read-only); fails fast if not bootstrapped
const doc = await docs.uploadDocument(conn, { companyId, bytes, originalFilename, mediaType, type: 'INVOICE', referenceId, sourceLabel });
const v2  = await docs.addDocumentVersion(conn, doc.id, { companyId, bytes: newBytes, originalFilename, mediaType, sourceLabel });
docs.getDocument(conn, id);  docs.readDocument(conn, id);   // readDocument returns hash-verified bytes from the file store
docs.listDocuments(conn, { type: 'TIMESHEET', referenceId, latestOnly: true });
docs.getVersionHistory(conn, anyVersionId);  docs.findByContentHash(conn, hash);  docs.verifyDocument(conn, id);
```

The former control-plane package and its adapter have been removed. The four Python API stubs (`create-review`, `list-review`, `get-review`, `export-review`) still need integration with storage and workflow functions. See [API contracts](../backend/api/README.md).

## 9. Repository layout (database parts)

```text
.env.example                                         environment template (§4)
package.json                                         npm scripts (db:*, smoke, typecheck)
scripts/db.mjs                                       publish / reset / generate / sql wrapper (env-driven)
backend/db/spacetime/spacetimedb/src/schema.ts       private tables (§7)
backend/db/spacetime/spacetimedb/src/index.ts        reducers + views (§8)
backend/db/spacetime/CLAUDE.md                       SpacetimeDB TypeScript API reference for coding agents
backend/db/bindings/                                 generated client bindings (views + reducers) — never edit by hand
backend/db/repositories/client.ts                    connect / connectService / ownerToken / waitFor
backend/db/repositories/file_store.ts                content-addressed file store (putFile / getFile)
backend/db/repositories/documents.ts                 document API (§8)
backend/db/seed/bootstrap.ts                         owner setup: settings + service identities
backend/db/seed/seed.ts, seed/documents/*            synthetic seed data
backend/db/test/smoke.ts                             smoke test
data/files/                                          local file store (git-ignored)
backend/.secrets/                                    gateway/worker tokens (git-ignored)
```

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `spacetime` is not recognized | PATH wasn't refreshed. Open a new terminal (§2), or set `SPACETIME_BIN`. |
| `ECONNREFUSED 127.0.0.1:3000`, or the seed hangs on "Connecting…" | `spacetime start` isn't running, or `SPACETIMEDB_URI`/`SPACETIMEDB_DATABASE` is wrong. |
| `… is not registered as GATEWAY; run npm run db:bootstrap` | Bootstrap hasn't run since the last publish or reset. Run `npm run db:bootstrap`. |
| `Only the module owner may do this` during bootstrap | The CLI identity isn't the one that published, for example after `spacetime logout`. Use a new database name, or run `spacetime delete accrual-docs --server local` and publish again. |
| `Settings are not configured` | Run `npm run db:bootstrap`. |
| `File … is missing from the file store` | The metadata exists but `FILE_STORE_DIR` points somewhere else, or the files were deleted. The gateway and worker must share the same volume. |
| Publish fails with a breaking-change error | `npm run db:reset`, then `db:bootstrap` and `db:seed`. |
| TypeScript errors about missing reducers or views | Stale bindings. Run `npm run db:generate`. |
| `npm` is blocked by the PowerShell execution policy | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or run `npm.cmd`. |
| Inspect server-side errors | `spacetime logs accrual-docs --server local -n 50`. `ERROR` lines after a smoke run are expected: they come from its deliberate rejection checks. |

## 11. Adding later phases without breaking this contract

- **Follow the brief's backend contract (p.4) for new reducers.** Examples: `finalize_import`, `start_review`, `claim_job`, `heartbeat_job`, `complete_job`, `ask_question`, `resolve_exception`, `build_proposal`, `decide_review`, `authorize_export` and `finalize_export`. Each one starts with a caller check (`GATEWAY` or `WORKER`) and a company check, like `store_document` does.
- **Keep new tables private** and expose them through views filtered by `ctx.sender`, like `documents_view`. Index `companyId`, `caseId` and job status, as the brief requires.
- **Don't change the §7 `documents` columns or the §8 reducer signatures.** Extend them instead. Facts, cases and so on should reference `documents.id`. The brief's "documents / facts" record puts `documentId, pageOrRow, excerpt, field, value, validationStatus` in a new `facts` table.
- **Files:** export CSVs go to the same file store with `putFile` (brief p.2/p.4: "storageKey and hash"). Never store bytes in SpacetimeDB.
- **The worker** connects with `connectService('worker')`. It reads `documents_view` plus the file store and is never allowed to call the document-writing or approval reducers.
- **Python backend integration:** connect the existing API stubs to backend workflow functions and storage while preserving service identities, caller checks and company checks. Add integration checks when those functions are implemented.
- **After a module change,** run `db:publish` (or `db:reset` followed by `db:bootstrap`), then `db:generate`, `typecheck` and `smoke`, and commit the regenerated bindings.

## 12. Checklist for a coding agent picking this up

1. Run §0. Stop and report if `npm run smoke` isn't 13/13.
2. Read the brief and `backend/db/spacetime/CLAUDE.md` before changing the module. Reducers are deterministic, return nothing, and must check `ctx.sender`.
3. Keep tables private, read through views, and keep file bytes on the file store.
4. Don't modify the §7 columns or the §8 reducer signatures; extend them for new phases.
5. Keep all demo data synthetic and labeled `(SYNTHETIC)`.
