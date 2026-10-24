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

## Boundaries

Python API handlers validate parameters. Direct backend service calls are TODOs
in the handlers. The orchestrator coordinates agent tasks and pipeline jobs; database
reducers own atomic persistence and state-dependent checks. Approval, rejection
and questions flow through email. There is no separate API abstraction package.

## Contracts to define during implementation

- Run request: workflow identifier, input, and caller context.
- Task: run identifier, task identifier, agent or job type, input, and limits.
- Task result: status, output references, errors, and execution metadata.
- Run status: current state, task progress, timestamps, and result references.
- Pipeline record: source identifier, schema version, payload, and provenance.

Keep these contracts explicit at component boundaries. SpacetimeDB document storage is implemented; the API is a runnable stub and
the other backend areas remain skeletons.

The existing TypeScript SpacetimeDB module and Node storage tooling remain the
database foundation. Python service integration is planned; this cleanup does
not rewrite the storage implementation.
