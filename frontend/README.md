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

## What to build against

- **Only the Python API.** The browser never talks to SpacetimeDB or holds a service token. The
  four routes (`create-review`, `list-review`, `get-review` with optional live updates,
  `export-review`) and their response shapes are in [../backend/api/README.md](../backend/api/README.md)
  and Swagger at `http://localhost:8000/docs` (`docker compose up --build -d api`).
- **The routes are stubs today** (they return 501). Build against the documented success
  examples first and switch over when the API is connected to the database.
- **Seeded data:** `npm run db:seed` creates one demo case (Acme Contracting, a posted $7,000.00
  accrual) with an extraction job waiting. The expected result, once the calculator exists, is a
  corrected target of $7,700.00 and a $700.00 adjustment. See the root [README](../README.md).

## What the screens need (from the brief)

- **Case list and case page:** original, corrected and difference amounts, the evidence
  (document, page or row, excerpt), blockers and the history of actions.
- **Reviewer actions:** approve, reject with a reason, or ask a question; reviewer names are
  self-entered labels with no login. Approvals bind to the exact proposal version, so a stale
  proposal must be re-reviewed. **Open question:** the brief says a reviewer screen, but the API
  README says approval flows through email. Confirm with the team before building these controls.
- **Export:** a copyable journal-entry table and a CSV download. Export is not posting, and
  unchanged accruals show "Verified – no correction needed" with no export.
- **Labels:** mark all data as **SYNTHETIC**, and mark each agent result as **LIVE** or **REPLAYED**.

## Conventions

- Money is a **signed integer-cent string** (`"70000"` is $700.00); unknown amounts are `null`,
  never `0`. Format for display only.
- Case states (`IMPORTED`, `EXTRACTING`, `MATCHING`, `INVESTIGATING`, `READY_FOR_REVIEW`,
  `APPROVED`, `EXPORTED`, `WAITING_FOR_INPUT`, `VERIFIED_NO_CHANGE`, `NEEDS_REVISION`,
  `RETRYABLE_ERROR`) are described in the [setup guide §8](../docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md).
  Produced today: `IMPORTED`, `EXTRACTING`, `MATCHING`, `INVESTIGATING`, `WAITING_FOR_INPUT` and
  `RETRYABLE_ERROR`. The rest arrive with proposals and approval, in a later phase.
