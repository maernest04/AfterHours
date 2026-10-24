# Data pipeline

Acquire source data, validate and normalize it, and make it available to agents
and workflows with enough provenance to trace results back to their inputs.

- `connectors/`: source adapters, ingestion, and source-specific checkpoints.
- `transforms/`: validation, normalization, deduplication, and enrichment.
- `jobs/`: executable ingestion and transformation jobs dispatched by the
  orchestrator, including backfill or incremental processing.

Intended flow: source → ingest → validate → transform → persist or publish.
Use the database layer for durable records, checkpoints, and output references.

Define record schemas, freshness expectations, replay behavior, and handling of
invalid records before adding production sources. Keep scheduling decisions in
the orchestrator.

## What exists today (the import path)

The only source is uploaded files plus the seeded mock mailbox, and the import path is
already built in TypeScript:

1. **Store the file.** The gateway writes the bytes to the content-addressed file store
   (`data/files/sha256/…`) and records a `documents` row. Identical content is stored once, and
   every read is re-hashed.
2. **Parse structured files with code** (`db/repositories/parsers.ts`), keeping a `row N` or
   `json $.field` reference and the source excerpt for every value:

   | Document | Columns or fields |
   |---|---|
   | TIMESHEET (CSV) | `service_date, contractor, approved_minutes, status, [billing_rate], [approved_by]` |
   | INVOICE (CSV) | `invoice_number, contractor, service_start, service_end, minutes, amount, posting_status, [posted_date]` |
   | LEDGER (CSV) | `entry_id, vendor_id, period, kind, amount, status, [description]` |
   | ACCRUAL (JSON) | `entryId, vendorId, status, amountCents` or `amount`, `postingPeriod?`, `servicePeriod?` |

   Amounts like `"1,500.00"` become integer cents. Contracts, amendments and PDFs aren't parsed;
   the extraction agent reads them.
3. **Create the case** with `finalize_import`. Each row becomes a fact plus a typed row (work item,
   invoice line, ledger record). Only `APPROVED` timesheet rows become work items. Duplicate
   work (the same contractor and day twice) and missing required inputs become case blockers
   (`WAITING_FOR_INPUT`). Importing a document whose content duplicates another one in the same
   import is rejected with an error.

**Decision to confirm:** this parsing runs at import, not in the extraction agent. The Python
`create-review` route needs the same logic. Either port `parsers.ts` (a good fit for
`transforms/`) or call the Node tooling. Details: [setup guide §7 and §10](../../docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md).

## Still to build

- Python versions of the parsers and the import argument assembly.
- Inference of vendor, periods, amount and draft/posted status from the uploaded documents, as the
  API requires. The demo accrual JSON carries all of them.
- Real PDF text extraction for timesheets and invoices (selectable-text PDFs only, per the brief).
