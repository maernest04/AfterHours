# Frontend

Owns the user interface for configuring work, starting runs, and viewing status
and results.

- `src/components/`: reusable visual and interaction components.
- `src/pages/`: screens such as a run dashboard, run details, and configuration.
- `src/services/`: API clients and transport handling for the control plane.
- `public/`: static assets served directly to the browser.

Communicate with the backend through the control-plane API. Keep credentials,
database access, agent execution, and workflow decisions on the backend.

No frontend framework or build tooling is configured yet.
