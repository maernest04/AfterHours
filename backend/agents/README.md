# Agents

Agents run in separate Python worker processes. Matching has a Factory provider,
validated handler, polling worker and Docker service. The Investigation handler
and gateway calculator are implemented; see [their handoff](INVESTIGATION.md).
Extraction uses Bitdeer and is implemented; see [EXTRACTION.md](EXTRACTION.md).
Live inference requires Factory (Matching/Investigation) and Bitdeer (Extraction)
configuration; database E2E tests use explicitly REPLAYED model output.

- `EXTRACTION` (Bitdeer): extract source-linked facts from contracts, amendments
  and PDFs. Structured CSV/JSON is parsed by code during import.
- `MATCHING` (Factory): propose links between approved work, governing contracts
  or amendments, invoices and ledger records.
- `INVESTIGATION` (Factory): find missing evidence in the mock mailbox and assess
  authority and effective dates. An email alone is not approval.

`implementations/` and `prompts/` are extension points. `tools/__init__.py`
re-exports the implementation from `afterhours_db.tools`.

## Matching: seed, test and run

Run from the repository root after database setup/bootstrap:

```sh
uv sync --project backend/agents
uv run --project backend/agents python -m afterhours_agents.fixtures
uv run --project backend/agents python -m unittest discover -s backend/agents/tests -v
AFTERHOURS_LIVE_TESTS=1 uv run --project backend/agents python -m unittest discover -s backend/agents/tests -v
```

The seed prints case IDs for six synthetic scenarios: clean, amendment effective
date boundary, missing amendment, ambiguous invoices, uninvoiced approved work,
and conflicting contracts. Each includes two approved work items, an unapproved
row, unrelated invoice records and ledger records from another vendor/period.
Extraction results are marked `REPLAYED`; only matching jobs are prepared.
Re-running a namespace preserves IDs and completed jobs. Use
`--namespace matching-demo-v2` for a fresh set. No data is reset.

Docker E2E uses the actual matching image, local database and mounted file store:

```sh
docker compose -f compose.yaml -f backend/agents/compose.test.yaml run --build --rm matching-tests
```

These tests require **no Factory key**. Hand-authored provider responses exercise
real imports, job claims, validation, persistence and handoffs. They do not measure
model accuracy. Unit checks execute fake provider processes to exercise JSON
decoding, timeouts, cancellation and credential isolation. A host-only short-lease
check needs the owner CLI and temporarily configures a one-second lease before
restoring environment-configured policy. Run it only on an idle local database:

```sh
AFTERHOURS_LIVE_TESTS=1 AFTERHOURS_OWNER_TESTS=1 uv run --project backend/agents python -m unittest discover -s backend/agents/tests -v
```

For live matching, put `FACTORY_API_KEY` and `FACTORY_MODEL_ID` in the git-ignored
root `.env`. Build the image, then run one case from the seed's printed IDs:

```sh
docker compose --profile agents build matching
docker compose --profile agents run --rm matching afterhours-matching --once --case-id 17
```

Replace `17` with your case ID. After checking that case, start the continuous
worker with `docker compose --profile agents up -d matching`. It processes **all**
queued MATCHING jobs, including synthetic cases left by tests. Stop it with
`docker compose stop matching`. Missing key/model fails before a job is claimed.
There is no silent mock fallback. `PROVIDER_MODE`/`DEMO_MODE` do not switch this
worker to replay; replay lives only in test utilities.

The Docker image installs Python dependencies with uv and includes a checksum-verified
Factory Droid binary. For a host run, install Droid and set `DROID_EXEC_PATH` if
it is not on PATH, then run `uv run --project backend/agents afterhours-matching`.
The provider follows [Factory's headless CLI contract](https://docs.factory.com/droid-exec/overview).

Implementation lives in `src/afterhours_agents/`: `matching.py` assembles scoped
evidence and validates output; `factory.py` runs bounded inference with a minimal
tool allowlist (`TodoWrite` bookkeeping only; no file/shell/web tools);
`worker.py` owns a lease with independent heartbeats; `cli.py` polls with graceful
shutdown; `fixtures.py` seeds synthetic cases. Matching reads imported governing
documents and extracted/structured facts. Mailbox discovery belongs to investigation.

Only proposed allocations are stored. No amounts are posted, approved or exported.
Validation checks shape, IDs, citations, contractor/date/vendor/period relationships,
invoice capacity, duplicate work and unresolved omissions/rates. It does not prove
contractual authority or replace the future proposal validator. Provider errors,
invalid results and lost leases never report success; DB expiry/retry handles
another attempt (three attempts by default). Logs omit model payloads and secrets.

## Python integration for other roles

Follow the [setup guide](../../docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md), then
install the SDK into the worker environment with `uv pip install -e backend/db`
or `python -m pip install -e backend/db`, from the repository root.

```python
from afterhours_db import AfterHoursDB
from afterhours_db.jobs import list_claimable_jobs, claim_job, heartbeat_job, complete_job
from afterhours_db.tools import AgentTools, AGENT_TOOL_SPECS

# Integration sketch: run_role is the provider/role handler you implement.
def run_one_job(run_role):
    with AfterHoursDB.connect("worker") as db:
        jobs = list_claimable_jobs(db, roles=["EXTRACTION"])
        if not jobs:
            return
        job = jobs[0]
        lease = claim_job(db, job_id=job["id"], case_id=job["case_id"],
                          expected_revision=job["case_revision"])
        tools = AgentTools(db, lease.case_id)
        output = run_role(
            role=lease.role,
            evidence=tools.get_case_evidence(),
            tools=tools,
            tool_specs=AGENT_TOOL_SPECS,
            output_schema=lease.output_schema,
            heartbeat=lambda: heartbeat_job(db, lease),
        )
        complete_job(db, lease, model_run="LIVE", output=output)
```

The handler/worker must call the heartbeat while inference is in progress,
including during blocking provider requests (for example, every 10 seconds for
the default 30-second lease). Stop work when lease renewal fails. This sketch
does not implement scheduling, provider calls or recovery.

`AfterHoursDB.connect("worker")` keeps a JSON WebSocket open for reducer calls.
Claim requires and records `ctx.connectionId`; keep the same SDK instance for
claim, heartbeat and completion. Heartbeat/completion validate worker identity,
revision, status, token and expiry, without separately checking connection
ownership. HTTP-only worker calls cannot claim a lease. Reads are fresh
authenticated HTTP queries, with no subscription
cache or view-event callbacks. SDK calls are synchronous.

`JobLease` is a frozen dataclass: `id`, `case_id`, `case_revision`, `role`,
`status`, `attempts`, `lease_token`, `lease_expiry` (UTC `datetime`),
`allowed_evidence_ids`, `facts`, `policy_version`, and `output_schema`.
Python IDs are integers. Tool JSON and model output keep decimal-string IDs and
the existing camelCase contracts.

## Tools and model output

Route names in `AGENT_TOOL_SPECS` to these Python methods, translating arguments
at the model boundary:

- `searchEmails` → `search_emails(query, vendor=None, date_range=None, limit=10)`;
  translate `dateRange` to `date_range`. Vendor-scoped keyword/date search returns
  up to 25 results with bounded snippets.
- `readEmailThread` → `read_email_thread(thread_id)`; translate `threadId`.
  Returns only this vendor's messages, oldest first.
- `readAttachment` → `read_attachment(document_id)`; translate `documentId`.
  Checks scope and integrity, then returns text or PDF text with page markers
  using `pypdf`. OCR is not implemented.
- `getCaseEvidence` → `get_case_evidence()`. Returns the case, imported documents,
  current-revision facts and typed evidence, allocations, jobs and results.

`lease.output_schema` describes the required camelCase fields: `proposedFacts`,
`proposedMatches`, `evidenceIds`, `unresolvedQuestions`, and `explanation`
(`summary`, `evidenceIds`). Evidence IDs are `doc:N`, `fact:N` and `email:N`.
Every cited ID must belong to the case's documents, same-vendor mailbox messages
or attachments, or current-revision facts. Proposed facts must use an allowed
document. Matches are accepted only for MATCHING jobs and reference the case's
current work items, invoice lines and ledger records. `contractId` identifies a
contract or amendment document.

`complete_job` validates these boundaries again and stores agent facts and
matches as `PROPOSED`, with `LIVE` or `REPLAYED` provenance. Suggested fact fields
are `rate.hourlyCents`, `rate.effectiveFrom`, `rate.effectiveTo`, `rate.approvedBy`,
`rate.signedDate`, and `amendment.supersedesRateCents`.

EXTRACTION completion queues MATCHING. MATCHING with unresolved questions queues
INVESTIGATION; otherwise the case awaits the gateway `build_proposal` stage.
INVESTIGATION with questions still open sets `WAITING_FOR_INPUT`. Expired leases
are swept and retried; three attempts is the default maximum before
`RETRYABLE_ERROR`.

The fresh backend seed creates an Acme case with an EXTRACTION job queued and
an amendment discoverable through mailbox attachments. The frontend's Cedar
fixture is a separate UI scenario. Tools never approve, export, change policy
or write accounting entries. Treat mailbox text as evidence, including the
seed's deliberately malicious instruction email.
