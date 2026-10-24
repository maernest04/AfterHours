# Backend

The backend is divided into five logical areas. These can begin in one process;
the folders do not require separate deployed services.

- [Agents](agents/README.md) execute individual units of work.
- [Orchestrator](orchestrator/README.md) coordinates workflows and run state.
- [Data pipeline](data_pipeline/README.md) prepares and delivers input data.
- [Database](db/README.md) owns durable storage and persistence access.
- [Control plane](control_plane/README.md) exposes APIs and governs execution.

## Boundaries

The control plane is the frontend-facing entry point. It calls the orchestrator
to start, inspect, or cancel runs. The orchestrator dispatches agent tasks and
pipeline jobs. Agents and pipeline jobs use database repositories when they
need persistence. The database layer does not invoke workflows or agents.

## Contracts to define during implementation

- Run request: workflow identifier, input, and caller context.
- Task: run identifier, task identifier, agent or job type, input, and limits.
- Task result: status, output references, errors, and execution metadata.
- Run status: current state, task progress, timestamps, and result references.
- Pipeline record: source identifier, schema version, payload, and provenance.

Keep these contracts explicit at component boundaries. No runtime, queue,
database engine, or external provider is configured in this skeleton.
