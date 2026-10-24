# SpacetimeDB progress

Status as of 2026-10-24.

## Summary
SpacetimeDB is the project's sole authoritative state store. **The data layer the agents plug into works locally**, following the revised implementation brief (SpacetimeDB edition):
- documents
- cases and import
- evidence tables
- the mock mailbox
- the job queue with leases and a sweep
- the read-only agent tools

The smoke test passes 23/23 against `http://localhost:3000`, database `accrual-docs`. Matthew's Python API (`backend/api`) is in place as stubs and is not yet connected to the database; Python can reach it over HTTP (verified, see the setup guide §10). Setup and handoff details are in [SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md](SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md).

## How we got here
1. **Database choice.** The original brief named Convex. The team chose **SpacetimeDB** as the single datastore, and the brief was later revised to match. We rejected splitting the work between Convex for files and SpacetimeDB for data.
2. **First plan, abandoned.** It ported the whole backend at once: agents, leases, calculator, approvals and export. That code was deleted unrun when the scope narrowed to document storage.
3. **Document storage v1.** File bytes lived in a SpacetimeDB `files` table, all tables were public, and any client could write. It worked (10/10 checks).
4. **Alignment with the earlier TypeScript control plane** (Matthew's commit 1d87f4d, since replaced by the Python API), **without changing his files**:
   - we adopted his document types (`LEDGER`, `ACCRUAL`) and his 10 MiB limit
   - we added an adapter implementing his `DataPlane` port (removed along with the control plane in step 6)
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

7. **Plug-in points for the agents**, built from the brief's p.3-4 and the former control-plane contracts (kept as `backend/db/repositories/contracts.ts`):
   - **Cases and import:**
     - `finalize_import` links uploads to a case and parses the timesheet, invoice and ledger CSVs and the accrual JSON **with code** into facts (with row references) plus `work_items`, `invoice_lines` and `ledger_records`
     - duplicate work and missing required inputs become case blockers (`WAITING_FOR_INPUT`); a document that duplicates another in the same import is rejected with an error
     - `start_review` queues the first job
   - **Mock mailbox:** `emails` and `attachments`, plus the `store_email` reducer.
   - **Job queue:**
     - `jobs` (key = case:revision:role), with `claim_job`, `heartbeat_job` and `complete_job`
     - leases issued atomically by the server, a scheduled `sweep_expired_leases`, and bounded retries leading to `RETRYABLE_ERROR`
     - `complete_job` accepts the `AgentOutput` shape, checks evidence scope, stores facts and matches as `PROPOSED`, and advances EXTRACTION → MATCHING → INVESTIGATION (when there are unresolved questions)
   - **Read-only agent tools** in `backend/agents/tools`: `searchEmails`, `readEmailThread`, `readAttachment` and `getCaseEvidence`, plus LLM tool specs.
   - **Seed:** the brief's Acme demo. The amendment exists only in the mailbox, and case 1 is left with an EXTRACTION job queued.

   Decisions where the brief and contracts were silent:
   - structured files are parsed by the gateway at import, while agents handle contracts, amendments and PDFs
   - `contractId` is the `documents.id` of the contract or amendment
   - after the last agent stage, the case waits at the `build_proposal` hand-off
   - evidence IDs are `doc:N`, `fact:N` and `email:N`
   - money is integer-cent strings

8. **Merge with the Python API.** Matthew removed the TypeScript control plane and our adapter, so we:
   - moved the job, lease and agent-output payload types into `backend/db/repositories/contracts.ts` (same shapes)
   - dropped the adapter and pointed the smoke test at the repositories directly
   - left every file under `backend/api/` and `compose.yaml` untouched
   - **verified that Python needs no client library:** over plain HTTP, a worker claimed a job and completed it with nested results, the pipeline advanced, optional arguments encoded, and rejections returned their messages (setup guide §10)

## Current state
| Area | Result |
|---|---|
| Module | 17 private tables, 13 client reducers + 1 scheduled sweep, 14 views |
| File store | `backend/db/repositories/file_store.ts`: atomic, content-addressed writes; every read is re-hashed and size-checked |
| Node API | `documents.ts`, `parsers.ts`, `cases.ts`, `mailbox.ts`, `jobs.ts`, `client.ts`, `contracts.ts`; `backend/agents/tools` |
| Scripts | `db:start`, `db:install`, `db:publish`, `db:reset`, `db:generate`, `db:sql`, **`db:bootstrap`**, `db:seed`, `smoke` and `typecheck`, all driven by environment variables |
| Seed | Acme demo: contract, timesheet v1→v2 (70h), invoices, ledger and accrual; 4 mailbox emails (amendment attachment, a distractor, a prompt injection, another vendor); case 1 imported with an EXTRACTION job queued. Idempotent |
| Smoke | 23/23 direct repository checks: document storage and access, import and blockers, case operations with live view updates, worker-only claims, the EXTRACTION → MATCHING → INVESTIGATION pipeline with scope and lease rejections, agent tools, and lease expiry, sweep and retry exhaustion |
| Python API tests | 7 checks (Matthew): the four stub routes, validation, upload limits and documented responses; run in process and over HTTP against Docker. See `backend/api/README.md` |

## Learned about SpacetimeDB 2.13 (TypeScript)
- Reducers are transactional and deterministic, and **they return no data**. The gateway reads results through its view subscription, so the repository waits for the row identified by `upload_key`.
- Private tables don't appear in the generated client bindings. Only views and reducers do. The owner can still query private tables with `spacetime sql`.
- Views get `ctx.sender` plus read-only `ctx.db`, which is how the brief's "views check `ctx.sender` against configured identities" works.
- `init` runs as the publishing identity, so it's the place to record the owner. `spacetime login show --token` gives scripts that owner's token.
- Database names can't contain underscores. Procedures are still marked unstable, so we don't use them.

## Open items for the team
- **Next phases:** follow the brief's backend contract on p.4:
  - `build_proposal`: the calculator, reading the current revision's facts, evidence rows and allocations
  - `ask_question` / `resolve_exception`
  - `decide_review`: gateway-only
  - `authorize_export` / `finalize_export`, with the CSV going on the file store
  - revision bumps when a case's inputs change
- **Agent teammates:** start from `backend/agents/README.md`. The seeded EXTRACTION job is ready to claim. The tools and worker helpers there are TypeScript; Python agents use the HTTP calls in setup guide §10, or the tools can be ported.
- **Python API (Matthew):** connect the four routes over HTTP. `create-review` also needs the import logic in Python: write the file store layout, parse the CSV/JSON files, and assemble the `finalize_import` arguments (still TypeScript in `parsers.ts` and `cases.ts`).
- **Approval channel:** the brief says reviewer screen; the Python API README says email. The database only requires that approval comes from the gateway identity. The team should decide and document it.
- **Leftover database:** an earlier experimental database `accrual` still exists on the original dev machine. Remove it with `spacetime delete accrual --server local`.
