# Orchestrator

This Python service polls the existing SpacetimeDB workflow. It recovers accepted
`IMPORTED` cases with `start_review`, then dispatches the merged EXTRACTION,
MATCHING and INVESTIGATION workers, then runs the deterministic proposal calculator.
Database jobs, leases, revision checks and stage reducers
remain the only workflow state; there is no second queue or state store.

Current boundaries are intentional:

- EXTRACTION (Bitdeer) runs only when `BITDEER_API_KEY` is set (the CLI enables it). Without it,
  imported cases enter `EXTRACTING` with a queued job and stay there, reported as
  `blocked`; extraction is never faked. With it, the cycle claims EXTRACTION jobs,
  and MATCHING then follows through the normal database transitions.
- Existing extracted fixtures can run MATCHING and, when questions remain,
  INVESTIGATION. Investigation reads the existing mock mailbox through scoped
  `AgentTools`; no real email integration or sending is enabled.
- Resolved cases run the existing source-validated calculator and become
  `READY_FOR_REVIEW`, or `VERIFIED_NO_CHANGE` when the adjustment is zero.
  Open questions remain `WAITING_FOR_INPUT` and never calculate. Approval and
  export are not triggered by this service.
- Every completed model job retains `LIVE` or `REPLAYED` provenance. The service
  has no automatic replay or synthetic success fallback.

## Run locally

From the repository root, after the normal database bootstrap:

```sh
uv run --project backend/orchestrator afterhours-orchestrate
```

The default process polls every two seconds, attempting at most ten queued
worker jobs and, separately, at most ten proposal calculations per cycle. A
bounded, case-scoped invocation is:

```sh
uv run --project backend/orchestrator afterhours-orchestrate --once --case-id 123 --max-jobs 2
```

`--once` performs one import-recovery pass and at most `--max-jobs` worker
attempts, followed by at most `--max-jobs` proposal attempts, then exits. Newly
queued investigation jobs can run in the same cycle if the worker budget permits.
It exits with status 1 when any attempt or poll fails. Unconfigured extraction and
failed calculation are reported as `blocked`, never as successful work.
`--case-id` scopes import recovery, job dispatch, and calculation.

The JSON report contains started case IDs, completed job summaries,
`completed_proposals` with persisted IDs, revisions, entry dates, exact integer-cent
amounts and hashes, errors by type, and blocked stages. Exception payloads and
model output are excluded from service logs.

## Deterministic calculation

The calculator runs only for `MATCHING` or `INVESTIGATING` cases whose current
revision's jobs all succeeded, with no blockers and no current proposal. It uses
the last calendar day of the review's posting period as the journal entry date
(for example, `2026-09` becomes `2026-09-30`). This stays stable across retries;
it does not use today's date or open a closed posting period automatically.

The existing calculator reads current policy and validates source evidence,
contractual rates, work, invoice coverage and ledger support. The database reducer
checks the expected revision, policy, posting period, completed stages and proposal
uniqueness before writing. Calculation remains deterministic; it adds no model call.

Each poll also discovers cases that finished their agent stages before a process
restart. Existing proposals are skipped, including after a successful commit whose
response was lost. Calculator errors are isolated by case and reported as
`CALCULATION`; the unchanged ready case is retried on a subsequent poll. Domain
errors such as closed periods need their source/configuration issue resolved before
retry can succeed. No approval, posting, export or terminal error state is invented.
The persistent CLI rotates each bounded calculation pass after the previous
attempted case, including failures, so later ready cases still get a turn. This
in-memory cursor survives connection retries and resets safely on process restart;
all eligibility and completion state still comes from the database. Callers that
poll `run_cycle` directly can pass `report.last_calculation_case_id` back as
`calculation_after_case_id`. Case-scoped runs always consider their selected case.

Required database settings use the existing SDK conventions:

- `SPACETIMEDB_URI`, `SPACETIMEDB_DATABASE`, `COMPANY_ID`
- `SPACETIMEDB_SECRETS_DIR`: gateway and worker tokens from bootstrap
- `FILE_STORE_DIR`: the same evidence files written by the API

LIVE extraction needs `BITDEER_API_KEY` (optional `BITDEER_MODEL_ID`, `BITDEER_TOKEN_BUDGET`,
`EXTRACTION_TIMEOUT_SECONDS`, default 240, max 600). LIVE matching/investigation additionally need `FACTORY_API_KEY`, `FACTORY_MODEL_ID`, and the
installed Droid executable (`DROID_EXEC_PATH`, default `droid`). Both worker
providers reject missing key/model before claiming work. Import recovery works
without model credentials. Optional `MATCHING_TIMEOUT_SECONDS` (default 120)
and `INVESTIGATION_TIMEOUT_SECONDS` (default 180) must be positive and at most
600 seconds; investigation includes provider startup in its deadline.

## Docker

The existing agents Dockerfile installs this package and the pinned Droid CLI:

```sh
docker build -f backend/agents/Dockerfile -t afterhours-agents .
```

Use command `afterhours-orchestrate` for the pipeline service, with the database
network URL and read-only mounts for gateway/worker credentials and evidence
files. The root Compose configuration supplies these through its `pipeline`
profile. The same image still supports `afterhours-matching` and
`afterhours-investigate` separately; avoid starting extra workers unintentionally.

## Recovery and leases

Import creation persists `IMPORTED` before scheduling. Each poll rescans that
state, so a crash between acceptance and scheduling does not lose work. A failed
start on one case does not prevent other imports from starting, and subsequent
polls retry it. Concurrent starts are guarded by the database reducer.

Worker implementations retain their own independent heartbeats and final lease
checks. A job failure never reports success; the existing database expiry sweep
requeues expired leases and eventually moves exhausted jobs to `RETRYABLE_ERROR`.
Jobs that fail before claiming remain queued. Each job is attempted at most once
per cycle, preventing an immediately failing job from starving other queued jobs.
The process reconnects each cycle after transport failure. SIGINT/SIGTERM stops
new work and cancels active inference; abandoned leases recover through expiry.

## Tests and injected providers

```sh
PYTHONPATH=backend/orchestrator/src backend/agents/.venv/bin/python -m unittest discover -s backend/orchestrator/tests -v
```

The synchronous `afterhours_orchestrator.pipeline.run_cycle` function accepts
separate gateway and worker SDK connections, `case_id`, `max_jobs`, and a stop
event. Tests can inject `matching_provider_factory` (returning a provider whose
`model_run` is `REPLAYED`) and `investigation_session` (an async context manager
yielding the decision function), with `investigation_model_run='REPLAYED'`.
Provider injection runs the existing worker code and database transitions;
it does not bypass leases or create an extraction implementation.

Offline tests cover scoped import recovery, per-case error isolation, bounded
dispatch, missing configuration, provider startup deadlines, shutdown, calculation
eligibility, month-end dates, no-change outcomes, retry and resume idempotency.
The root integration smoke uses explicit replay fixtures against the
real local database; ordinary test runs never invoke paid inference.
