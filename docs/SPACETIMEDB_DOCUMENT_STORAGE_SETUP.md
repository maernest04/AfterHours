# SpacetimeDB setup and handoff

The implemented data layer includes document storage, case import, evidence,
the mock mailbox, leased jobs and read-only agent tools. Application tooling is
Python; the schema/reducers/views remain a TypeScript SpacetimeDB module.
The four public review API routes remain explicit 501 stubs.

Factory Investigation, its leased worker and the gateway calculator/proposals
are implemented; see the [handoff](../backend/agents/INVESTIGATION.md).
EXTRACTION/MATCHING handlers, question delivery, approvals and exports remain to
build. No model API keys are needed to seed or test the data layer.

## Quick start

Install Docker Compose, uv, Node 22+ and the SpacetimeDB CLI. Match the CLI to the
2.13.0 server image and module dependency. Run from the repository root:

```sh
spacetime version install 2.13.0 --use
uv sync --project backend/db
npm --prefix backend/db/spacetime/spacetimedb ci
uv run --project backend/db afterhours-db start
uv run --project backend/db afterhours-db publish
uv run --project backend/db afterhours-db bootstrap
uv run --project backend/db afterhours-db seed
uv run --project backend/db python -m unittest discover -s backend/db/test -v
uv run --project backend/db afterhours-db smoke
npm run typecheck
```

Publishing creates `accrual-docs`; the CLI identity becomes the owner. Bootstrap
sets the company/accounts and job policy, schedules the lease sweep, and
registers separate gateway and worker identities. Root npm aliases invoke the
Python CLI; `db:install` also installs the TypeScript module dependencies. There
are no generated client bindings to regenerate.

On a fresh database, seed creates seven document rows, four emails and an Acme
case with EXTRACTION queued. It includes contract, timesheet v1→v2 (70 hours),
invoices, ledger, accrual and an amendment. The amendment is only a mailbox
attachment, not an initially imported case document. Mail includes a future-rate
distractor, a prompt-injection attempt and another vendor's message. The seed
is idempotent and does not reset completed jobs. This Acme scenario is separate
from the frontend Cedar fixture.

## Configuration and persistence

Copy `.env.example` to `.env` for overrides. CLI commands load it; direct SDK
imports use process environment variables or an explicit `DatabaseConfig`.

- `SPACETIMEDB_URI`: `http://localhost:3000`.
- `SPACETIMEDB_DATABASE`: `accrual-docs`.
- `SPACETIMEDB_PORT`: Docker host port, default `3000`; keep the URI in sync.
- `COMPANY_ID`: `demo`, fixed when settings are initialized.
- `FILE_STORE_DIR`: `data/files`, relative to the working directory.
- `SPACETIMEDB_SECRETS_DIR`: `backend/.secrets`, relative to the working directory.
- `JOB_LEASE_SECONDS` / `JOB_MAX_ATTEMPTS`: `30` / `3`, applied by bootstrap.
- `SPACETIME_BIN`: optional explicit CLI path; otherwise PATH and common install
  locations are checked.

Docker binds the database port to localhost. The named `spacetimedb-data` volume
mounts the server user's home, retaining records and signing keys. Original
files live separately in `data/files/`; gateway and worker services must share
that directory/volume. Service tokens live in owner-readable files under
`backend/.secrets/`. These directories are git-ignored.

`afterhours-db stop` and `afterhours-db start` stop/restart the database without
deleting data. Ordinary container recreation and `docker compose down` preserve
the named volume; `down --volumes` deletes it. Use separate secrets directories
when switching to unrelated servers/databases.

To deliberately replace all database rows:

```sh
uv run --project backend/db afterhours-db reset --yes
uv run --project backend/db afterhours-db bootstrap
uv run --project backend/db afterhours-db seed
```

Reset does not delete original files. Prefer ordinary `publish` when schema
changes can preserve data; reset is a destructive local-development operation.

## Schema and authorization

All 19 tables are private:

- Configuration: `module_owner`, `settings`, `service_identity`.
- Documents/import: `documents`, `cases`, `case_documents`.
- Evidence: `facts`, `work_items`, `invoice_lines`, `ledger_records`, `allocations`.
- Mailbox: `emails`, `attachments`.
- Queue: `jobs`, `job_results`, `job_policy`, `sweep_schedule`.
- Proposals: `posting_periods`, `proposals`.

The 15 public views check the caller's registered identity. They expose
`documents_view`, `settings_view`, `my_service_identity`, `cases_view`,
`case_documents_view`, `facts_view`, `work_items_view`, `invoice_lines_view`,
`ledger_records_view`, `allocations_view`, `emails_view`, `attachments_view`,
`jobs_view`, `job_results_view` and `proposals_view`. Unauthorized callers receive no rows.

Owner reducers configure settings/job policy and register identities. Gateway
reducers store/version documents, import cases, start reviews and store mailbox
messages. Workers claim/heartbeat/complete jobs. The lease sweep is scheduler
only. Reducers validate authority and company and commit transactionally; they
return no data, so helpers query the appropriate view after success.

Documents support ACCRUAL, CONTRACT, AMENDMENT, TIMESHEET, INVOICE, LEDGER and
OTHER, with CSV, JSON, text or PDF media types and a 10 MiB limit. Files use
`sha256/<hash>` keys; every read verifies size and SHA-256. Versions create new
rows linked to predecessors, and only the latest version can be superseded.
Upload keys provide retry idempotency and are separate from case import keys.

## Import and pipeline

The Python gateway verifies files and parses structured CSV/JSON with retained
row/JSON-path excerpts, then calls `finalize_import` with facts and typed rows.
Money is stored as integer-cent strings. APPROVED timesheet rows become work
items. Missing inputs and duplicate work block the case; duplicate document
content within one import is rejected. See the [data pipeline guide](../backend/data_pipeline/README.md).

`start_review` moves an imported case into EXTRACTION and queues its first job.
Jobs have a stable case/revision/role key and statuses QUEUED, RUNNING, SUCCEEDED
or FAILED. Completion advances EXTRACTION → MATCHING → INVESTIGATION when
questions remain. INVESTIGATION with unanswered questions sets WAITING_FOR_INPUT.
Otherwise the case awaits the gateway `build_proposal` stage;
`is_awaiting_proposal` checks this handoff.

Leases default to 30 seconds and are extended by heartbeat. A two-second sweep
requeues expired leases; reaching three attempts fails the job and sets
RETRYABLE_ERROR. Heartbeat/completion enforce worker identity, case revision,
RUNNING status, token and expiry. Claim requires and records a connection ID;
heartbeat/completion do not separately enforce connection ownership. Automatic
input revision bumps and cancellation are not implemented.

Agent facts/allocations are PROPOSED and retain LIVE/REPLAYED provenance. Evidence
IDs are `doc:N`, `fact:N` or `email:N`. Scope is imported case documents,
same-vendor emails/attachments and current-revision facts. Matches must reference
current case work/invoice/ledger rows; `contractId` is a document ID.

## Python service integration

Install with `uv pip install -e backend/db` or `python -m pip install -e backend/db`
inside the consuming service environment. The [SDK README](../backend/db/README.md)
shows document and case usage; the [agent README](../backend/agents/README.md)
shows leases and tool dispatch.

```python
from afterhours_db import AfterHoursDB
from afterhours_db.cases import list_cases, list_facts
from afterhours_db.jobs import list_claimable_jobs

with AfterHoursDB.connect("gateway") as db:
    for case in list_cases(db):
        print(case["id"], case["state"], list_facts(db, case["id"]))

with AfterHoursDB.connect("worker") as db:
    print(list_claimable_jobs(db))
```

Gateway reducer calls and all reads use authenticated HTTP. Worker connections
also hold a persistent JSON WebSocket for reducer calls, because `claim_job`
requires `ctx.connectionId`. Keep that same connection through heartbeat and
completion. Plain HTTP calls cannot claim worker leases. The SDK provides no
subscription cache or view-event callbacks; reads are fresh HTTP queries and
workers must poll for work.

Python document and lease models are frozen dataclasses with integer IDs and UTC
datetimes; case/evidence queries return snake_case dictionaries. LLM tool JSON
and AgentOutput retain camelCase and decimal-string IDs. SDK helpers handle
ordered SATS-JSON reducer arguments and option values. Calls are synchronous;
use synchronous handlers or `asyncio.to_thread` in async services. Do not
blindly retry an interrupted write because it may have committed.

The frontend calls the Python API, never SpacetimeDB with service credentials.
The remaining API integration is:

- `POST /create-review`: upload originals, derive trusted accrual metadata,
  `finalize_import`, then `start_review`; keep the import key stable on retry.
- `GET /list-review`: read cases, apply API filters and cursor pagination in Python.
- `GET /get-review`: combine case, current evidence and job/result history.
  A future live response must poll or add subscriptions; the SDK has no event feed.
- `GET /export-review`: blocked on proposal, approval and export implementation.

These are integration targets, not successful API behavior today. The four
routes return 501; there is no working approval/export flow behind the UI.

## Verification and troubleshooting

```sh
uv run --project backend/db python -m unittest discover -s backend/db/test -v
uv run --project backend/db afterhours-db smoke
uv run --project backend/db afterhours-db sql 'SELECT id, role, status, attempts FROM jobs'
docker compose ps spacetimedb
docker compose logs --tail 50 spacetimedb
```

The unit suite covers transports, file integrity, parsers/imports and tool
scope/PDF extraction. The live smoke command exercises storage/authorization,
case import, mailbox scope and job pipeline/lease behavior. The Python smoke
suite passed 23 checks locally (13 storage and 10 pipeline) on 2026-10-24;
rerun it after setup or changes. Smoke uses synthetic records and may leave test files,
including deliberately tampered originals; expected rejection logs are normal.

The SQL CLI uses the owner's token and may query private tables. Application
services use their gateway/worker credentials instead. On connection errors,
check container health, URI and port. On identity errors, run bootstrap with the
publishing CLI identity. Missing files usually mean mismatched file-store paths
or an unmounted shared volume. Lease errors can mean an expired or lost worker
connection; do not continue with its old lease. Re-run typecheck, publish and
smoke after module changes.
