# Frontend

Owns the user interface for uploading work, starting reviews, and viewing status
and results.

- `src/components/`: reusable visual and interaction components.
- `src/pages/`: screens such as a run dashboard, run details, and evidence.
- `src/services/`: API clients and transport handling for the Python backend API.
- `public/`: static assets served directly to the browser.

Communicate with the backend through the Python backend API. Keep credentials,
database access, agent execution, and workflow decisions on the backend.

No frontend framework or build tooling is configured yet.

Run the frontend in its own local Docker container and call the Python backend
API. Container configuration has not been added yet.
