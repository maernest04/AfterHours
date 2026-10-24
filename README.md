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
  investigation, background heartbeats and immutable unapproved journal proposals.
  See the [handoff](backend/agents/INVESTIGATION.md).
- Python API: four runnable stubs with documented success contracts; valid
  requests return **501 errors** until workflow integration is implemented.
- Frontend: review-workspace implementation is being developed separately with
  a simulated adapter while the public API is stubbed. See [frontend setup](frontend/README.md).

EXTRACTION/MATCHING handlers, authoritative human approval, journal CSV backend
and public API orchestration remain to be implemented.

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
signing keys persist in the `spacetimedb-data` Docker volume. The API and workers
will share the file-store volume when their integration is implemented.

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
Full setup, environment overrides and persistence details:
[database handoff](docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md).

After pulling module changes, run `publish`, `bootstrap`, and the checks. Publish
preserves data when the migration is compatible. The explicit `reset --yes`
command deletes database rows; it is not required for normal startup.

## Python SDK

Install into another service with `uv pip install -e backend/db` from the repo
root. Gateway code uses `AfterHoursDB.connect("gateway")`. Worker code uses a
persistent WebSocket connection for lease-bearing reducer calls; reads query
fresh server state over HTTP. There is no subscription cache. Investigation has
a case-scoped polling worker; other role loops remain to build.

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
              │                                      │
              └─ missing/invalid input                ├─ unresolved evidence → INVESTIGATING
                 → WAITING_FOR_INPUT                  │                         │
                                                      └─ awaiting proposal ◄────┘
```

Structured CSV/JSON is parsed by code. Models propose facts and matches through
leased jobs; reducers enforce scope and revision checks. Expired jobs are
requeued by a scheduled sweep; exhausted retries surface `RETRYABLE_ERROR`.
The gateway calculator then saves a proposal and sets `READY_FOR_REVIEW` or
`VERIFIED_NO_CHANGE`. Human approval and export remain to build.

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
The API tests verify stub behavior and contracts, not a completed accounting flow.
Frontend build and test commands are in [frontend/README.md](frontend/README.md).
