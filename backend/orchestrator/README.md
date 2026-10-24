# Orchestrator

Own workflow execution from submission through completion, failure, or
cancellation. Coordinate agents and pipeline jobs without embedding their
task-specific logic.

- `workflows/`: workflow definitions, task dependencies, and routing rules.
- `scheduling/`: dispatch, concurrency limits, retry policies, and timeouts.
- `state/`: run/task lifecycle transitions and persisted progress tracking.

Suggested run states: `queued`, `running`, `succeeded`, `failed`, `cancelled`.
Define valid transitions when implementation begins.

Accept validated requests from the control plane, dispatch ready tasks, and
persist status/results using database repositories. Plan for duplicate task
delivery, recovery after restarts, and cancellation of in-flight work.
