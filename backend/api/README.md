# Python review API

Small FastAPI data-plane scaffold. Four routes live in `main.py`; connect the
backend functions directly where the TODOs are. There is no separate dispatcher
or control-plane package.

- `POST /create-review`: multipart `files` only (one or more).
  The data plane generates and persists `review_id` and
  `idempotency_key`, then returns both in the response. Neither ID is a request
  field. Upload and start are one operation; generation/persistence remain TODOs
  while the route returns the explicit 501 stub response.
- `GET /list-review`: cursor pagination with optional `limit` (1–10, default 10)
  and `cursor`. The response will include the next cursor when database integration is added.
- `GET /get-review`: `review_id`, optional `live` and `after_sequence`. Live
  updates will use this same route; a resume cursor requires `live=true`.
- `GET /export-review`: only `review_id`. The backend finds the current proposal,
  verifies its stored email approval is still valid, and returns the approved CSV.

**All valid requests currently return HTTP 501 with `NOT_IMPLEMENTED`.** Input
validation is active, including supported upload MIME types, nonempty files and
10 MiB combined file size. Files are parsed by FastAPI before size checks; a
production ingress body limit is not implemented. Content extraction, persistence,
review execution, live streaming, email decisions and CSV export are TODOs.
There are no routes for approval/rejection, questions or settings. These actions
belong to the future email workflow and server configuration.

## Success responses

These are the intended successful outputs, defined in `responses.py` and shown
in Swagger at `/docs`. The stub handlers still raise **501 Not Implemented**;
501 is an error, never a successful result. All examples use synthetic data.

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

Swagger lists 501 separately for every operation. The current response is:

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
Those database-dependent errors remain unimplemented along with success behavior.

## Docker

From the repo root:

```sh
docker compose up --build -d api
```

Open `http://localhost:8000/docs` for interactive API documentation. If that port
is occupied, use `API_PORT=8001 docker compose up --build -d api` and open
`http://localhost:8001/docs`. Stop with `docker compose stop api`.

The Docker build installs requirements with `uv` (pinned to 0.9.24).
The API runs as its own container. The database, worker, orchestrator and pipeline
containers will be added as those integrations are built; this compose file
currently starts only the API.

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

Run the same tests over HTTP against the running Docker container:

```sh
AFTERHOURS_API_URL=http://127.0.0.1:8001 .venv/bin/python -m unittest discover -s backend/api/tests -v
```

These checks cover route names, file-only multipart requests, missing and
invalid parameters, single/combined upload limits, live-update request options,
and explicit stub responses. They do not prove a completed accounting workflow:
no review is persisted and no email is processed or CSV produced yet.
