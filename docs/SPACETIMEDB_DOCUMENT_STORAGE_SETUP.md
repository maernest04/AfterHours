# SpacetimeDB setup and handoff

**Audience:** teammates and coding agents setting this up on another machine, or building on it.
**Source of truth:** `Accrual_Correction_Brief` (revised: SpacetimeDB edition), cited as "brief p.N", plus the Python review API in `backend/api/` (Matthew's code; its routes are stubs until they are connected to this database).
**What exists:** the data layer the agents plug into:
- document storage
- cases and import
- evidence tables
- the mock mailbox
- the job queue with leases
- the read-only agent tools

**Building agents?** Read [`backend/agents/README.md`](../backend/agents/README.md) after §0. **Writing Python (the API or agents)?** Read §10.

> **Not built yet (later phases):** agent implementations and prompts, the worker loop, model providers, the calculator, `build_proposal`, questions, exceptions, reviews and approvals, exports and CSV, and the reviewer UI. The Python API routes for them return 501 until connected. All data is synthetic, and no API keys are needed.

---

## 0. Quick start (copy-paste)

```powershell
# one-time per machine (§2)
iwr https://windows.spacetimedb.com -useb | iex      # macOS/Linux: curl -sSf https://install.spacetimedb.com | sh
# open a NEW terminal, then:
spacetime --version                                    # expect 2.13.x
node --version                                         # expect v22.x

# one-time per clone (§2)
npm install
npm run db:install

# terminal A: leave running (§3)
spacetime start

# terminal B (§5-§6)
npm run db:publish        # first run creates database "accrual-docs"; the CLI identity becomes owner
npm run db:generate       # regenerate TypeScript bindings
npm run typecheck
npm run db:bootstrap      # owner: company, job policy + sweep, gateway/worker identities (safe to re-run)
npm run db:seed           # demo Acme case + mock mailbox; leaves an EXTRACTION job QUEUED (safe to re-run)
npm run smoke             # expect: 23/23 checks passed
```

**Done when:**
- `npm run smoke` ends with `23/23 checks passed`.
- The seed's last line reads `case 1 ACR-2026-09-ACME POSTED $7000 state EXTRACTING jobs [EXTRACTION:QUEUED]`.

**After pulling schema changes:** run `npm run db:reset`, `npm run db:generate`, `npm run db:bootstrap`, then `npm run db:seed`.

---

## 1. Architecture (brief p.2-4)

The application direction is **Python services in local Docker containers**. The brief quotes below describe the original Node/Next.js design; the database module and the storage tooling in `backend/db` remain TypeScript. Python reaches the database over HTTP (§10).

```text
Browser ──► Python API (backend/api) ──────────────► SpacetimeDB (private tables, reducers check caller)
                 │  server-held GATEWAY identity              ▲   public views filter by ctx.sender
                 └─► file store (persistent volume)           │   scheduled sweep requeues expired leases
Python worker(s) (WORKER identity) ─ claim_job / complete_job ┘   + read views + file store
   └─ Bitdeer / Factory model calls happen here, never in reducers
```

| Brief requirement | Implementation |
|---|---|
| Browser → server gateway using a server-held identity (the Python API); worker has a separate identity | `GATEWAY` and `WORKER` service identities, registered by the owner (`db:bootstrap`). Tokens live in `backend/.secrets/` |
| Tables stay private; public views check `ctx.sender` | All 17 tables are private. 14 `*_view`s return rows only to registered identities |
| Reducers check the caller and validate atomically | Each reducer starts with an owner, gateway, worker or scheduler check, then a company check |
| Files on a persistent server volume, referenced by storageKey + hash | Content-addressed store (`data/files/`, `storageKey = sha256/<hash>`). Every read is re-hashed |
| Import: save originals, extract facts with page/row references, check for duplicates | Gateway uploads, then `finalize_import`. Structured files are parsed **with code** into facts plus typed rows. Duplicate work and missing inputs become case blockers; a duplicate document is rejected |
| Jobs: stable key (case + revision + role), bounded retries, expiring leases, scheduled sweep, atomic `claim_job` | `jobs.job_key`, `job_policy` (30s, 3 attempts), and a `sweep_expired_leases` run every 2s |
| Agent tools are read-only and scoped to the job | `backend/agents/tools`: `searchEmails`, `readEmailThread`, `readAttachment` and `getCaseEvidence`. Scope is enforced in code and again in `complete_job` |
| Agents cannot approve, export, modify policy or write accounting entries | The worker identity can only call `claim_job`, `heartbeat_job` and `complete_job`. Its facts and matches are stored as `PROPOSED` |
| Every record belongs to the fixed demo company | `settings.company_id` (default `demo`). Every company-scoped reducer rejects any other company |

## 2. Prerequisites (one-time per machine)

| Tool | Version | Check |
|---|---|---|
| Git | any | `git --version` |
| Node.js | **22.x** | `node --version` |
| SpacetimeDB CLI | **2.13.x**, matching the `spacetimedb` npm package | `spacetime --version` |

- **Install the CLI:**
  - Windows: `iwr https://windows.spacetimedb.com -useb | iex`
  - macOS/Linux: `curl -sSf https://install.spacetimedb.com | sh`
- **Windows PATH:** open a new terminal afterwards, or refresh PATH in the current one:
  ```powershell
  $env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path
  ```
- **Pin the version** if it isn't 2.13.x:
  ```powershell
  spacetime version install 2.13.0
  spacetime version use 2.13.0
  ```
- **Dependencies, once per clone:** `npm install` installs the SDK, tsx, typescript and unpdf; `npm run db:install` installs the module's dependencies.

## 3. Start the local server

Run `spacetime start` in its own terminal and leave it running. It listens on `http://localhost:3000`; check it with `spacetime server ping local`. Each machine has its own server, data, identities and file store.

## 4. Environment variables (all optional, server-side only)

To override any of these, run `Copy-Item .env.example .env`. npm scripts load `.env` automatically.

| Variable | Default | Purpose |
|---|---|---|
| `SPACETIMEDB_URI` | `http://localhost:3000` | SpacetimeDB server |
| `SPACETIMEDB_DATABASE` | `accrual-docs` | Database name. Lowercase letters, digits and dashes; **no underscores** |
| `COMPANY_ID` | `demo` | Fixed demo company. Must match the company configured for backend services |
| `FILE_STORE_DIR` | `<repo>/data/files` | Persistent volume for original files. The gateway and worker must share it |
| `SPACETIMEDB_SECRETS_DIR` | `<repo>/backend/.secrets` | Gateway and worker identity tokens |
| `JOB_LEASE_SECONDS` / `JOB_MAX_ATTEMPTS` | `30` / `3` | Job policy, applied by `db:bootstrap` |
| `SPACETIME_BIN` | auto-detected | Path to the `spacetime` executable if it isn't on PATH |

## 5. Publish, generate, bootstrap

| Command | Does |
|---|---|
| `npm run db:publish` | Creates or updates the database, keeping its data. The first publish makes the CLI's local identity the **owner** |
| `npm run db:reset` | Republishes and **wipes all rows**, including identity registrations. Re-run `db:bootstrap` and `db:seed` afterwards |
| `npm run db:generate` | Writes `backend/db/bindings/`. Commit the result after every module change |
| `npm run db:bootstrap` | As owner: `configure_settings` (company "demo", USD, accounts 6100/2105), `configure_job_policy` (also schedules the sweep), and registers the gateway and worker identities (creating their tokens on first run) |
| `npm run db:sql -- "<query>"` | Owner SQL against the private tables, e.g. `SELECT id, role, status, attempts FROM jobs` |

## 6. Seed and smoke test

**`npm run db:seed`** builds the brief's demo (p.2), all synthetic:
- **Acme Contracting (`V-ACME`):** contract at $100/h, timesheet v1 → v2 with 70 approved hours (10 × 420 min) in Sep 2026, an August invoice, a ledger export, and the accrual JSON (`ACR-2026-09-ACME`, POSTED, $7,000.00).
- **Mock mailbox:**
  - the countersigned **Amendment No. 1 ($110/h from 2026-09-01) as an email attachment**, deliberately *not* imported with the case, so the investigation agent has to find it
  - a distractor that mentions a rate in the email body only ("an email alone is not approval")
  - a prompt-injection message
  - another vendor's email, to check search scope
- **Import and start:** the case is imported and review started, so **case 1 is in `EXTRACTING` with an `EXTRACTION` job `QUEUED`**, ready for an agent worker.

**`npm run smoke`** runs 23 checks against a fresh `SMOKE-xxxxxxxx` scope each time, so it can be repeated. It calls the Node repositories directly. It covers:
- **Document storage and access:** the file store, hash verification, tamper detection, metadata validation, gateway-only writes, view visibility, idempotency and versioning.
- **Import:** code-parsed facts with row references; unapproved timesheet rows become `REJECTED` facts; idempotent finalize; duplicate source entries rejected; missing inputs or duplicate work produce `WAITING_FOR_INPUT`.
- **Case operations:** `getCase`, `listCases`, `startReview`, `listJobs`, and live updates (views emit `onUpdate` when a case changes).
- **The full job pipeline:**
  - **EXTRACTION:** claim, heartbeat, and a scope-checked complete, which queues MATCHING.
  - **MATCHING:** a complete with an unresolved question, which queues INVESTIGATION.
  - **INVESTIGATION:** a complete, after which the case is awaiting `build_proposal`.
  - **Rejections:** a stale or forged lease, out-of-scope evidence, and wrong-case IDs are all rejected.
- **Agent tools:** vendor-scoped search, threads, attachment text, and scope errors.
- **Lease expiry:** the sweep requeues an expired job; a late completion is rejected; retries exhausted produce `RETRYABLE_ERROR`.

## 7. Data model

All tables are private, and clients read the matching `<table>_view`. Money is an **integer-cent string**, minutes are integers, dates are `YYYY-MM-DD` and periods are `YYYY-MM`. Evidence rows carry the case `input_revision` they belong to.

| Table | Key fields | Written by |
|---|---|---|
| `documents` | company_id, storage_key, type, version, content_hash, byte_length, media_type, original_filename, reference_id?, supersedes_document_id?, upload_key | `store_document`, `store_document_version` (gateway) |
| `settings` | company_id, currency, expense_account, liability_account, policy_version | `configure_settings` (owner) |
| `service_identity` / `module_owner` | identity, role (GATEWAY/WORKER) / owner identity | owner / `init` |
| `cases` | company_id, vendor_id, service_period_from/to, posting_period, original_status (DRAFT/POSTED), original_amount_cents, source_entry_id (unique), input_revision, state, current_proposal_id?, blockers[], idempotency_key | `finalize_import`, `start_review`, job transitions |
| `case_documents` | case_id, document_id, input_revision | `finalize_import` |
| `facts` | case_id, input_revision, document_id, page_or_row, excerpt, field, value, validation_status (ACCEPTED/REJECTED/PROPOSED), reason, source (CODE/AGENT), job_id?, model_run | `finalize_import` (CODE), `complete_job` (AGENT, PROPOSED) |
| `work_items` | case_id, fact_id, contractor, service_date, approved_minutes, claimed_rate_cents?, approved_by | `finalize_import` (APPROVED timesheet rows only) |
| `invoice_lines` | case_id, fact_id, invoice_number, contractor, service_start/end, minutes, amount_cents, posting_status, posted_date | `finalize_import` |
| `ledger_records` | case_id, fact_id, entry_id, vendor_id, period, kind (ACCRUAL/INVOICE/OTHER), amount_cents, status (POSTED/DRAFT), description | `finalize_import` |
| `allocations` | case_id, job_id, work_item_id, contract_document_id, invoice_line_ids[], ledger_record_ids[], evidence_ids[], validation_status (PROPOSED) | `complete_job` (MATCHING) |
| `emails` / `attachments` | vendor_id, thread_id, message_key, sender, recipients, subject, sent_at (ISO), body / email_id, document_id | `store_email` (gateway) |
| `jobs` | job_key (case:revision:role), case_id, case_revision, role, status, attempts, lease_token, lease_expires_at_micros, lease_connection_id, last_error | `start_review`, `complete_job`, `claim_job`, `heartbeat_job`, sweep |
| `job_results` | job_id, model_run (LIVE/REPLAYED), summary, explanation/evidence ids, unresolved_questions | `complete_job` |
| `job_policy` / `sweep_schedule` | lease_seconds, max_attempts / schedule row | `configure_job_policy` (owner) |

**Code parsing at import** (`backend/db/repositories/parsers.ts`). Headers are case-insensitive, `[]` marks an optional column, and amounts may be written like `"7,000.00"`.

| Document | Columns or fields |
|---|---|
| TIMESHEET (CSV) | `service_date, contractor, approved_minutes, status, [billing_rate], [approved_by]` |
| INVOICE (CSV) | `invoice_number, contractor, service_start, service_end, minutes, amount, posting_status, [posted_date]` |
| LEDGER (CSV) | `entry_id, vendor_id, period, kind, amount, status, [description]` |
| ACCRUAL (JSON) | `entryId, vendorId, status, amountCents\|amount, postingPeriod?, servicePeriod?{from,to}` |

Contracts, amendments and PDFs are not parsed. The extraction agent reads them.

## 8. Case states and the job pipeline (brief p.4)

```text
finalize_import ─► IMPORTED ──start_review──► EXTRACTING   [EXTRACTION job]
      │ missing inputs / duplicate work           │ complete_job
      ▼                                           ▼
WAITING_FOR_INPUT                          MATCHING     [MATCHING job]
                                                  │ complete_job with unresolvedQuestions?
                                     no ─────────┤ yes
                                     │            ▼
                                     │      INVESTIGATING [INVESTIGATION job]
                                     │            │ complete_job: questions remain → WAITING_FOR_INPUT
                                     ▼            ▼
                     awaiting build_proposal (later phase): every current-revision job SUCCEEDED
Lease expired → sweep requeues; attempts exhausted → job FAILED, case RETRYABLE_ERROR
```

- **Job and case status are separate** (brief p.4). Job statuses follow `JobStatus`: QUEUED, RUNNING (leased), SUCCEEDED, FAILED.
- **The hand-off to `build_proposal`:** `isAwaitingProposal(conn, caseId)` in `repositories/cases.ts` reports when the case is ready.
- **Evidence references** are prefixed strings: `doc:<documents.id>`, `fact:<facts.id>` and `email:<emails.id>`. All other IDs are plain decimal strings.
- **Allowed evidence for a job:** the case's documents, plus the vendor's mailbox emails and attachments, plus the current revision's facts.

## 9. Reducers

| Reducer | Caller | Purpose |
|---|---|---|
| `configure_settings`, `register_service_identity`, `configure_job_policy` | owner | Setup (`db:bootstrap`) |
| `store_document`, `store_document_version` | gateway | Document metadata. The bytes go on the file store first |
| `finalize_import`, `start_review` | gateway | Create the case from uploads; start the pipeline |
| `store_email` | gateway | Mock mailbox seeding |
| `claim_job`, `heartbeat_job`, `complete_job` | worker | Lease a job, keep it alive, submit `AgentOutput` |
| `sweep_expired_leases` | scheduler only | Every 2s: requeue expired leases, fail exhausted jobs |

The Python API (`backend/api`) calls these reducers and reads the views directly, as the gateway identity; see §10. The payload shapes for jobs, leases and agent output are in `backend/db/repositories/contracts.ts`.

## 10. Using the database from Python

Python needs no client library: SpacetimeDB speaks HTTP. **Verified against this database:** reading views, calling reducers, a worker claiming a job and completing it with nested results (the case advanced to `MATCHING`), optional arguments, and rejection messages. The helper below is stdlib-only and was run as written.

```python
import json, urllib.request, urllib.error

DB = "http://localhost:3000/v1/database/accrual-docs"       # SPACETIMEDB_URI + SPACETIMEDB_DATABASE

def _req(path, token, body, content_type):
    req = urllib.request.Request(f"{DB}{path}", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": content_type})
    try:
        with urllib.request.urlopen(req) as r:
            return r.read()
    except urllib.error.HTTPError as e:                      # a rejected reducer puts its message in the body
        raise RuntimeError(e.read().decode()) from None

def sql(token, query):
    """Query the views your identity may see. Returns a list of dicts."""
    result = json.loads(_req("/sql", token, query.encode(), "text/plain"))[0]
    cols = [c["name"]["some"] for c in result["schema"]["elements"]]
    return [dict(zip(cols, row)) for row in result["rows"]]

def call(token, reducer, *args):
    """Call a reducer. Arguments are positional, in the reducer's declared order."""
    _req(f"/call/{reducer}", token, json.dumps(list(args)).encode(), "application/json")
```

- **Tokens:** `backend/.secrets/gateway.token` (the API) and `backend/.secrets/worker.token` (agents), created by `npm run db:bootstrap`. Services use their own identity; **never use the owner token**. Tables are private, so use the `*_view` names (`SELECT … FROM jobs_view`).
- **Worker flow:**
  - **Find work:** `sql(worker, "SELECT id, case_id, case_revision, role FROM jobs_view WHERE status = 'QUEUED'")`.
  - **Claim:** `call(worker, "claim_job", job_id, case_id, case_revision)`. The call that returns success **won the lease**; losers get an error such as `… under another lease`.
  - **Read the lease:** `sql(worker, f"SELECT lease_token FROM jobs_view WHERE id = {job_id}")`.
  - **Submit:** `call(worker, "complete_job", job_id, case_id, revision, lease_token, "LIVE", proposed_facts, proposed_matches, evidence_ids, unresolved_questions, summary, explanation_evidence_ids)`. Heartbeat with `call(worker, "heartbeat_job", job_id, case_id, revision, lease_token)`.
- **Argument encoding:**
  - **Positional:** args are positional lists, in the order they appear in the reducer (see `backend/db/bindings/*_reducer.ts` or `pipeline.ts`).
  - **Nested objects:** nested objects are positional lists too, e.g. a proposed fact is `[document_id, page_or_row, excerpt, field, value]`. Object form needs `snake_case` keys.
  - **Options:** optional values are `{"some": x}` or `{"none": []}`.
  - **Large integers:** `u64` values are JSON numbers.
  - **Raw bytes:** `store_document` takes `byteLength` and a storage key, not file bytes. Bytes go to the file store.
- **Errors:** HTTP 200 means success. A rejected reducer returns HTTP 530 with its message (for example `Stale or unknown lease.`), and malformed arguments return 400.
- **SQL limits (tested):** `WHERE` filters work, but **`ORDER BY` is not supported** (HTTP 400), and `LIMIT` without an ordering returns arbitrary rows. Fetch the rows you need, then sort and slice in Python. Timestamps come back as a one-element list of microseconds since the epoch, e.g. `[1792826121551198]`.
- **File store:** the file store is a directory (`FILE_STORE_DIR`). A document's bytes are at `<FILE_STORE_DIR>/sha256/<first 2 hex of hash>/<hash>`. Python reads it directly and re-hashes. To write a file, save it at that path and then call `store_document`, following `backend/db/repositories/file_store.ts`.
- **Still TypeScript:** the code parsing of CSV/JSON at import (`parsers.ts`) and the `finalize_import` argument assembly (`cases.ts`). The Python API must port these, or call the Node tooling, to implement `create-review`. The reducer itself is language-neutral.

### Mapping the four API routes onto the database (suggested; Matthew to confirm)

| Route | Database side |
|---|---|
| `POST /create-review` | For each file: write the bytes to the file store, then `store_document` (gateway). Derive the case fields from the uploaded accrual document, whose parsed `accrual.*` facts hold `entryId` (→ `sourceEntryId`), `vendorId`, `status` (→ `originalStatus`), `amountCents`, `postingPeriod` and `servicePeriod`; ask for clarification if the status is unclear. Then `finalize_import` and `start_review`. The generated `idempotency_key` is the `finalize_import` key. A natural `review_id` is the case id |
| `GET /list-review` | `SELECT id, state, created_at, updated_at FROM cases_view WHERE id > <cursor>`, then sort by id and take `limit` rows in Python (there is no `ORDER BY`). The cursor is the last id returned, `next_cursor` is `null` when no rows remain, and the API's `status` is the case `state` |
| `GET /get-review` | `cases_view` (amounts, `blockers`, `input_revision`), `facts_view` (evidence: `document_id`, `page_or_row`, `excerpt`), and `jobs_view` plus `job_results_view` (history and summaries). Proposal fields stay `null` until `build_proposal` exists. SpacetimeDB's HTTP API has no subscription, so `live=true` polls these views and emits an event when the case's `updated_at` changes |
| `GET /export-review` | Not available yet: needs `build_proposal`, an approval reducer and an export reducer |

## 11. Repository layout

```text
scripts/db.mjs                                    publish / reset / generate / sql wrapper
backend/db/spacetime/spacetimedb/src/
  schema.ts                                       all private tables
  auth.ts                                         caller + company checks, view filter
  index.ts                                        settings, identities, documents (+ views); re-exports pipeline
  pipeline.ts                                     cases, import, mailbox, jobs, sweep (+ views)
backend/db/bindings/                              generated — never edit
backend/db/repositories/
  client.ts                                       connect / connectService('gateway'|'worker') / ownerToken / waitFor
  file_store.ts  documents.ts                     file store + document API
  parsers.ts  cases.ts  mailbox.ts  jobs.ts        import parsing, cases, mailbox, worker job API
  contracts.ts                                    job / lease / AgentOutput payload types
backend/agents/tools/index.ts                     read-only agent tools + AGENT_TOOL_SPECS
backend/db/seed/bootstrap.ts  seed.ts  documents/ owner setup, demo seed, synthetic files
backend/db/test/smoke.ts                          24-check smoke test
backend/api/                                      Python FastAPI review API stubs + Dockerfile (Matthew)
```

## 12. Troubleshooting

| Symptom | Fix |
|---|---|
| `spacetime` is not recognized | Open a new terminal (§2), or set `SPACETIME_BIN` |
| `ECONNREFUSED 127.0.0.1:3000`, or a hang on "Connecting…" | Start `spacetime start`; check `SPACETIMEDB_URI`/`SPACETIMEDB_DATABASE` |
| `… is not registered as GATEWAY/WORKER` | `npm run db:bootstrap` (needed after every reset) |
| `Only the module owner may do this` | The CLI identity isn't the publisher. Use a new database name, or `spacetime delete accrual-docs --server local` and publish again |
| `File … is missing from the file store` | `FILE_STORE_DIR` differs between processes, or the files were deleted |
| Breaking-change error on publish | `npm run db:reset`, then `db:generate`, `db:bootstrap`, `db:seed` |
| TypeScript errors about reducers or views | `npm run db:generate` |
| A job stuck in RUNNING | The worker died; the sweep requeues it once its lease expires (30s by default) |
| `npm` is blocked by the execution policy | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use `npm.cmd` |
| Server-side errors | `spacetime logs accrual-docs --server local -n 50`. `ERROR` lines after a smoke run are expected: they come from its deliberate rejection checks |

## 13. Extending (later phases)

- **Follow the brief's backend contract (p.4).** Still to build: `build_proposal`, `ask_question`/`resolve_exception`, `decide_review` (gateway-only; the worker can never approve) and `authorize_export`/`finalize_export` (the CSV goes on the file store).
- **Every new reducer** starts with a caller check and a company check (`auth.ts`). Every new table stays private behind a view filtered by `ctx.sender`.
- **`build_proposal` reads from these tables:**
  - `ACCEPTED` CODE facts, the typed evidence rows and `job_results`, for the current revision
  - agent facts and allocations, which are `PROPOSED`, so the calculator or a validation step decides what to accept
- **Changed inputs** (a new document version for a case) should bump `cases.input_revision`. Stale jobs are rejected automatically, because every worker call carries `expectedRevision`.
- **Python API:** connect each route to reducers and views over HTTP (§10), and add a smoke or API test for each one.
- **After a module change,** run `db:publish` (or `db:reset` followed by `db:bootstrap`), then `db:generate`, `typecheck` and `smoke`, and commit the bindings.
