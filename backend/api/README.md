# Python review API

Small FastAPI data-plane scaffold. Four routes live in `main.py`, integration
seams in `service.py`, and the read-only SDK adapter in `repository.py`.
`list-review` reads actual database case summaries. The remaining operations
retain explicit 501 responses until their complete response contracts can be met.

- `POST /create-review`: multipart `files` only (one or more).
  The data plane generates and persists `review_id` and
  `idempotency_key`, then returns both in the response. Neither ID is a request
  field. Upload and start are one operation; generation/persistence remain TODOs
  while the route returns the explicit 501 stub response.
- `GET /list-review`: cursor pagination with optional `limit` (1–10, default 10)
  and `cursor`. Reads service-authorized `cases_view` through `afterhours_db` and
  returns the next cursor, or null on the last page.
- `GET /get-review`: `review_id`, optional `live` and `after_sequence`. Live
  updates will use this same route; a resume cursor requires `live=true`.
- `GET /export-review`: only `review_id`. The backend finds the current proposal,
  verifies its stored email approval is still valid, and returns the approved CSV.

**Create, get (including live), and export return HTTP 501 with `NOT_IMPLEMENTED`.** Input
validation is active, including supported upload MIME types, nonempty files and
10 MiB combined file size. Files are parsed by FastAPI before size checks; a
production ingress body limit is not implemented. The API still needs upload
classification and trusted accrual metadata inference, durable import/start
coordination, full detail projection, live streaming and approval-checked export.
No files or partial reviews are persisted by the create stub. Existing workers
and SDK capabilities are not automatically exposed as completed API operations.
There are no routes for approval/rejection, questions or settings. These actions
belong to the email workflow and server configuration.

## Integration seam

`get_review_service` is a FastAPI dependency; tests can replace it with a
`ReviewService` backed by a fake `ReviewRepository`. The default repository opens
and closes an `AfterHoursDB.connect("gateway")` client for each list read.
Synchronous SDK work runs in the thread pool, outside the async event loop.
The gateway uses existing SDK configuration (`SPACETIMEDB_URI`,
`SPACETIMEDB_DATABASE`, `COMPANY_ID`, `SPACETIMEDB_SECRETS_DIR`, `FILE_STORE_DIR`)
and the registered gateway token. It never bootstraps identities or reads an
owner token on a request. Database bootstrap remains a separate setup step in
the [SDK README](../db/README.md).

Case IDs become decimal-string `review_id` values. State and UTC timestamps map
directly from stored records; unsupported records return 503 rather than an
invented status. Listing sorts by numeric case ID and uses a versioned opaque
cursor carrying the last ID. Pagination currently reads the authorized cases
into Python, so this is intended for the local MVP, not large datasets. Pages
reflect fresh reads and are not a point-in-time snapshot. Invalid cursors return
422 before any database query; missing configuration, credentials, connectivity
or invalid stored rows return sanitized `STORAGE_UNAVAILABLE` errors with 503.

The typed `ReviewUpload`, snapshot/stream and `ReviewCSV` service methods mark
the remaining connection points. Creating a review must infer source metadata,
generate and persist its idempotency key server-side, and coordinate import and
start without requiring client metadata. Get needs the complete proposal,
evidence, email history and update sequence; an isolated case read is insufficient.
Export must check approval against the current proposal revision/hash and blockers.

## Success responses

These are the intended successful outputs, defined in `responses.py` and shown
in Swagger at `/docs`. List is implemented; the other success contracts remain
targets and still raise **501 Not Implemented**. All examples use synthetic data.

### POST /create-review — 202 Accepted, application/json

```json
{
  "review_id": "review-1",
  "idempotency_key": "generated-key-1",
  "status": "IMPORTED"
}
```

Both IDs are generated and stored by the data plane. Accepted means the files
and review were saved and processing can continue; it does not mean the review
has completed.

### GET /list-review — 200 OK, application/json

```json
{
  "items": [
    {
      "review_id": "review-1",
      "status": "APPROVED",
      "created_at": "2026-10-23T18:00:00Z",
      "updated_at": "2026-10-23T18:10:00Z"
    }
  ],
  "next_cursor": null
}
```

A page contains at most `limit` items (default and maximum 10). Supply a non-null
`next_cursor` as the next request's `cursor`; null means there are no more pages.
An empty result is `{ "items": [], "next_cursor": null }`.

### GET /get-review — 200 OK, application/json or text/event-stream

The JSON `GetReviewResponse` contains:

- `review_id`, `status`, `created_at`, `updated_at`, `sequence`, `input_revision`.
- `currency` (`USD`) and inferred `original_status` (`DRAFT`, `POSTED` or null).
- `original_amount_cents`, `corrected_target_cents`, `difference_cents`,
  `export_amount_cents`: signed integer-cent strings, or null until known.
- `proposal_id` and `proposal_hash`: null until a proposal exists.
- `journal_lines`: entry date/reference, account code/name, debit/credit cents,
  currency and description for each line.
- `evidence`: evidence/document IDs, page or row reference, and source excerpt.
- `history`: timestamps, actions, actors, email IDs, summaries and evidence IDs.
- `blockers`: outstanding reasons that prevent correction/export.

Unknown amounts stay null, not zero. Lists are empty until their data exists.
No-change reviews use `VERIFIED_NO_CHANGE` and have no correction journal to
export. API money is always exact integer cents as strings. The synthetic
posted-entry example in Swagger has original `"700000"`, corrected target
`"770000"`, difference/export amount `"70000"` and two balanced journal lines.

With `live=true`, the same URL returns `text/event-stream`. The first event is
`snapshot`; later events are `review.updated`. Each `data` value is a complete
`GetReviewResponse`, and `id` equals its `sequence`. Resume with `after_sequence`
from the last received event. The backend must provide a consistent snapshot and
subsequent updates and release its subscription when the client disconnects.
Full JSON and SSE examples are available in Swagger.

### GET /export-review — 200 OK, text/csv

The successful response is a file, not a JSON wrapper. It includes
`Content-Disposition: attachment; filename="review-1.csv"` and CSV content:

```csv
entry_date,reference_id,account_code,account_name,debit,credit,currency,description
2026-10-23,review-1,6000,Contractor expense,700.00,0.00,USD,Synthetic accrual correction
2026-10-23,review-1,2100,Accrued liabilities,0.00,700.00,USD,Synthetic accrual correction
```

Dollar values have two decimal places. Quote CSV fields correctly and sanitize
spreadsheet formulas when export is implemented. The backend checks current
email approval and blockers; stale/unapproved/no-change reviews cannot export a
correction. Exporting never marks an entry posted.

### Errors

Swagger lists 501 separately for the three pending operations. Their response is:

```json
{
  "detail": {
    "code": "NOT_IMPLEMENTED",
    "operation": "create-review",
    "message": "Backend integration is not connected yet."
  }
}
```

Malformed requests return 422; unsupported uploads return 415; excessive upload
size returns 413. The get/export contracts reserve 404 for missing reviews, and
export reserves 409 for no current approved correction or outstanding blockers.
Those get/export errors remain unimplemented along with their success behavior.
List returns 503 when its repository is unavailable; it does not disguise an
unavailable database as a successful empty list.

## Docker

From the repo root:

```sh
docker compose up --build -d api
```

Open `http://localhost:8000/docs` for interactive API documentation. If that port
is occupied, use `API_PORT=8001 docker compose up --build -d api` and open
`http://localhost:8001/docs`. Stop with `docker compose stop api`.

The Docker build uses the repository root as its context and
`backend/api/Dockerfile`, installing requirements and the local database SDK with
`uv` (pinned to 0.9.24). The API runs as its own container. Its runtime needs the
SpacetimeDB URL and a read-only gateway token mount readable by UID 10001;
`SPACETIMEDB_SECRETS_DIR` must name that mount's parent directory. Listing does
not read or write document files. The image does not contain credentials.

## Local development and tests

Python 3.12+, from the repo root:

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r backend/api/requirements-dev.txt
.venv/bin/python -m uvicorn backend.api.main:app --reload
```

Run tests directly against the app:

```sh
.venv/bin/python -m unittest discover -s backend/api/tests -v
```

Run the route-contract tests over HTTP against the running Docker container
(repository/service tests still run locally with injected test doubles):

```sh
AFTERHOURS_API_URL=http://127.0.0.1:8001 .venv/bin/python -m unittest discover -s backend/api/tests -v
```

These checks cover route names, file-only multipart requests, upload limits,
live-update options, stub boundaries, actual SDK query mapping, timestamp and
large-ID precision, cursor pagination, connection cleanup and 503 behavior.
The deterministic integration tests inject an SDK client or repository and need
no running database, model key or mailbox. They do not prove a completed
accounting workflow: the API does not yet persist reviews, process email, stream
updates or produce an approved CSV.
