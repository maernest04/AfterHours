# SpacetimeDB progress

Status as of 2026-10-24.

SpacetimeDB is the authoritative state store for documents, imported cases,
evidence, mock mailbox messages and jobs. The external tooling has been ported
to the installable Python `afterhours_db` SDK. Only the database module remains
TypeScript. [Setup and handoff](SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md) contains
current commands and service integration details.

## Implemented

- The module has 19 private tables and 15 caller-filtered public views. Owner,
  gateway, worker and scheduler authority remain enforced inside reducers.
- Python owns atomic content-addressed file writes, hash/size-verified reads,
  document metadata/versioning and idempotent uploads. Original bytes stay in
  the file store, outside SpacetimeDB.
- Python CSV/JSON parsers retain excerpts and row/JSON references and represent
  money as exact integer-cent strings. The import helper verifies files before
  atomically creating cases, facts and typed work/invoice/ledger rows. Missing
  inputs and duplicate work become blockers; duplicate documents are rejected.
- Mailbox helpers store synthetic vendor messages and document attachments.
- Jobs use atomic claims with recorded connection IDs, heartbeats, a scheduled expiry
  sweep and bounded retries. Completion validates evidence scope, saves PROPOSED
  agent facts/matches with LIVE/REPLAYED provenance, and advances the extraction,
  matching and investigation stages.
- Python read-only agent tools search vendor mail, read threads and verified
  attachments, extract PDF text with page markers using `pypdf`, and return the
  case's current evidence. LLM contracts keep camelCase and decimal-string IDs.
- Factory Investigation uses those tools with lease heartbeats and validates
  source-linked rate/approval facts. The gateway calculator saves immutable,
  balanced proposals; the database enforces posting periods, revision/policy,
  evidence scope, invoice capacity and exact monetary arithmetic. See the
  [handoff](../backend/agents/INVESTIGATION.md) for verification and limitations.
- The Python CLI supports start/stop, publish/reset, bootstrap, seed, SQL and
  smoke. Root npm database aliases call Python; Node builds/typechecks the module.
- Docker hosts SpacetimeDB locally on port 3000. Its named volume preserves both
  records and signing keys; original files and service secrets remain separate.

## Connection behavior and fixtures

Gateway reducer calls use HTTP. `AfterHoursDB.connect("worker")` opens a
persistent JSON WebSocket so claim/heartbeat/complete share the required
`ctx.connectionId`. All SDK reads are fresh HTTP queries; there is no replicated
view cache, subscription API or view-event callback layer. Earlier instructions
to hold worker leases with independent HTTP calls no longer describe the
supported integration.

The idempotent backend seed creates seven documents, four emails, one Acme case
and an EXTRACTION job on a fresh database. The latest timesheet is imported;
the amendment is discoverable only through a mailbox attachment. Distractor,
prompt-injection and other-vendor emails exercise tool scope. Seed reruns do
not rewind pipeline progress. The frontend's Cedar fixture is a separate UI
scenario and must not be presented as this seeded backend case.

## Verification commands

```sh
uv run --project backend/db python -m unittest discover -s backend/db/test -v
uv run --project backend/db afterhours-db smoke
npm run typecheck
```

Unit checks cover transport handling, filesystem integrity, exact parsers,
imports and agent tool scope/PDF extraction. The live smoke command covers
storage/authorization plus the imported-case, mailbox and job-lease pipeline.
The Python smoke suite passed 23 checks locally: 13 storage checks and 10 pipeline
checks, including competing workers, heartbeats, stale-lease rejection, all three
agent stages, scheduled expiry and retry exhaustion. Public API tests cover the
existing stub/validation contracts, not a completed review workflow.

## Remaining work

- Connect create/get/export review operations; they still return explicit 501
  responses. Review listing now reads the SDK with cursor pagination capped at 10.
  The browser must use that API without receiving database credentials.
- Implement extraction and broader orchestration. Matching now has a Factory
  adapter, validated handler, heartbeats, polling worker and Docker/replay E2E.
  Investigation and gateway proposals are implemented; live matching quality
  verification remains pending Factory configuration.
- Implement question delivery, reviewer decisions, export authorization and CSV generation.
- Bump case revisions and invalidate old jobs/proposals when inputs change;
  current checks reject stale revisions, but automatic revision updates and
  cancellation are not implemented.
- Convert extracted PDF text into validated structured evidence when needed;
  text extraction already exists, OCR does not.

Agent integration starts at [backend/agents/README.md](../backend/agents/README.md).
The Python API should reuse the SDK's import and file-store behavior. Future
module changes must retain caller/company checks and private tables behind
filtered views.
