# Backend

The application backend uses Python. Each runtime service runs in its own local
Docker container. Docker Compose currently starts the API; other service
containers are still to be added. The folders
below describe responsibilities, not necessarily one container per folder.

- [API](api/README.md) exposes the four Python review route stubs.
- [Agents](agents/README.md) execute individual units of work.
- [Orchestrator](orchestrator/README.md) coordinates workflows and run state.
- [Data pipeline](data_pipeline/README.md) prepares and delivers input data.
- [Database](db/README.md) owns durable storage and persistence access.

## Current state

| Area | State |
|---|---|
| Database (SpacetimeDB): documents, cases and import, evidence, mock mailbox, job queue with leases | Done and tested (`npm run smoke`, 23 checks) |
| Read-only agent tools | Done, in TypeScript (`agents/tools`) |
| Python API | Four stub routes: they validate input and return 501 |
| API ↔ database connection | Not built. Python calls SpacetimeDB over HTTP, which is verified: see [setup guide §10](../docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md) |
| Agent worker loop, role handlers, prompts | Not built |
| Calculator, `build_proposal`, questions, approval, export | Not built |

Start with the [setup guide](../docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md) (run it in §0) and the
[progress log](../docs/SPACETIME_DB_PROGRESS.md).

## Boundaries

Python API handlers validate parameters and call the database. The orchestrator
coordinates agent tasks and pipeline jobs. **Database reducers own atomic persistence
and every state-dependent check**: who may call (owner, gateway or worker identity),
company scope, revision and lease checks, evidence scope, and approval. Services
authenticate to SpacetimeDB with their own identity and read only through the
caller-filtered `*_view` tables; the model providers are called from the worker,
never from the database. Agents can propose facts and matches but cannot approve,
export or change policy. There is no separate API abstraction package.

Approval, rejection and questions: the API README says they flow through email, while
the implementation brief says a reviewer screen. The database accepts them from the
gateway identity either way. **The team should decide which and update the docs.**

## Contracts

Already defined (keep them stable; extend instead of changing):

- **Job and lease** (`JobSummary`, `JobLease`) and **agent output** (`AgentOutput`,
  `CandidateMatch`): `db/repositories/contracts.ts`. Every worker call carries the case
  revision, and a stale one is rejected.
- **Case, fact, evidence and job tables:** [setup guide §7](../docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md).
  Money is integer-cent strings, dates are `YYYY-MM-DD`, and evidence references are
  `doc:N`, `fact:N` and `email:N`.
- **API request and response shapes:** [api/README.md](api/README.md).

Still to define:

- Run request: workflow identifier, input, and caller context (the API's `create-review`
  covers the first version).
- Proposal and review records (arrive with `build_proposal`).
- Pipeline record: source identifier, schema version, payload, and provenance.

## Database foundation

The SpacetimeDB module (`db/spacetime`), its generated bindings and the Node tooling
(seed, smoke test, repositories) are TypeScript and stay that way. The Python
services use the database over plain HTTP with their gateway or worker token; the
reducers and views are language-neutral.
