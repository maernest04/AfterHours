# AfterHours

Accrual correction assistant (Cal Hacks 13). The repo has a frontend and an
agent-based backend. Implemented so far: SpacetimeDB document storage
(`backend/db`) and control-plane request validation (`backend/control_plane`).
The rest of the tree is still a skeleton.

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

### Database (SpacetimeDB document storage)

The database layer is implemented and runs locally. Follow
[docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md](docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md).
In short:

```powershell
npm install; npm run db:install
spacetime start                      # separate terminal, leave running
npm run db:publish; npm run db:generate; npm run db:bootstrap; npm run db:seed; npm run smoke   # expect 14/14
```

Progress notes: [docs/SPACETIME_DB_PROGRESS.md](docs/SPACETIME_DB_PROGRESS.md).

### Control plane

Request validation and the `DataPlane` interface live in
[backend/control_plane](backend/control_plane/README.md). Run its tests from that folder
with `npm test` (requires Node 22.18+).

### Not built yet

The agents (extraction, matching, investigation), orchestrator, accounting
calculations, review UI and exports.
