# AfterHours

Accrual correction assistant (Cal Hacks 13). The repo has a frontend and an
agent-based backend. Implemented so far: SpacetimeDB document storage
(`backend/db`) and a runnable Python API scaffold (`backend/api`).
The remaining application logic is still a skeleton.

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
    ├── api/                  # Python FastAPI routes and Docker service
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
    └── db/                   # Persistence definitions and access
        ├── models/
        ├── migrations/
        └── repositories/
```

## Intended flow

The Python API stubs validate request parameters; backend service integration
is still to be connected. The public API has four operations: `create-review`
(upload and start), `list-review`, `get-review` (including live updates), and
`export-review`. Approvals, rejections and questions are handled through email.
Workflow execution and state-dependent checks belong in backend functions and
SpacetimeDB reducers. The handlers return explicit 501 responses until backend integration is implemented.

See [frontend responsibilities](frontend/README.md) and
[backend boundaries](backend/README.md) for details.

## Runtime direction

- Application backend services use **Python**, including the API, agent workers,
  orchestration and data pipeline.
- Each service runs in its own **local Docker container**, including the frontend,
  Python backend services and SpacetimeDB. Docker Compose will coordinate local
  startup and service networking. The API container is configured; the other
  service containers are still to be added.
- The newly added TypeScript SpacetimeDB module, generated bindings and Node
  document-storage tooling remain intact. They are the current database setup,
  not a choice of TypeScript for the application backend. Python integration is
  still to be implemented.

## Getting started

### Python API

Run `docker compose up --build -d api` and open `http://localhost:8000/docs`.
Use `API_PORT=8001` if port 8000 is occupied. See [API setup and tests](backend/api/README.md).

### Database (SpacetimeDB document storage)

The database layer is implemented and runs locally. Follow
[docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md](docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md).
In short:

```powershell
npm install; npm run db:install
spacetime start                      # separate terminal, leave running
npm run db:publish; npm run db:generate; npm run db:bootstrap; npm run db:seed; npm run smoke   # expect 13/13
```

Progress notes: [docs/SPACETIME_DB_PROGRESS.md](docs/SPACETIME_DB_PROGRESS.md).

### Not built yet

The agents (extraction, matching, investigation), orchestrator, accounting
calculations, API database integration, live streaming, review UI, email review
flow and exports.
