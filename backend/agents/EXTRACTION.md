# Extraction (Bitdeer)

EXTRACTION reads the case's **CONTRACT** and **AMENDMENT** documents and proposes
source-quoted rate facts. CSV/JSON inputs are parsed by code at import and are not
sent to a model. Facts stay `PROPOSED`; the database then queues MATCHING.
Provider: [Bitdeer](https://developers.bitdeer.ai/docs/guides/llm) chat completions
(`https://api-inference.bitdeer.ai/v1`, OpenAI-compatible, bearer key).

## Setup

```sh
uv sync --project backend/agents
```

Add to the root `.env` (git-ignored; server-side only):

```
BITDEER_API_KEY=...
BITDEER_MODEL_ID=            # optional, default deepseek-ai/DeepSeek-V4.1-Flash
```

Without `uv`: `python -m pip install -e backend/db -e backend/agents`, then
`python -m afterhours_extraction.worker ...`.

## Run (once you have the key)

```sh
# 1. one tiny live call: key, model and strict JSON-schema mode work
uv run --project backend/agents afterhours-extract --check-provider
# 2. read case 1 and print what Bitdeer extracts; claims nothing, writes nothing
uv run --project backend/agents afterhours-extract --case-id 1 --dry-run
# 3. claim the QUEUED EXTRACTION job, extract, complete (model_run=LIVE)
uv run --project backend/agents afterhours-extract --case-id 1
```

After step 3 the case is `MATCHING`. Add `--watch` to keep polling. Failures exit
non-zero and leave the lease to the database's bounded retry policy.
If step 1 returns HTTP 400 on `response_format`, the client automatically falls back
to `json_object` mode with the schema in the prompt; set `BITDEER_STRUCTURED_MODE=json_object`
to skip the attempt. Check the model supports structured output in Bitdeer's catalog.

## How it works

1. Claim over the worker WebSocket; heartbeats run during inference.
2. `AgentTools.read_attachment` reads each CONTRACT/AMENDMENT (scope-checked,
   hash-verified, PDF pages preserved). The model gets numbered lines (`L<n>:`) or
   `--- page N ---` text. It has **no tools**, so injected text can only affect its
   JSON reply.
3. One model call per document returns `{facts, unresolvedQuestions}`. Code checks
   every fact against the real text: allowed field, `line N`/`page N` location, exact
   excerpt at that location, integer cents present in the excerpt, ISO dates present in
   the excerpt, one fact per field. A rejected reply is sent back for repair (3 tries),
   then the job fails. Nothing unverified reaches the database.
4. Code (not the model) sets `documentId`, `evidenceIds` and the summary, and sends the
   standard `AgentOutput` (no matches). The reducer re-checks scope and revision.

Fields are the same vocabulary Investigation and the calculator use:
`rate.hourlyCents`, `rate.effectiveFrom`, `rate.effectiveTo`, `rate.approvedBy`,
`rate.signedDate`, `amendment.supersedesRateCents`.

## Verification

```sh
uv run --project backend/agents python -m unittest discover -s backend/agents/test -v
AFTERHOURS_INTEGRATION=1 ... # also runs the database integration tests (use a test DB)
```

`test_extraction.py` covers validation (forged quotes/values, injection, PDF pages),
repair, scoping and the HTTP client against a local fake Bitdeer server.
`test_extraction_integration.py` runs the real database/lease/reducer path with a
`REPLAYED` model fixture. The Docker HTTP flow also exercises the real extraction,
matching and investigation workers with replayed decisions. Run the separate
`pipeline-live-tests` Compose service for a paid full-agent check; it requires
all three persisted stages to be `LIVE`. Provider startup failures do not count
as live inference verification. See the [root checks](../../README.md#checks).

The 2026-10-24 live pipeline check completed Bitdeer extraction followed by Factory
matching and investigation, with all three results persisted as `LIVE`. Its slow
extraction attempt lost its lease; the scoped retry completed successfully.
