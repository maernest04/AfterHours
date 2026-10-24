# Orchestrator

This Python service polls the existing SpacetimeDB workflow. It recovers accepted
`IMPORTED` cases with `start_review`, then dispatches the merged EXTRACTION,
MATCHING and INVESTIGATION workers. Database jobs, leases, revision checks and stage reducers
remain the only workflow state; there is no second queue or state store.

Current boundaries are intentional:

- EXTRACTION (Bitdeer) runs only when `BITDEER_API_KEY` is set (the CLI enables it). Without it,
  imported cases enter `EXTRACTING` with a queued job and stay there, reported as
  `blocked`; extraction is never faked. With it, the cycle claims EXTRACTION jobs,
  and MATCHING then follows through the normal database transitions.
- Existing extracted fixtures can run MATCHING and, when questions remain,
  INVESTIGATION. Investigation reads the existing mock mailbox through scoped
  `AgentTools`; no real email integration or sending is enabled.
- Resolved cases stop at the proposal handoff. The in-progress calculator is
  never called by this service. Open questions remain `WAITING_FOR_INPUT`.
- Every completed model job retains `LIVE` or `REPLAYED` provenance. The service
  has no automatic replay or synthetic success fallback.

## Run locally

From the repository root, after the normal database bootstrap:

```sh
uv run --project backend/orchestrator afterhours-orchestrate
```

The default process polls every two seconds, attempting at most ten queued
worker jobs per cycle. A bounded, case-scoped invocation is:

```sh
uv run --project backend/orchestrator afterhours-orchestrate --once --case-id 123 --max-jobs 2
```

`--once` performs one import-recovery pass and at most `--max-jobs` worker
attempts, then exits. Newly queued investigation jobs can run in the same cycle
if the budget permits. It exits with status 1 when any attempt or poll fails;
an unavailable extraction/proposal stage is reported as `blocked`, never as a
completed job. `--case-id` scopes both import recovery and job dispatch.

The JSON report contains started case IDs, completed job summaries, errors by
type, and blocked extraction/proposal handoffs. Exception payloads and model
output are excluded from service logs.

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
dispatch, missing configuration, provider startup deadlines, shutdown and honest
handoffs. The root integration smoke uses explicit replay fixtures against the
real local database; ordinary test runs never invoke paid inference.
