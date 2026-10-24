# Orchestrator

Own workflow execution from submission through completion, failure, or
cancellation. Coordinate agents and pipeline jobs without embedding their
task-specific logic.

- `workflows/`: workflow definitions, task dependencies, and routing rules.
- `scheduling/`: dispatch, concurrency limits, retry policies, and timeouts.
- `state/`: run/task lifecycle transitions and persisted progress tracking.

Accept validated requests from the Python API handlers, dispatch ready tasks, and
persist status/results using the database. Plan for duplicate task
delivery, recovery after restarts, and cancellation of in-flight work.

Implement the orchestrator in Python and run it in a local Docker container.

## What the database already does (don't rebuild it)

The job queue lives in SpacetimeDB (`backend/db/spacetime/spacetimedb/src/pipeline.ts`):

- **Job statuses:** `QUEUED` → `RUNNING` (leased) → `SUCCEEDED` or `FAILED`. These replace
  the earlier suggested states. There is no `CANCELLED` status yet.
- **Job identity:** the job key is `caseId:revision:role`, so creating a job twice is a no-op.
  The roles are `EXTRACTION`, `MATCHING` and `INVESTIGATION`.
- **Leases:** `claim_job` hands a queued job to exactly one worker. The default lease is
  30s, extended by `heartbeat_job`. A worker whose lease expired cannot complete the job.
- **Retries:** a sweep runs every 2s. It requeues expired leases, and after 3 attempts the job
  becomes `FAILED` and the case becomes `RETRYABLE_ERROR`. Tune this with `JOB_LEASE_SECONDS`
  and `JOB_MAX_ATTEMPTS`, applied by `npm run db:bootstrap`.
- **Duplicate and stale delivery:** every worker call carries the case revision, and a stale
  revision is rejected.
- **Stage advancement:** `complete_job` advances the case today. EXTRACTION done queues
  MATCHING. MATCHING done queues INVESTIGATION if the agent reported unresolved questions.
  INVESTIGATION done with questions still open sets `WAITING_FOR_INPUT`. Otherwise the case
  waits for `build_proposal`; `isAwaitingProposal()` in `db/repositories/cases.ts` reports
  when. **If you want orchestration to own this routing, say so and it moves out of
  `complete_job`.**

## What's still to build here

- **The worker loop:** find queued jobs, claim, heartbeat, run the role, complete. Python does
  this over HTTP, verified in [setup guide §10](../../docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md).
  A TypeScript reference loop is in [../agents/README.md](../agents/README.md).
- **Triggering `build_proposal`** when a case is awaiting it (the reducer doesn't exist yet).
- **Revision bumps and cancellation:** when a case's inputs change (for example a new document
  version), the case revision should increment, the old proposal should be superseded, and queued
  or leased jobs for the old revision should be cancelled. **Nothing bumps the revision yet.**
  Stale work is already rejected, but cancelling it is not built.
- **Concurrency limits and backoff** between retries (the database only bounds the attempt count).
