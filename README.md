# AfterHours

Starter structure for a frontend and an agent-based backend. This is a folder
and documentation skeleton; application code, frameworks, and infrastructure
have not been selected yet.

## Structure

```text
AfterHours/
├── frontend/
│   ├── src/
│   │   ├── components/       # Reusable UI components
│   │   ├── pages/            # Application screens
│   │   └── services/         # Backend API clients
│   └── public/               # Static assets
└── backend/
    ├── agents/               # Individual workers and tool integrations
    │   ├── implementations/
    │   ├── tools/
    │   └── prompts/
    ├── orchestrator/         # Workflow execution and task coordination
    │   ├── workflows/
    │   ├── scheduling/
    │   └── state/
    ├── data_pipeline/        # Data ingestion, transformation, and delivery
    │   ├── connectors/
    │   ├── transforms/
    │   └── jobs/
    ├── db/                   # Persistence definitions and access
    │   ├── models/
    │   ├── migrations/
    │   └── repositories/
    └── control_plane/        # API, configuration, and operational controls
        ├── api/
        ├── config/
        └── policies/
```

## Intended flow

The frontend sends requests to the control plane. The control plane validates
requests and submits runs to the orchestrator. The orchestrator schedules agents
and pipeline jobs, tracks their state, and records results through the database
layer. The frontend retrieves run status and results through the control plane.

See [frontend responsibilities](frontend/README.md) and
[backend boundaries](backend/README.md) for details.

## Getting started

Choose frontend and backend runtimes, then implement a small path through the
system: a health endpoint, a single agent workflow, persisted run status, and a
frontend screen to start and inspect a run. Add dependency manifests and run
commands when those runtimes are selected.
