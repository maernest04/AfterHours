# Python review API

FastAPI data plane backed by the existing service-authorized `afterhours_db` SDK.
The public surface remains four routes:

- `POST /create-review`: multipart file fields named `files` only; returns 202
  with the persisted decimal-string `review_id`, generated `idempotency_key`,
  and the `IMPORTED` acceptance milestone.
- `GET /list-review`: optional `limit` (1–10, default 10) and opaque `cursor`.
- `GET /get-review`: decimal `review_id`; optional `live=true` and
  `after_sequence` for polling SSE on the same route.
- `GET /export-review`: remains **501 NOT_IMPLEMENTED** until current
  revision/hash-bound email approval and export validation are implemented.

There are no approval, question, settings, update or delete routes. Email remains
the existing mock workflow; this API does not connect a real mailbox.

## File-only import contract

All classification and structured validation finishes before file or database
writes. Filenames never determine document type. The API supports UTF-8 (optional
BOM), a combined file size of at most 10 MiB, and these content formats:

1. Exactly one accrual JSON object, with `entryId`, `vendorId`, `status`
   (`DRAFT` or `POSTED`), `postingPeriod` (`YYYY-MM`), `servicePeriod`
   (`{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}`), `currency: "USD"`, and
   either `amountCents` (canonical integer cents) or `amount` (exact dollars,
   up to two decimal places). Duplicate JSON keys and dual amount fields fail.
2. A plain-text contract whose first nonempty line is `MASTER SERVICES AGREEMENT`
   or `CONTRACT`. An optional first line exactly matching the bundled fixture's
   `SYNTHETIC DEMO DOCUMENT - NOT A REAL CONTRACT` marker is ignored.
3. Timesheet CSV with `service_date,contractor,approved_minutes,status` columns.
   Optional SDK columns include `billing_rate` and `approved_by`.
4. Invoice CSV with `invoice_number,contractor,service_start,service_end,minutes,
   amount,posting_status` columns. Posted rows also need a valid `posted_date`.
5. Ledger CSV with `entry_id,vendor_id,period,kind,amount,status` columns.
   Optional `description` is retained by the SDK.

All five document categories are required. Additional structured files of the
same type are allowed except accrual; headers are case-insensitive and their
order is flexible. Header-only CSVs are valid, including the no-invoice scenario.
CSV headers must be unique, row widths must match, and exactly one supported
schema must match. Approved timesheet rows cannot duplicate a contractor/date
within the batch. Date, date-range, status, amount and minute validations run
before persistence. Duplicate byte contents are rejected.

Optional amendment text starts with `AMENDMENT` or
`AMENDMENT NO. <number> TO MASTER SERVICES AGREEMENT`, with the same optional
synthetic marker. Arbitrary text, generic JSON, ambiguous CSV, PDF/OCR imports,
and inference from filenames are unsupported and return 422. Unsupported MIME
types return 415. File names must be nonempty and at most 255 UTF-16 code units.
FastAPI parses multipart bodies before checking file sizes; a production ingress
body limit is not implemented.

Neither IDs nor metadata/status fields are accepted from the client. The SDK
stores original bytes and their hashes, creates structured evidence through its
existing parsers, and finalizes the case atomically. The generated import key is
persisted on the case. A preexisting accrual source entry returns 409 before any
uploads. Concurrent submissions still rely on the database's unique source-entry
constraint; a racing reducer failure returns a sanitized 503.

The `IMPORTED` case is durable pending work. The pipeline sweeper discovers it
and invokes `start_review`, so processing survives an API restart between import
and scheduling. The create response describes the import milestone; a fast
worker may already have advanced the case by the time the response arrives.
Use get-review for the current state. Running only the API does not run workers.

Storage writes span multiple SDK calls. Validation failures create no files or
rows, but storage failure after uploading can leave unlinked documents/blobs.
A timed-out finalization may already have committed. The API does not promise
transactional rollback or client-directed idempotent retry: inspect list/get
before resubmitting an uncertain outcome; the persisted source entry is unique.

## Persisted detail and live updates

Get returns actual case status, revision, timestamps, original metadata and
blockers. A current proposal supplies its exact integer-cent strings, hash,
entry date, currency, and journal lines. Missing proposal values remain null.
Evidence is the current revision's persisted fact references (`fact:<id>`),
document IDs, source locations and excerpts, ordered by numeric fact ID.
A missing or stale current proposal is a storage error, not an invented result.

Journal references use the persisted accrual source entry. Descriptions are empty
because proposals do not store descriptions. `history` remains empty because the
schema does not persist review-action history; mailbox messages are not treated
as approvals. `export_amount_cents` is the proposal's calculated export amount,
not an indication that export is authorized. Actual export stays 501.

Joined reads retry up to three times when the case record changes while reading
facts/proposals. This reduces transition races; it is not a transactional snapshot
across all views. Unsupported stored records produce sanitized 503 errors.

The `sequence` is `v1:<sha256>` of the canonical response content, so identical
snapshots have identical cursors and changed visible content changes the cursor.
`live=true` sends an immediate `snapshot`, followed by `review.updated` whenever
one-second polling detects changed content. Each SSE data payload is a complete
get response; its event ID equals `sequence`. Unchanged polls send comments as
heartbeats. `after_sequence` requires `live=true` and a valid cursor shape.
Every connection, including resume, resynchronizes with a current snapshot.
There is no durable event log: intermediate transitions can be missed and are
not replayed. Invalid/missing reviews fail before streaming headers are sent.
A later storage failure terminates the stream; clients can reconnect.

Each polling read closes its gateway client before yielding. Disconnect cancels
the async generator; there is no persistent database subscription. An in-flight
synchronous SDK call may finish under its bounded timeout before cleanup.

## Runtime and testing

The default dependency opens `AfterHoursDB.connect("gateway")` per operation.
Synchronous SDK and parsing work runs outside the async event loop. Configuration
uses `SPACETIMEDB_URI`, `SPACETIMEDB_DATABASE`, `COMPANY_ID`,
`SPACETIMEDB_SECRETS_DIR` and `FILE_STORE_DIR`. The registered gateway token is
required; requests never bootstrap identities or read an owner token. The API
needs a writable persistent file-store volume shared with workers. See the
[SDK README](../db/README.md) for bootstrap.

From the repository root:

```sh
docker compose up --build -d api
```

Open `http://localhost:8000/docs`; set `API_PORT=8001` if needed. API success
contracts, examples, and error codes are published in OpenAPI. Errors include
422 validation, 413 size, 415 MIME type, 409 duplicate source, 404 missing review,
503 unavailable storage, and 501 pending export.

For Python 3.12+ development:

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r backend/api/requirements-dev.txt
.venv/bin/python -m uvicorn backend.api.main:app --reload
.venv/bin/python -m unittest discover -s backend/api/tests -v
```

The route-contract tests can also target a running API using
`AFTERHOURS_API_URL=http://127.0.0.1:8001`. SDK integration tests use real SDK
upload/read/finalize logic and a temporary file store, replacing only the remote
reducer/query boundary. Tests cover prevalidation before writes, import metadata,
duplicate source protection, empty invoices, exact proposal amounts, stale
proposals, stable sequences, polling updates/cleanup, and list pagination.
They do not substitute for Docker/SpacetimeDB end-to-end verification.
