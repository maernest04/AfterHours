# Investigation and calculator handoff

Investigation finds source-backed rate evidence for an existing MATCHING question.
The gateway calculator then builds an **unapproved** proposal. Approval, CSV export,
public API integration and the other two agent handlers remain separate work.

## Setup

From the repository root, publish the updated database module and bootstrap it
before using this worker. Bootstrap opens September 2026 only if that demo period
has never been configured; it does not reopen a closed period.

```sh
uv run --project backend/db afterhours-db publish
uv run --project backend/db afterhours-db bootstrap
uv sync --project backend/agents
curl -fsSL https://app.factory.ai/cli | sh
```

Set `FACTORY_API_KEY` in the root `.env`, or authenticate the CLI locally.
`DROID_EXEC_PATH` defaults to `droid`; `FACTORY_MODEL_ID` is optional and otherwise
uses the account default. Never send these credentials to the frontend.

```sh
uv run --project backend/agents afterhours-investigate --check-provider
uv run --project backend/agents afterhours-investigate --case-id 1 --watch
```

`--watch` polls only INVESTIGATION jobs for the specified case. EXTRACTION and
MATCHING must finish first. Failures exit the process and leave the lease to the
database's bounded retry/sweep policy; restart the command after fixing the error.
One-shot mode omits `--watch` and processes at most one claimable job.

Without uv, use a Python 3.12+ virtual environment and install both local packages:

```sh
python -m pip install -e backend/db -e backend/agents
python -m afterhours_investigation.worker --check-provider
```

## Connections and teammate contract

1. EXTRACTION completes its existing `AgentOutput`; the database queues MATCHING.
2. MATCHING proposes one allocation per approved work item, identifying its
   governing contract/amendment and candidate invoice lines. Put missing approval
   or rate questions in `unresolvedQuestions` to queue INVESTIGATION.
3. Investigation claims that job over the worker WebSocket. It uses the existing
   `searchEmails`, `readEmailThread`, `readAttachment` and `getCaseEvidence` tools.
   SDK calls run outside the async event loop; heartbeats continue during inference.
4. Factory returns structured tool requests. Application code dispatches only the
   four read tools. Native/connected Droid tools and built-in skills are disabled;
   startup fails if any tool remains enabled. Emails and attachments are evidence,
   including instruction-like text inside them.
5. Investigation validates scope, source quotes and locations before completion.
   Results retain `PROPOSED` fact status and `LIVE` provenance. Missing/conflicting
   evidence stays unresolved and the database sets `WAITING_FOR_INPUT`.
6. Once all stages succeed with no blockers, the gateway builds the proposal:

   ```sh
   uv run --project backend/agents afterhours-calculate --case-id 1 --revision 1 --entry-date 2026-09-30
   ```

7. Read `proposals_view` using a service identity. The saved proposal includes
   revision/policy, supported cost, corrected target, adjustment, export amount,
   balanced journal lines, evidence IDs and a server-computed SHA-256 hash.
   Rebuilding the current proposal is idempotent. Changed sources require a new
   case revision; automatic revision creation is not implemented.

For embedding, `investigate(evidence, tools, decide)` accepts the current camelCase
evidence snapshot, `AgentTools`, and an async `decide(prompt, schema)` function.
`run_job(db, lease, decide, model_run=...)` handles heartbeats and validated
completion. `build_proposal(db, case_id, expected_revision, entry_date=...)` requires
a gateway identity. No production replay fallback is provided.

## Supported evidence and calculation

Supported rate facts are `rate.hourlyCents`, `rate.effectiveFrom`, optional
`rate.effectiveTo`, `rate.approvedBy` (signer name), `rate.signedDate` and optional
`amendment.supersedesRateCents`. A resolved rate needs the first, second, fourth
and fifth fields from the same source, with exact excerpts and `line N` or
`page N` locations. Dates must be ISO and monetary excerpts must state decimal
amounts. The narrow demo checks `Authorized signatory:` in the original contract
and `Approved and signed:` in amendments (`Signed:` for original contracts).
Other document formats or missing authority need human resolution.

This checks source consistency, not cryptographic signatures or legal authority.
The model still assesses parties, contract meaning and conflicting evidence;
quote validation cannot prove that its interpretation is correct or that it found
every relevant document. PDF text extraction exists; OCR does not.

The calculator rechecks source facts and applicable rates in Python. The database
independently checks role, revision, policy, period, scope, job completion,
invoice/work capacity and unique posted ledger corroboration. It calculates with
integer cents/minutes and rejects fractional-cent work costs. Python remains a
trusted gateway boundary for interpreting contractual approval; calling the reducer
directly as a gateway does not repeat those textual checks.

Supported cost minus corroborated posted invoices gives the corrected accrual.
Posted originals produce the difference; changed drafts produce the full target.
No change produces no journal. Negative corrections reverse debit/credit sides.
Closed periods, duplicate/ambiguous coverage, conflicting rates and unsupported
zero-target draft removal block construction. Account mappings come from company
settings. Proposal readiness is not human approval or permission to export.

## Verification

```sh
uv run --project backend/agents python -m unittest discover -s backend/agents/test -v
uv run --project backend/db python -m unittest discover -s backend/db/test -v
npm run typecheck
uv run --project backend/db afterhours-db smoke
```

The agent suite has 12 unit tests, four replayed database integration tests and
one optional live Factory integration test. To run the
integration tests, point the SDK environment variables at a **dedicated test
database**, publish/bootstrap it, then add `AFTERHOURS_INTEGRATION=1` to the first
command. Add `AFTERHOURS_LIVE_FACTORY=1` as well to enable the live integration
test (uses Factory credits). Tests create synthetic records and temporarily change the global lease
policy and September posting period, restoring them afterward.

Integration uses real tools, files, leases, reducers and proposal arithmetic;
EXTRACTION/MATCHING and model decisions are explicitly `REPLAYED` fixtures. It
covers the $7,700 target/$700 adjustment, draft/full entries, negative/no-change
cases, partial invoices, closed periods, stale revisions, worker authority,
fractional cents, slow inference, restart/stale leases and unresolved evidence.
Scripted injection tests verify dispatch boundaries, not live-model immunity.
`--check-provider` separately makes a small live Factory structured-output request.

Verified locally on 2026-10-24: 12 agent unit tests, four replayed database
integration tests, the live Factory investigation-to-proposal test, 29 SDK unit
tests, 23 database smoke checks and TypeScript typechecking passed. The live
Investigation produced the $7,700 target/$700 adjustment; its upstream
EXTRACTION/MATCHING stages remained replayed fixtures.
