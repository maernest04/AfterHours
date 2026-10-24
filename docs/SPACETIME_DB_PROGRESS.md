# SpacetimeDB progress

Status as of 2026-10-24.

## Summary
SpacetimeDB is the project's sole authoritative state store. The upstream document-storage implementation reported 14/14 local smoke checks against `http://localhost:3000`, database `accrual-docs`. The application now uses Python API stubs, and the separate control-plane package and its adapter have been removed. The storage suite now has 13 direct repository checks; it has been typechecked but has not been rerun against a live database during this integration. Setup details are in [SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md](SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md).

## How we got here
1. **Database choice.** The original brief named Convex. The team chose **SpacetimeDB** as the single datastore, and the brief was later revised to match. We rejected splitting the work between Convex for files and SpacetimeDB for data.
2. **First plan, abandoned.** It ported the whole backend at once: agents, leases, calculator, approvals and export. That code was deleted unrun when the scope narrowed to document storage.
3. **Document storage v1.** File bytes lived in a SpacetimeDB `files` table, all tables were public, and any client could write. It worked (10/10 checks).
4. **Alignment with the control plane** (Matthew's commit 1d87f4d), **without changing his files**:
   - we adopted his document types (`LEDGER`, `ACCRUAL`) and his 10 MiB limit
   - we added `backend/db/repositories/data_plane.ts`, which implements his `DataPlane` port
5. **Realignment with the revised brief** (database implementation). The brief now specifies the process boundaries, and we followed them exactly:

   | Brief (p.2-3) | Now |
   |---|---|
   | Files on a persistent server volume, referenced by storageKey + hash | Content-addressed file store (`data/files/`, `storageKey = sha256/<hash>`). **No bytes in SpacetimeDB.** The `files` table, the in-module SHA-256 and the `verify_stored_file` reducer were removed. |
   | Tables stay private; public views check `ctx.sender` against configured gateway/worker identities | All tables private. `documents_view`, `settings_view` and `my_service_identity` filter by caller |
   | Browser → Next.js gateway using a server-held identity; worker has a separate identity | `GATEWAY` and `WORKER` service identities, registered by the owner (`npm run db:bootstrap`); tokens in `backend/.secrets/` |
   | Reducers check the caller | Document writes are gateway-only; settings and identity registration are owner-only |
   | documents: `companyId, storageKey, type, version, contentHash` | Exactly those, plus versioning, idempotency and file metadata |
   | settings: fixed companyId, currency, accounts, policyVersion; no memberships | `settings` table + `configure_settings` reducer |
   | Bind all operations to the fixed demo company | Reducers and the adapter reject any other `companyId` |
   | (not in brief) `document_text` | Removed |

   At that stage, Matthew's `StoredFile { storageKey, contentHash, byteLength, mediaType }` and `CompanySettings` already matched the revised brief, so his code needed no change. We also implemented `settings.get`.

6. **Python MVP API.** Removed the separate control plane and its storage adapter. Four Python routes now validate inputs and return explicit 501 errors until their backend functions are implemented. API success contracts are documented separately. The API runs in Docker with dependencies installed using uv; other service containers and Python database integration remain pending.

## Current state
| Area | Result |
|---|---|
| Module | 4 private tables (`documents`, `settings`, `service_identity`, `module_owner`), 4 reducers, 3 views |
| File store | `backend/db/repositories/file_store.ts`: atomic, content-addressed writes; every read is re-hashed and size-checked |
| Node API | `documents.ts` (upload, version, get, read, list, history, duplicate lookup, verify), `client.ts` (`connectService('gateway' \| 'worker')`) |
| Scripts | `db:start`, `db:install`, `db:publish`, `db:reset`, `db:generate`, `db:sql`, **`db:bootstrap`**, `db:seed`, `smoke` and `typecheck`, all driven by environment variables |
| Seed | 6 synthetic Acme documents (contract, amendment, timesheet, invoices, ledger, accrual) plus timesheet v2, uploaded via the gateway. Idempotent |
| Smoke | 13 direct repository checks covering storage, integrity, access rules, versioning, settings and the 10 MiB limit. Typechecked; live database execution pending after control-plane removal. |
| Python API tests | 7 checks cover all four stub routes, validation, upload limits and documented success/error responses; run in process and over HTTP against Docker. |

## Learned about SpacetimeDB 2.13 (TypeScript)
- Reducers are transactional and deterministic, and **they return no data**. The gateway reads results through its view subscription, so the repository waits for the row identified by `upload_key`.
- Private tables don't appear in the generated client bindings. Only views and reducers do. The owner can still query private tables with `spacetime sql`.
- Views get `ctx.sender` plus read-only `ctx.db`, which is how the brief's "views check `ctx.sender` against configured identities" works.
- `init` runs as the publishing identity, so it's the place to record the owner. `spacetime login show --token` gives scripts that owner's token.
- Database names can't contain underscores. Procedures are still marked unstable, so we don't use them.

## Open items for the team
- **Next phases:** follow the brief's backend contract on p.4. That covers `finalize_import`, `start_review`, `claim_job`, `heartbeat_job`, `complete_job`, `ask_question`, `resolve_exception`, `build_proposal`, `decide_review`, `authorize_export`, `finalize_export`, and the scheduled sweep reducer. Every reducer checks its caller, and every table stays private behind views.
- **The worker lease flow:** implement subscribed Python workers competing through atomic `claim_job`, with heartbeat and completion reducers. This workflow is still pending.
- **Leftover database:** an earlier experimental database `accrual` still exists on the original dev machine. Remove it with `spacetime delete accrual --server local`.
