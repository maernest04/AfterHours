# Backend

Application services use Python and separate local Docker containers. The API and
SpacetimeDB are configured in Compose. The optional `matching` service runs the
Factory matching worker. Investigation and a gateway calculator are also implemented;
extraction remains separate work.

- [API](api/README.md): DB-backed paginated listing and typed service seams; three operations remain stubs.
- [Database and SDK](db/README.md): durable state, Python access helpers and tools.
- [Agents](agents/README.md): matching worker, synthetic cases, replay E2E and read-only evidence tools.
- [Approval watcher](approval_watcher/README.md): version-bound email evaluator and explicit mock runtime; authoritative adapters pending.
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

The public API lists reviews from the SDK; create/get/export still return explicit
501 errors. Matching and investigation workers and a gateway calculator are present.
Connecting the full workflow, authoritative email decisions and journal export remain pending.
Approval/rejection/questions use email; frontend demo controls simulate that
channel while the backend is unfinished.

SDK `JobLease` and `AgentOutput` contracts live in `db/src/afterhours_db/jobs.py`.
LLM tool I/O retains camelCase names and decimal-string IDs; Python method names
and database row dictionaries use snake_case. Money stays in integer-cent strings.
See [setup and verification](../docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md).
