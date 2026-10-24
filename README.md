# AfterHours: Accrual correction assistant

Cal Hacks 13, Hyphenate track. The assistant helps accountants **check and fix accruals they've already prepared**:
- it gathers evidence (contracts, amendments, approved timesheets, invoices, ledger records, and a mock finance mailbox)
- it finds discrepancies
- it prepares a correction for a human to approve

Initial scope: hourly contractor services, one company, USD.

**Runtime direction:** backend services are **Python**, each in its own local Docker container. The SpacetimeDB module, its generated bindings and the Node tooling in `backend/db` (seed, smoke test, repositories) stay TypeScript. Python reaches the database over plain HTTP (see [Using the database from Python](#using-the-database-from-python)).

**Source of truth:** `Accrual_Correction_Brief` (revised: SpacetimeDB edition). All data in this repo is **synthetic**.

---

## Status

| Area | Status | Owner / where |
|---|---|---|
| SpacetimeDB data layer: documents, cases and import, evidence, mock mailbox, job queue | ✅ Done, smoke 23/23 | `backend/db` |
| Read-only agent tools (`searchEmails`, `readEmailThread`, `readAttachment`, `getCaseEvidence`) | ✅ Done (TypeScript reference implementation) | `backend/agents/tools` |
| Python review API: `create-review`, `list-review`, `get-review`, `export-review` | 🟡 Stubs: validate input, return 501 (Matthew) | `backend/api` |
| API connected to the database | ⏳ Next. Python calls SpacetimeDB over HTTP | `backend/api` |
| Agent worker loop + Extraction / Matching / Investigation handlers + prompts | ⏳ Next | `backend/agents`, `backend/orchestrator` |
| Calculator + `build_proposal` + proposals | ⏳ Next (critical path) | `backend/db` |
| Questions, approval, CSV export | ⏳ Next. The approval channel is an open question (see below) | `backend/db` + `backend/api` |
| Reviewer UI | ⏳ Next | `frontend` |

The first milestone ends at **"Approved – ready to export"** (brief p.2).

---

## Architecture

```text
Browser ──► Python API (FastAPI, backend/api) ──► SpacetimeDB  (single source of truth)
                │ server-held GATEWAY identity          ▲  private tables; reducers check the caller;
                └─► file store (data/files)             │  views filter rows by ctx.sender
Python worker(s) (WORKER identity) ─ claim / complete ──┘  + read views and the file store
   └─ Bitdeer / Factory model calls run here, never inside the database
```

- **SpacetimeDB is the only database** (no Convex). Reducers enforce every state change; the worker can only submit validated, evidence-linked results through leased jobs.
- **Three identities:** the **owner** (whoever published the module; setup only), the **gateway** (Next.js server; imports and reviewer actions) and the **worker** (agents; claim, heartbeat and complete only). **Agents cannot approve, export, or change policy.**
- **Original files** live on a content-addressed file store (`data/files/`, `storageKey = sha256/<hash>`). Every read is re-hashed.

---

## Quick start

### 1. Prerequisites (once per machine)

| Tool | Version | Install / check |
|---|---|---|
| Node.js | 22.x | `node --version` |
| SpacetimeDB CLI | **2.13.x** | Windows: `iwr https://windows.spacetimedb.com -useb \| iex`. macOS/Linux: `curl -sSf https://install.spacetimedb.com \| sh`. Then **open a new terminal** and run `spacetime --version` |

If the CLI isn't 2.13.x, run `spacetime version install 2.13.0` and then `spacetime version use 2.13.0`.

### 2. Run it

```powershell
npm install
npm run db:install

# Terminal A — leave running
spacetime start

# Terminal B
npm run db:publish      # first time: creates database "accrual-docs"; your CLI identity becomes owner
npm run db:generate     # regenerate TypeScript bindings
npm run typecheck
npm run db:bootstrap    # company settings, job policy, gateway + worker identities
npm run db:seed         # demo Acme case + mock mailbox; leaves an EXTRACTION job QUEUED
npm run smoke           # expect: 23/23 checks passed
```

**It works when:**
- `npm run smoke` prints `23/23 checks passed`
- the seed's last line reads `case 1 ACR-2026-09-ACME POSTED $7000 state EXTRACTING jobs [EXTRACTION:QUEUED]`

### 3. After pulling changes to the database module

```powershell
npm run db:reset; npm run db:generate; npm run db:bootstrap; npm run db:seed
```

`db:reset` wipes the local database, including the identity registrations, so always re-run `db:bootstrap` afterwards.

---

## npm scripts

| Script | What it does |
|---|---|
| `db:start` | `spacetime start` (local server on `http://localhost:3000`) |
| `db:install` | Installs the SpacetimeDB module's dependencies |
| `db:publish` / `db:reset` | Publish the module, keeping data / **wiping all data** |
| `db:generate` | Regenerate `backend/db/bindings/` (commit the result) |
| `db:bootstrap` | Owner setup: settings, job policy and expired-lease sweep, service identities (idempotent) |
| `db:seed` | Load the synthetic demo (idempotent) |
| `db:sql -- "<query>"` | Owner SQL on private tables, e.g. `npm run db:sql -- "SELECT id, role, status FROM jobs"` |
| `smoke` | End-to-end smoke test (23 checks; can be re-run) |
| `typecheck` | Type-check the Node code and the module |

**Python API** (Matthew): `docker compose up --build -d api`, then open `http://localhost:8000/docs`. Setup and tests: [backend/api/README.md](backend/api/README.md).

---

## Configuration

Everything is optional; the defaults work locally. To override, run `Copy-Item .env.example .env`. npm scripts load `.env` automatically. All values are **server-side only**.

| Variable | Default | Purpose |
|---|---|---|
| `SPACETIMEDB_URI` | `http://localhost:3000` | SpacetimeDB server |
| `SPACETIMEDB_DATABASE` | `accrual-docs` | Database name: lowercase letters, digits and dashes, **no underscores** |
| `COMPANY_ID` | `demo` | The fixed demo company; any other company ID is rejected |
| `FILE_STORE_DIR` | `data/files` | Original files. The gateway and worker must share it |
| `SPACETIMEDB_SECRETS_DIR` | `backend/.secrets` | Gateway and worker tokens (git-ignored, never commit) |
| `JOB_LEASE_SECONDS` / `JOB_MAX_ATTEMPTS` | `30` / `3` | Job lease length and retry bound |
| `FACTORY_API_KEY`, `BITDEER_API_KEY`, … | empty | For the agent phase (worker only) |

---

## How a case flows (brief p.4)

```text
upload documents ─► imports.finalize ─► IMPORTED ─► cases.startReview ─► EXTRACTING [EXTRACTION job]
                     (CSV/JSON parsed by code into                          │ agent completes
                      facts + work items, invoices,                         ▼
                      ledger records; duplicates and                 MATCHING [MATCHING job]
                      missing inputs ─► WAITING_FOR_INPUT)                  │ unresolved questions?
                                                                     yes ───┴─── no
                                                                      ▼            │
                                                       INVESTIGATING [INVESTIGATION job]
                                                                      │            │
                                                                      ▼            ▼
                                                       awaiting build_proposal ◄───┘  (next phase)
                                                       ─► READY_FOR_REVIEW ─► APPROVED ─► EXPORTED
```

- **Job statuses:** QUEUED → RUNNING (leased) → SUCCEEDED / FAILED.
- **Expired leases:** a sweep requeues them every 2 seconds. After 3 attempts the job fails and the case moves to `RETRYABLE_ERROR`.
- **Stale work is rejected:** every worker call carries the case revision, so results from an older revision can't overwrite newer evidence.

**Conventions:**
- **Money:** integer-cent strings (`"700000"` = $7,000.00).
- **Durations:** integer minutes.
- **Dates and periods:** `YYYY-MM-DD` and `YYYY-MM`.
- **IDs:** decimal strings.
- **Evidence references:** `doc:N`, `fact:N` and `email:N`.
- **Agent output:** facts and matches are stored as `PROPOSED`, and every agent result records `LIVE` or `REPLAYED`.

---

## Demo data (`npm run db:seed`, brief p.2)

| Item | Detail |
|---|---|
| Vendor | Acme Contracting (`V-ACME`), contractor J. Rivera |
| Accrual | `ACR-2026-09-ACME`, **POSTED**, $7,000.00 (70 h × $100/h) |
| Case documents | MSA at $100/h, timesheet v1 → **v2** (10 × 420 min = 70 approved hours, billed at $110/h), August invoice (already posted), ledger export, accrual JSON |
| Mock mailbox | **Amendment No. 1** (signed: $110/h from 2026-09-01) as an email **attachment only**; a distractor that mentions a rate in the body only; a **prompt-injection** email; another vendor's email |
| Expected outcome (to build) | Corrected target $7,700 → export a **$700 adjustment** (or $7,700 if the accrual were a draft) |

---

## Building on this

### Agents (start here: [backend/agents/README.md](backend/agents/README.md))

```ts
const { conn } = await connectService('worker');                       // backend/db/repositories/client.ts
const job = listClaimableJobs(conn, ['EXTRACTION'])[0];                 // backend/db/repositories/jobs.ts
const ref = { jobId: job.id, caseId: job.caseId, expectedRevision: job.caseRevision };
const lease = await claimJob(conn, ref);                                // allowedEvidenceIds, facts, outputSchema
const tools = createAgentTools(conn, { caseId: lease.caseId });         // backend/agents/tools (read-only)
// ... call Bitdeer / Factory with AGENT_TOOL_SPECS, then:
await completeJob(conn, { ...ref, leaseToken: lease.leaseToken }, 'LIVE', agentOutput);
```

The output is the `AgentOutput` type in `backend/db/repositories/contracts.ts`. Evidence must be in `lease.allowedEvidenceIds`: the case's documents, the vendor's mailbox, and the current facts.

### Using the database from Python

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

### Database changes

- **Private tables:** keep every new table private and expose it through a view filtered by `ctx.sender`.
- **Caller checks:** every reducer starts with a caller check and a company check (`src/auth.ts`).
- **Don't break existing columns or reducer signatures;** extend them instead.
- **After a module change:** run `db:publish` (or `db:reset` followed by `db:bootstrap`), then `db:generate`, `typecheck` and `smoke`, and commit the bindings.

---

## Next steps by role

| Who | Next |
|---|---|
| **Agent teammates** | Worker loop; Extraction (Bitdeer: rates, effective dates and signers from contracts and amendments); Matching (Factory: link work to contract, invoices and ledger, and raise rate mismatches as unresolved questions); Investigation (Factory: find the signed amendment and ignore the email-only rate and the injection). Build replayed stubs first, then go live. Agree on fact field names with the calculator owner (`rate.hourlyCents`, `rate.effectiveFrom`, `rate.approvedBy`, …) |
| **Calculator owner** (critical path) | `build_proposal`: exact cents; posted → adjustment, draft → full entry; closed period → blocked; no double-counted work; an email alone isn't approval; immutable proposal versions with a hash; `VERIFIED_NO_CHANGE`. Trigger it when `isAwaitingProposal()` is true |
| **Matthew** (Python API) | Connect the four routes to the database over HTTP (see above); implement the `create-review` import (upload → file store → `store_document` → `finalize_import`) with vendor, period, amount and draft/posted inferred from the accrual document; the reviewer question and approval flow (see the open question below); decide how reviewer questions get answered (there is no answering agent role yet) |
| **Frontend** | Reviewer UI through the Python API: case list, case page, evidence, ask why, approve or reject, copyable entry table and CSV download. Use the seeded case 1 |
| **Database (Wayne)** | Bump the case revision when a case document gets a new version (invalidates old jobs and approvals); support the new tables and reducers |

**To confirm as a team:**
1. **Approvals:** the brief (p.1-2) says a human approves, rejects or asks a question on the **reviewer screen**. The Python API README says these flow through **email**. The database enforces approval only through the gateway identity, so either works, but the team should pick one and say so in the docs.
2. **Agent language:** the agent tools and worker helpers in this repo are TypeScript; the runtime direction is Python. Python agents can use the HTTP calls above, or the tools can be ported.
3. **Parsing:** structured CSV/JSON is parsed by code at import, not by the extraction agent. The extraction owner can take over `backend/db/repositories/parsers.ts` if preferred.
4. **Stage advancement:** `complete_job` advances the stages automatically, and the orchestration owner may want to change that rule.

---

## Repository layout

```text
.env.example                         configuration template
scripts/db.mjs                       publish / reset / generate / sql wrapper
docs/                                setup guide, progress log
compose.yaml                         Docker Compose (API container for now)
data/files/                          local file store (git-ignored)
backend/
  db/
    spacetime/spacetimedb/src/       SpacetimeDB module: schema.ts, auth.ts, index.ts (documents), pipeline.ts (cases, mailbox, jobs)
    bindings/                        generated client bindings (never edit)
    repositories/                    Node API: client, file_store, documents, parsers, cases, mailbox, jobs, contracts
    seed/                            bootstrap.ts, seed.ts, synthetic documents
    test/smoke.ts                    end-to-end smoke test
  agents/                            tools/ (done), implementations/ and prompts/ (next)
  api/                               Python FastAPI review API stubs + Dockerfile (Matthew)
  orchestrator/, data_pipeline/      skeleton
frontend/                            skeleton (reviewer UI next)
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `spacetime` is not recognized | Open a new terminal after installing |
| A connection hangs, or `ECONNREFUSED :3000` | Start `spacetime start` |
| `not registered as GATEWAY/WORKER` | `npm run db:bootstrap` (needed after every reset) |
| `Only the module owner may do this` | The CLI identity isn't the publisher. `spacetime delete accrual-docs --server local`, then publish again |
| TypeScript errors about reducers or views | `npm run db:generate` |
| A job stuck in RUNNING | Its worker died; the sweep requeues it when the lease expires (30s) |
| Server errors | `spacetime logs accrual-docs --server local -n 50`. `ERROR` lines after a smoke run are expected: they come from its deliberate rejection checks |

## Documentation

- **[docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md](docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md):** full setup, data model, reducers, file formats and troubleshooting.
- **[docs/SPACETIME_DB_PROGRESS.md](docs/SPACETIME_DB_PROGRESS.md):** what was built, and the decisions made.
- **[backend/agents/README.md](backend/agents/README.md):** the agent integration guide.
- **[backend/api/README.md](backend/api/README.md):** the Python review API (routes, response contracts, Docker, tests).
- **[backend/db/spacetime/CLAUDE.md](backend/db/spacetime/CLAUDE.md):** SpacetimeDB TypeScript API reference for coding agents.
