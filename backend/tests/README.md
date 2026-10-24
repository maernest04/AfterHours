# Review workflow E2E

`test_review_flow.py` runs real HTTP, file storage, SpacetimeDB, worker implementations,
calculation, and SSE with explicitly replayed model decisions. `test_review_flow_live.py`
runs the same path with live Bitdeer extraction and Factory matching/investigation.

`test_review_scenarios_live.py` generates ten compact synthetic fixtures and uses real
providers. It tests baseline/no change, signed rate increase, signed rate decrease,
mid-period amendment, no invoice, unposted invoice, partial posted invoice, unsigned
amendment, conflicting amendments, and malicious instructions in a mock email.
Expected targets are respectively $1,000, $1,100, $900, $1,050, $1,000, $1,000,
$600, blocked, blocked, and $1,100, against an original posted $1,000 accrual.

Each successful case checks persisted proposal amounts/hash, balanced journal lines,
month-end entry date, idempotent resume, evidence, API readback and SSE. Negative cases
must retain concrete blockers without a proposal. The suite also checks duplicate
imports and listing pagination (default/max 10). All persisted model results must say
`LIVE`; missing credentials fail instead of silently replaying.

Approval decisions and CSV export are not implemented. The suite checks that export
still returns **501**, as an explicit unsupported boundary, not successful export.
Email remains mocked. No emails are sent, accounting entries posted, or approvals created.

## Isolated local run

Run from the repository root. The test database uses the normal local SpacetimeDB
server, with separate cases/settings. Existing application rows are preserved.
The CLI identity must own the test database. Bootstrap reuses the local gateway/worker
identities and grants their roles only inside the selected database.

```sh
SPACETIMEDB_DATABASE=accrual-docs-e2e uv run --project backend/db afterhours-db publish
SPACETIMEDB_DATABASE=accrual-docs-e2e uv run --project backend/db afterhours-db bootstrap
API_PORT=8001 docker compose -f compose.yaml -f backend/orchestrator/compose.test.yaml --profile live-scenarios up --build -d --wait scenario-api
API_PORT=8001 docker compose -f compose.yaml -f backend/orchestrator/compose.test.yaml run --build --rm --no-deps pipeline-scenario-tests
```

The scenario API listens at `http://localhost:8002`; the existing API stays on its
own port/database. `AFTERHOURS_SCENARIO_DATABASE` and `AFTERHOURS_SCENARIO_API_PORT`
override the test database and host port. Never run a separate live worker against
the test database: it could claim the suite's jobs. Provider credentials come from
normal Compose environment loading; test reports never include credential values.

The default is sequential. Add `-e AFTERHOURS_SCENARIO_WORKERS=2` to run two cases
with independent DB connections. Each case is scoped, has a ten-minute polling
deadline, and uses the DB's bounded lease/retry policy. A provider call can consume
its configured timeout before the polling deadline is checked again. Recovered
errors and job attempt counts remain in the report, even when final assertions pass.

Reports are local ignored JSON under `data/files/e2e-runs/`; no generated rows or
documents are committed. `-e AFTERHOURS_SCENARIO_REPORT=/app/data/files/e2e-runs/run.json`
selects a stable report. Reusing it resumes the same cases and verifies existing
successful results without regenerating inference. Use a new path for a fresh run.
The saved database name and import key are checked before processing a resumed case.
`-e AFTERHOURS_SCENARIOS=baseline,partial_posted_invoice` selects a diagnostic subset.
An interrupted fixture setup or exhausted job needs a fresh case, not an automatic reset.

Replay against the same isolated database without model calls:

```sh
API_PORT=8001 docker compose -f compose.yaml -f backend/orchestrator/compose.test.yaml run --build --rm --no-deps -e SPACETIMEDB_DATABASE=accrual-docs-e2e -e AFTERHOURS_API_URL=http://scenario-api:8000 pipeline-tests
```
