# AfterHours

Accrual correction assistant for Cal Hacks 13. AfterHours checks existing accruals
against contracts, approved work, invoices, ledger records and supporting emails,
then prepares corrections for human approval. Initial scope: one synthetic
company, hourly contractor services, USD. Exporting a CSV does not post an entry.

## Current implementation

- SpacetimeDB: document storage/versioning, cases, structured import, evidence,
  mock mailbox, job queue, leases, bounded retries and evidence-scoped results.
- Python SDK (`afterhours_db`): typed documents, authenticated queries/reducers,
  parsers, case/mailbox helpers, worker leases and read-only agent tools.
- Factory Investigation worker and gateway calculator: source-linked rate
  investigation and immutable unapproved journal proposals. See the [handoff](backend/agents/INVESTIGATION.md).
- Matching worker: Python/Factory handler, output validation, leased polling,
  synthetic fixture seeding and database-backed replay tests. See [agents](backend/agents/README.md).
- Approval watcher: email decision evaluator and mock polling service. Email stays
  mocked for this MVP; persisted approval decisions/export remain pending. See [watcher setup](backend/approval_watcher/README.md).
- Python API: structured file imports, database-backed paginated listing and
  review details/live snapshots. Approved CSV export remains an explicit **501**.
- Pipeline: Python dispatcher starts accepted imports and runs Bitdeer extraction,
  Factory matching and investigation through the database queue, followed by
  deterministic calculation. See [pipeline setup](backend/orchestrator/README.md).
- Frontend: React review workspace with a simulated adapter while full API
  integration is pending. See [frontend setup](frontend/README.md).

Persisted mock approval decisions, journal CSV export and
frontend API integration remain separate work. Live agent inference requires Bitdeer and Factory
credentials; replay tests need no model key.

## Runtime boundaries

Application services use **Python** and run in separate local Docker containers.
The database schema, reducers and views remain **TypeScript**, executed inside
SpacetimeDB; it does not support Python database modules. Node is used to build
that module and the React frontend. Database client/setup tools are Python.

The browser talks only to the Python API. Gateway and worker identities stay
server-side; private database tables are exposed through caller-filtered views.
Gateway services can import documents/cases. Workers can claim jobs, heartbeat
leases and submit evidence-linked results; they cannot approve, export or change
policy. Owner credentials are reserved for database setup.

Original files live in `data/files/`, referenced by SHA-256. Database records and
signing keys persist in the `spacetimedb-data` Docker volume. The API writes the
shared file store; worker containers mount it read-only.

## Local setup

Install Docker with Compose, uv, Node 22+ and SpacetimeDB CLI 2.13.0. From the
repository root:

```sh
uv sync --project backend/db
npm --prefix backend/db/spacetime/spacetimedb ci
uv run --project backend/db afterhours-db start
uv run --project backend/db afterhours-db publish
uv run --project backend/db afterhours-db bootstrap
uv run --project backend/db afterhours-db seed
uv run --project backend/db afterhours-db smoke
```

The database is `accrual-docs` at `http://localhost:3000`. Bootstrap configures the
demo company, separate gateway/worker identities, and a 30-second lease with
three attempts. Seed creates seven documents, four mock emails, and a case with
an extraction job queued. Repeating seed is idempotent.

The `npm run db:*` aliases invoke Python CLI commands. `npm run typecheck` checks
only the database module. There are no generated TypeScript client bindings.

Start the API with `docker compose up --build -d api`, then open
`http://localhost:8000/docs`. If that port is occupied, use `API_PORT=8001`.
Start the ready pipeline stages with `docker compose --profile pipeline up --build -d pipeline`.
This processes all configured extraction/matching/investigation jobs and uses provider credits.
For a scoped run, use `docker compose --profile pipeline run --rm pipeline afterhours-orchestrate --once --case-id N`.
Fresh uploads run extraction when `BITDEER_API_KEY` is configured; otherwise they
wait in its queue. No fixture result is substituted. Resolved cases automatically
run the source-validated calculator with an entry date at posting month-end.
Full setup, environment overrides and persistence details:
[database handoff](docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md).

After pulling module changes, run `publish`, `bootstrap`, and the checks. Publish
preserves data when the migration is compatible. The explicit `reset --yes`
command deletes database rows; it is not required for normal startup.

## Python SDK

Install into another service with `uv pip install -e backend/db` from the repo
root. Gateway code uses `AfterHoursDB.connect("gateway")`. Worker code uses a
persistent WebSocket connection for lease-bearing reducer calls; reads query
fresh server state over HTTP. There is no subscription cache. The pipeline
dispatcher runs matching/investigation and recovers accepted imports after restart.

```python
from afterhours_db import AfterHoursDB, AgentTools, claim_job, list_claimable_jobs

with AfterHoursDB.connect("worker") as db:
    queued = list_claimable_jobs(db, roles=["EXTRACTION"])
    if queued:
        job = queued[0]
        lease = claim_job(db, job["id"], job["case_id"], job["case_revision"])
        tools = AgentTools(db, lease.case_id)
        evidence = tools.get_case_evidence()
        # Heartbeat while the worker runs, then submit a validated AgentOutput.
```

Read the [SDK guide](backend/db/README.md) before running a worker. SDK document
IDs are Python integers; LLM tool contracts use decimal-string IDs. Money stays
in integer-cent strings; durations use integer minutes. Evidence references are
`doc:N`, `fact:N`, and `email:N`. Agent output is recorded as `LIVE` or `REPLAYED`.

## Public API and review flow

The four routes are `create-review`, `list-review` (cursor pages, maximum 10),
`get-review` (including live updates), and `export-review` (CSV by review ID).
Create accepts files only; the backend generates IDs and derives original status
from source data. Approval, rejection and questions use the email channel. Demo
review controls simulate that channel; they are not implemented approval APIs.
See [API contracts](backend/api/README.md).

The implemented database flow is:

```text
upload → finalize import → IMPORTED → EXTRACTING → MATCHING
                                                     │
                                                     ├─ questions → INVESTIGATING
                                                     │                ├─ unresolved → WAITING_FOR_INPUT
                                                     │                └─ resolved ─┐
                                                     └─ resolved ──────────────────┤
                                                                                   ▼
                                                         deterministic calculation
                                                         READY_FOR_REVIEW / VERIFIED_NO_CHANGE
```

Structured CSV/JSON is parsed by code. Models propose facts and matches through
leased jobs; reducers enforce scope and revision checks. Expired jobs are
requeued by a scheduled sweep; exhausted retries surface `RETRYABLE_ERROR`.
The pipeline invokes the gateway calculator, saves an unapproved proposal and sets
`READY_FOR_REVIEW` or `VERIFIED_NO_CHANGE`. Persisted mock approval and export
remain to build.

## Demo fixtures

The database seed uses Acme Contracting (`V-ACME`), a posted $7,000 accrual, 70
approved hours, a $100/hour contract, and an approved $110/hour amendment found
only through the mock mailbox. It includes distracting, untrusted and other-vendor
emails to exercise evidence scoping. The intended calculator result is a $7,700
target and a **$700 adjustment**; database integration tests verify that result
using explicitly replayed model decisions.

The frontend handoff has a separate, explicitly simulated Cedar Labs / Acme
Services fixture with its own dates and account mappings. It is not a live view
of the database seed. Do not treat simulated approval or CSV output as a server
approval or posted accounting entry.

## Checks

```sh
npm run typecheck
npm run test:sdk
npm run smoke
.venv/bin/python -m unittest discover -s backend/api/tests -v
```

The database smoke suite runs 13 storage checks and 10 pipeline/worker checks
against the real local server, with synthetic/replayed agent output. It creates
unique test records and restores the configured lease policy after expiry tests.
The API tests cover imports, projections, streaming, pagination and the remaining
export stub. The opt-in HTTP/database flow uses actual persisted records and
worker implementations with explicitly replayed model decisions, not paid calls:

Run these shared-database tests with live worker containers and host workers stopped.
An independent watcher could otherwise claim a test case before its replay provider.

```sh
docker compose stop pipeline matching
API_PORT=8001 docker compose -f compose.yaml -f backend/orchestrator/compose.test.yaml run --build --rm pipeline-tests
```

Or run the same flow from the host against an already-running API:

```sh
AFTERHOURS_FLOW_TESTS=1 AFTERHOURS_API_URL=http://127.0.0.1:8001 \
  PYTHONPATH=backend/orchestrator/src \
  backend/agents/.venv/bin/python -m unittest discover -s backend/tests -v
```

For the host command, run the API container first with the same local database/file store.
The flow checks upload, queued extraction, the real extraction worker with replayed decisions, matching,
mock-mail investigation, persisted calculation, HTTP details and SSE. It does not
claim approval/export E2E coverage. Test records are synthetic and remain local.
The Docker suite also checks investigation SDK startup with fake credentials and
no prompt. The pipeline uses writable temporary SDK storage inside its read-only
container.

Run the opt-in paid flow with the normal Compose configuration:

```sh
API_PORT=8001 docker compose -f compose.yaml -f backend/orchestrator/compose.test.yaml run --build --rm pipeline-live-tests
```

This imports one fresh synthetic review, runs Bitdeer extraction and Factory
matching/investigation, and requires all three persisted results to be `LIVE`.
The signed amendment is available only in the mock mailbox. The test checks API
details/SSE and the calculated $7,700 target/$700 adjustment; it never approves or posts.
It fails if provider configuration is missing instead of substituting replay.

On 2026-10-24, the [ten-scenario suite](backend/tests/README.md) passed with live
Bitdeer/Factory calls in a separate local database. Eight cases produced the expected
calculation; unsigned and conflicting amendments stayed `WAITING_FOR_INPUT` without
a proposal. All jobs completed on their first attempt. API/SSE, pagination and
idempotent resume were verified. Approval and CSV export remain outside that coverage.
Frontend build and test commands are in [frontend/README.md](frontend/README.md).
