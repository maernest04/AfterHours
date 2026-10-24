# SpacetimeDB progress

Status as of 2026-10-24. Nothing has been committed yet.

## Summary
SpacetimeDB is now the datastore for the project, and **document storage works locally**. The smoke test passes 13/13 against `http://localhost:3000`, database `accrual-docs`. Setup and handoff details are in [SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md](SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md).

## How we got here
1. **Database choice.** The brief (`Accrual_Correction_Brief.pdf`) names Convex. The team chose **SpacetimeDB** as the single datastore. We considered and rejected splitting the work, with Convex holding files and SpacetimeDB holding data, because it adds two of every SDK and deploy target, and uploads can't be atomic across two databases.
2. **First plan, abandoned.** This plan ported the brief's whole backend to SpacetimeDB: agents, job leases, calculator, proposals, approvals and CSV export. Part of that code was written, but none of it was run.
3. **Scope correction.** The current phase covers only the document-storage foundation, and **all out-of-scope code was deleted**: agent tools, role stubs, the worker loop, accounting rules, workflow reducers and their 17 tables. That keeps the handoff clean for teammates who will build the agents.

## What was built (this phase)
| Area | Result |
|---|---|
| Tooling | SpacetimeDB CLI 2.13.0 installed on Windows, local server running, CLI logged in to the local server only |
| Module | `files`, `documents` and `document_text` tables, plus the `store_document`, `store_document_version`, `verify_stored_file` and `store_document_text` reducers |
| Integrity | The server computes SHA-256 in pure TS. Uploads can pass `expectedSha256`, and a mismatch rejects the upload. A verify reducer recomputes the size and hash |
| Versioning | Each new row points at its predecessor through `supersedes_document_id`. Old rows are never mutated. Only the latest version can be superseded, and identical content is rejected |
| Idempotency | A caller-chosen `upload_key` (unique) means a retried upload never duplicates |
| Node API | `backend/db/repositories/documents.ts` provides upload, version, get, read, list (by type, reference or latest only), history, verify and text |
| Seed | 6 synthetic Acme documents (contract, amendment, timesheet, invoices, ledger, accrual) plus a v2 of the timesheet, under reference `DEMO-ACME-2026-09`. Running it again creates no duplicates |
| Smoke test | 13/13 checks pass: upload, fetch with identical bytes, client and server verification, a bad hash rejected, invalid type and MIME type rejected, idempotent retry, v2 without mutating v1, invalid versioning rejected, list filters, extracted text, and three control-plane integration checks |
| Scripts | `db:start`, `db:install`, `db:publish`, `db:reset`, `db:generate`, `db:sql`, `db:seed`, `smoke` and `typecheck`. The database name and URI come from environment variables |

## Alignment with the control plane (Matthew's commit 1d87f4d)
That commit added `backend/control_plane/`: request validation plus a `DataPlane` port. We aligned the database to it **without changing any of his files**:
- **Document types:** now exactly his `DocumentType` list. `LEDGER_EXPORT` became `LEDGER`, and `ACCRUAL` was added.
- **Upload limit:** raised from 2 MB to his 10 MiB.
- **Adapter:** `backend/db/repositories/data_plane.ts` implements `imports.upload` and `evidence.readDocument`, using string IDs at the boundary. The smoke test calls his real API handlers through it.
- **Root config:** the root `tsconfig.json` now allows `.ts` import extensions, so it type-checks his folder as written.
- **Still to agree on (later phases):** his `worker.claim` takes a `jobId` and his job statuses have no leased state, whereas the brief has the server issue leases.

## Learned about SpacetimeDB 2.13 (TypeScript modules)
- Reducers are transactional and deterministic, and **they return no data**. Clients read through subscriptions or `spacetime sql`, so the repository helpers wait for the replicated row identified by `upload_key`.
- The module runtime has `TextEncoder` but not `node:crypto`, hence the pure-TS SHA-256.
- `t.byteArray()` stores raw bytes in the row. That suits demo-sized files, which we cap at 10 MiB, the control plane's limit. A 10 MiB upload takes about 1 second locally.
- In the generated client bindings, the unique-index accessor on `upload_key` has no `.find()`, so the client looks the row up by scanning instead.
- Database names can't contain underscores.
- Procedures are still marked unstable, so this phase doesn't use them.

## Open items for the team
- `.env.example` in the repo root was written by a teammate. It still describes **Convex as authoritative** and sets `NEXT_PUBLIC_SPACETIMEDB_DATABASE=accrual_realtime`, which is an invalid name because of the underscore. Update it to match the new direction (`SPACETIMEDB_URI`, `SPACETIMEDB_DATABASE=accrual-docs`).
- An earlier experimental database named `accrual` still exists on the local server. It's harmless; remove it with `spacetime delete accrual --server local`.
- Next phases: agents, cases and the accounting workflow. Build them as new tables and reducers that reference `documents.id`, following section 10 of the setup doc.
