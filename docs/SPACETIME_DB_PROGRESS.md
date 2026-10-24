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

The smoke test passes 24/24 against `http://localhost:3000`, database `accrual-docs`. Matthew's control-plane handlers work end to end through our adapter, and his code is unchanged. Setup and handoff details are in [SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md](SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md).

## How we got here
1. **Database choice.** The original brief named Convex. The team chose **SpacetimeDB** as the single datastore, and the brief was later revised to match. We rejected splitting the work between Convex for files and SpacetimeDB for data.
2. **First plan, abandoned.** It ported the whole backend at once: agents, leases, calculator, approvals and export. That code was deleted unrun when the scope narrowed to document storage.
3. **Document storage v1.** File bytes lived in a SpacetimeDB `files` table, all tables were public, and any client could write. It worked (10/10 checks).
4. **Alignment with the control plane** (Matthew's commit 1d87f4d), **without changing his files**:
   - we adopted his document types (`LEDGER`, `ACCRUAL`) and his 10 MiB limit
   - we added `backend/db/repositories/data_plane.ts`, which implements his `DataPlane` port
5. **Realignment with the revised brief** (current state). The brief now specifies the process boundaries, and we followed them exactly:

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

   Matthew's `StoredFile { storageKey, contentHash, byteLength, mediaType }` and `CompanySettings` already matched the revised brief, so his code needed no change. We also implemented `settings.get`.

6. **Plug-in points for the agents** (current phase), built from the brief's p.3-4 and Matthew's `contracts.ts`/`data_plane.ts`:
   - **Cases and import:**
     - `finalize_import` links uploads to a case and parses the timesheet, invoice and ledger CSVs and the accrual JSON **with code** into facts (with row references) plus `work_items`, `invoice_lines` and `ledger_records`
     - it flags duplicate documents and duplicate work; missing required inputs set `WAITING_FOR_INPUT`
     - `start_review` queues the first job
   - **Mock mailbox:** `emails` and `attachments`, plus the `store_email` reducer.
   - **Job queue:**
     - `jobs` (key = case:revision:role), with `claim_job`, `heartbeat_job` and `complete_job`
     - leases issued atomically by the server, a scheduled `sweep_expired_leases`, and bounded retries leading to `RETRYABLE_ERROR`
     - `complete_job` accepts Matthew's `AgentOutput`, checks evidence scope, stores facts and matches as `PROPOSED`, and advances EXTRACTION → MATCHING → INVESTIGATION (when there are unresolved questions)
   - **Read-only agent tools** in `backend/agents/tools`: `searchEmails`, `readEmailThread`, `readAttachment` and `getCaseEvidence`, plus LLM tool specs.
   - **Adapter:** now also implements `imports.finalize`, `cases.list`/`get`/`startReview`/`listJobs`/`subscribe`, `worker.claim`/`heartbeat`/`complete` and `evidence.list`.
   - **Seed:** the brief's Acme demo. The amendment exists only in the mailbox, and case 1 is left with an EXTRACTION job queued.

   Decisions where the brief and contracts were silent:
   - structured files are parsed by the gateway at import, while agents handle contracts, amendments and PDFs
   - `contractId` is the `documents.id` of the contract or amendment
   - after the last agent stage, the case waits at the `build_proposal` hand-off
   - evidence IDs are `doc:N`, `fact:N` and `email:N`
   - money is integer-cent strings

## Current state
| Area | Result |
|---|---|
| Module | 17 private tables, 13 client reducers + 1 scheduled sweep, 14 views |
| File store | `backend/db/repositories/file_store.ts`: atomic, content-addressed writes; every read is re-hashed and size-checked |
| Node API | `documents.ts`, `parsers.ts`, `cases.ts`, `mailbox.ts`, `jobs.ts`, `client.ts`, `data_plane.ts` (14 control-plane operations); `backend/agents/tools` |
| Scripts | `db:start`, `db:install`, `db:publish`, `db:reset`, `db:generate`, `db:sql`, **`db:bootstrap`**, `db:seed`, `smoke` and `typecheck`, all driven by environment variables |
| Seed | Acme demo: contract, timesheet v1→v2 (70h), invoices, ledger and accrual; 4 mailbox emails (amendment attachment, a distractor, a prompt injection, another vendor); case 1 imported with an EXTRACTION job queued. Idempotent |
| Smoke | 24/24: document storage and access (12), import and blockers (3), case operations + live updates, worker-only claims, the EXTRACTION → MATCHING → INVESTIGATION pipeline with scope and lease rejections, agent tools, evidence paging and scope, lease expiry/sweep/retry exhaustion, unbuilt operations |
| Matthew's tests | 6/6 pass (they need Node 22.18+, or `--experimental-strip-types`) |

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
- **Agent teammates:** start from `backend/agents/README.md`. The seeded EXTRACTION job is ready to claim.
- **Leftover database:** an earlier experimental database `accrual` still exists on the original dev machine. Remove it with `spacetime delete accrual --server local`.
