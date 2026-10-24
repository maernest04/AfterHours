# Backend

Application services use Python and separate local Docker containers. The API and
SpacetimeDB are configured in Compose. Provider integrations and continuous
worker services remain to be built.

- [API](api/README.md): four Python route stubs with success/error contracts.
- [Database and SDK](db/README.md): durable state, Python access helpers and tools.
- [Agents](agents/README.md): read-only evidence tools; role handlers remain pending.
- [Orchestrator](orchestrator/README.md): worker coordination and proposal handoff.
- [Data pipeline](data_pipeline/README.md): structured import and evidence parsing.

## Boundaries

Only the SpacetimeDB module remains TypeScript. Python's `afterhours_db` package
provides document/file storage, CSV/JSON parsing, imports, case/mailbox queries,
worker leases and agent tools. Workers use persistent WebSocket reducer calls to
hold leases, with fresh HTTP reads; no realtime replica/subscription cache is
implemented. Owner credentials are setup-only; services use their gateway/worker
tokens. The browser never receives database credentials.

Reducers enforce caller, company, revision, lease and evidence checks. Agents may
propose facts and matches but cannot approve, export or change policy. Model
provider calls belong in Python workers, never inside the database module.

The public API still validates inputs and returns explicit 501 errors. Connecting
it to the SDK, running actual models, calculating corrections, persisting versioned
proposals, handling approval/question emails and exporting journals remain pending.
Approval/rejection/questions use email; frontend demo controls simulate that
channel while the backend is unfinished.

SDK `JobLease` and `AgentOutput` contracts live in `db/src/afterhours_db/jobs.py`.
LLM tool I/O retains camelCase names and decimal-string IDs; Python method names
and database row dictionaries use snake_case. Money stays in integer-cent strings.
See [setup and verification](../docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md).
