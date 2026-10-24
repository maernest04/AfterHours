# Data pipeline

The import path is implemented in the Python SDK under
`backend/db/src/afterhours_db/`. This folder remains the extension point for
future `connectors/`, `transforms/` and ingestion `jobs/`. Scheduling belongs in
the orchestrator.

## Implemented import path

1. The gateway uploads originals with `AfterHoursDB.upload_document`. Files live
   in `data/files/sha256/…`; SpacetimeDB stores metadata and hashes. Identical
   bytes share storage, and every read verifies size and SHA-256.
2. `afterhours_db.cases.finalize_import` verifies the files and uses
   `afterhours_db.parsers` to parse structured evidence. Each value retains its
   document ID, `row N` or `json $.field` reference, and source excerpt.
   Integrity/parse failures abort before the reducer is called.
3. The `finalize_import` reducer atomically creates the case, document links,
   facts and typed work items, invoice lines and ledger records. Only APPROVED
   timesheet rows become work items. Missing required inputs and duplicate work
   become case blockers (`WAITING_FOR_INPUT`); duplicate document content in one
   import is rejected.
4. `start_review(db, case_id, expected_revision)` queues EXTRACTION for an
   imported case. The worker pipeline handles subsequent stages.

The parsers accept these fields; bracketed fields are optional:

- TIMESHEET CSV: `service_date, contractor, approved_minutes, status,
  [billing_rate], [approved_by]`.
- INVOICE CSV: `invoice_number, contractor, service_start, service_end, minutes,
  amount, posting_status, [posted_date]`.
- LEDGER CSV: `entry_id, vendor_id, period, kind, amount, status, [description]`.
- ACCRUAL JSON: `entryId`, `vendorId`, `status`, `amountCents` or `amount`,
  optionally `postingPeriod` and `servicePeriod` (`from`, `to`).

Money is converted exactly to integer-cent strings, without binary floating
point. Contracts, amendments and PDFs are left to extraction. The agent's
`read_attachment` tool extracts selectable PDF text page by page using `pypdf`;
turning that text into validated work/invoice rows is still future work.

## Python usage

Install with `uv pip install -e backend/db` or `python -m pip install -e backend/db`
in the consuming service environment. Upload source documents first, then pass
their integer IDs and trusted accrual metadata to the importer:

```python
from afterhours_db.cases import finalize_import, start_review

def import_case(db, document_ids, metadata, import_key):
    case = finalize_import(
        db,
        document_ids=document_ids,
        vendor_id=metadata["vendorId"],
        service_period_from=metadata["servicePeriod"]["from"],
        service_period_to=metadata["servicePeriod"]["to"],
        posting_period=metadata["postingPeriod"],
        original_status=metadata["status"],
        original_amount_cents=metadata["amountCents"],
        source_entry_id=metadata["entryId"],
        idempotency_key=import_key,
    )
    if case["state"] == "IMPORTED":
        case = start_review(db, case["id"], case["input_revision"])
    return case
```

Use a gateway connection. Keep `import_key` stable across retries; it is distinct
from each document's upload key. `finalize_import` generates a key if omitted.
The seed demonstrates deriving metadata from `parse_accrual`; production API
inference and handling ambiguous uploaded metadata are not implemented.

## Remaining integration

The four public API routes still return explicit 501 stubs. Wire `create-review`
to uploads, metadata extraction, `finalize_import` and `start_review`. Add real
source connectors, structured PDF extraction and replay/freshness policies when
those sources are introduced. The mock mailbox and backend Acme fixture are
synthetic; the frontend Cedar scenario is separate.

See [database setup](../../docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md) and
[agent tools](../agents/README.md).
