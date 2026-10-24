# Orchestrator

The orchestrator will run as a Python service, coordinating the API and model
workers. `workflows/`, `scheduling/` and `state/` are extension points; a running
orchestrator is not implemented yet.

## Existing database workflow

The queue and stage transitions already live in the SpacetimeDB module's
`pipeline.ts`. Reuse these through the Python SDK:

- Jobs move `QUEUED` → `RUNNING` → `SUCCEEDED` or `FAILED`. There is no
  `CANCELLED` state. A stable case/revision/role key prevents duplicate jobs.
- `claim_job` atomically assigns a lease and records its connection ID.
  Heartbeat/completion require the worker identity, current revision, RUNNING
  status, matching lease token and unexpired lease. They do not separately check
  connection ownership. Keep one worker SDK connection open throughout the job.
- Leases default to 30 seconds. A scheduled sweep runs every two seconds,
  requeues expired work, and fails the job after three attempts, moving the case
  to `RETRYABLE_ERROR`. `JOB_LEASE_SECONDS` and `JOB_MAX_ATTEMPTS` are applied by
  `afterhours-db bootstrap`.
- EXTRACTION completion queues MATCHING. MATCHING queues INVESTIGATION when
  unresolved questions remain. INVESTIGATION with open questions sets
  `WAITING_FOR_INPUT`. Otherwise the case awaits the future proposal stage.
- `afterhours_db.cases.is_awaiting_proposal(db, case_id)` identifies that handoff:
  the case is MATCHING/INVESTIGATING and every current-revision job succeeded.

## Worker integration

Use `AfterHoursDB.connect("worker")` with
`afterhours_db.jobs.list_claimable_jobs`, `claim_job`, `heartbeat_job` and
`complete_job`. It keeps a JSON WebSocket for worker reducer calls because a
claim requires `ctx.connectionId`. Reads use fresh authenticated
HTTP queries. There are no SDK subscription caches or view-event callbacks;
poll jobs and case state explicitly. Gateway operations use HTTP.

The [agent README](../agents/README.md) shows the Python integration and model
contracts. Keep heartbeats running during inference, treat a failed renewal as
lost ownership, and record real model runs as `LIVE` or fixture replays as
`REPLAYED`. The backend seed queues one EXTRACTION job on a fresh database.

## Remaining work

- Extraction worker and broader orchestration/concurrency. Investigation has a
  case-scoped worker in `afterhours_investigation`.
  MATCHING now has a single-job Python polling loop, independent heartbeats,
  bounded Factory calls and graceful shutdown in `backend/agents`.
- API workflow integration; listing works, create/get/export remain explicit 501 stubs.
- Connect the implemented gateway `build_proposal` calculator to scheduling;
  clarification/exception handling, authoritative reviewer decisions and CSV export remain.
- Revision bumps and invalidation when inputs change. Existing revision checks
  reject stale work, but changing inputs does not yet bump a case revision or
  cancel its old jobs/proposals automatically.

Future services must keep database credentials server-side. The frontend calls
the API; it does not connect to SpacetimeDB with gateway or worker tokens.
