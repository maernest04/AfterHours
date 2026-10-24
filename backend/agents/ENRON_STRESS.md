# Enron / Factory stress benchmark

This benchmark imports public Enron emails and attachment text into a dedicated
SpacetimeDB database. A derived SQLite FTS5 index searches email bodies and
attachment text; SpacetimeDB rechecks company/vendor/document access before every
source read. It is not a test of SpacetimeDB full-text search.

Source: [University of Maryland / TREC EDRM Enron v2](https://trec-legal.umiacs.umd.edu/corpora/trec/legal10/).
Attribution: EDRM Enron Email Data Set, produced by **ZL Technologies, Inc.**
(http://www.zlti.com), CC BY 3.0 US, as stated in the corpus notice. Preserve the
notice with redistributed source material. Public raw messages stay out of Git.

## Setup

Use a dedicated terminal. The examples target a separate local server on port
3299 and an `enron-*` database. They must not point to the normal demo database.
Install the packages as described in [Investigation setup](INVESTIGATION.md).
The actual local run used the existing isolated CLI owner configuration; for a
fresh run, create a dedicated config and use it consistently for publish/bootstrap.

```sh
mkdir -p data/enron
curl -fL -C - --retry 3 -o data/enron/edrmv2txt-v2.tar.bz2 https://trec-legal.umiacs.umd.edu/corpora/trec/legal10/edrmv2txt-v2.tar.bz2
curl -fL -o data/enron/docids-v2.csv.bz2 https://trec-legal.umiacs.umd.edu/corpora/trec/legal10/docids-v2.csv.bz2
spacetime start --listen-addr 127.0.0.1:3299 --data-dir /private/tmp/afterhours-enron-db --non-interactive
```

In another terminal, publish/bootstrap with the isolated owner configuration:

```sh
export SPACETIMEDB_URI=http://127.0.0.1:3299
export SPACETIMEDB_DATABASE=enron-stress
export SPACETIMEDB_SECRETS_DIR=data/enron/secrets
export FILE_STORE_DIR=data/enron/files
spacetime --config-path data/enron/cli.toml publish enron-stress --server "$SPACETIMEDB_URI" --module-path backend/db/spacetime/spacetimedb --no-config --yes
```

Create the owner wrapper from the repository root. Bootstrap uses the matching
CLI configuration internally; never print or commit tokens.

```sh
cat > data/enron/owner-spacetime <<'SH'
#!/bin/sh
exec spacetime --config-path "$PWD/data/enron/cli.toml" "$@"
SH
chmod +x data/enron/owner-spacetime
export SPACETIME_BIN="$PWD/data/enron/owner-spacetime"
uv run --project backend/db afterhours-db bootstrap
uv run --project backend/agents python -m afterhours_investigation.enron prepare --limit 100000
uv run --project backend/agents python -m afterhours_investigation.enron import --limit 1000
uv run --project backend/agents python -m afterhours_investigation.enron_benchmark probe
uv run --project backend/agents python -m afterhours_investigation.enron_benchmark run --concurrency 1
```

The `run` and public-contract commands make paid live Factory requests using the
root `.env` credentials. Native Droid tools remain disabled. Upstream EXTRACTION
and MATCHING are explicitly replayed fixtures; Investigation runs the real handler,
lease heartbeats, read tools and completion reducer.

## Scale and concurrency

Repeat import/probe/run at 10,000 and 100,000. Reimports reuse source IDs and
checkpoints. Do not run ingestion while collecting steady-state latency results.

```sh
uv run --project backend/agents python -m afterhours_investigation.enron import --limit 10000
uv run --project backend/agents python -m afterhours_investigation.enron_benchmark probe
uv run --project backend/agents python -m afterhours_investigation.enron_benchmark run --concurrency 5
uv run --project backend/agents python -m afterhours_investigation.enron import --limit 100000
uv run --project backend/agents python -m afterhours_investigation.enron_benchmark probe
uv run --project backend/agents python -m afterhours_investigation.enron_retrieval
uv run --project backend/agents python -m afterhours_investigation.enron_benchmark run --concurrency 20 --repeat 4
```

A single case can use the same indexed tools through the regular worker:

```sh
uv run --project backend/agents afterhours-investigate --case-id CASE_ID --search-index data/enron/corpus.sqlite
```

The index must match the database URI/name/company. Newly stored messages need
indexing (`index_mail`); this benchmark does that during import and scenario
creation. General application-wide continuous index synchronization is not built.

## What the reports mean

- `import-report.json` and `import-N.json`: actual public email/attachment counts, body truncations,
  source/attribution and import time. Source IDs, paths, raw bytes and SHA-256s
  remain in `corpus.sqlite`; original attachment bytes live in the file store.
- `probe-N.json`: 40 real indexed searches, p50/p95 latency, response sizes and
  bounded case snapshot size. This measures retrieval, not model reasoning.
- `factory-N-cC-*.json`: individual outcomes, evidence discovery, observed token/
  credit usage when reported by Factory, model IDs, decisions, errors and wall times.
  When `data/enron/server.pid` contains the database PID, reports also sample its
  RSS and `ps` CPU percentage; these are process observations, not machine-wide
  capacity measurements. SDK credits are recorded without guessing a dollar conversion. Scenarios
  cover signed, unsigned, missing, conflicting and malicious-instruction evidence.
- `public-contracts-N-*.json`: two manually inspected real contract-title retrieval
  questions with document/line/excerpt validation. This is a small smoke test,
  not a representative contract-understanding accuracy benchmark.

All public records share artificial vendor `ENRON-BENCH`, so vendor scoping cannot
remove the public distractor corpus. Original source parties/dates are retained;
synthetic accounting cases use September 2000. Record subset selection follows
archive order; it is not a random or company-representative sample. Approximate
threads group normalized subjects and can merge unrelated conversations.

The normalized mailbox stores at most 20,000 body characters, matching the existing
reducer. Full raw records remain in the corpus. Attachment text is indexed; original
PDF/Word/Excel binaries, OCR and conversion quality are not tested. Retrieval caps
searches at 25 rows, threads at 25 messages with 2,000 body characters each, and
model attachment text at 64,000 characters. Truncation flags must be respected.
Attachment relationships absent from the supplied text archive cannot be recovered;
preparation records expected/found counts. Unparseable emails are skipped and counted.

Synthetic draft cases expect a $7,700 target, $700 adjustment and $7,700 full draft
export amount. Missing/unsigned/conflicting cases must stay unresolved. No human
approval, export action or real Enron accounting correction occurs.

## Regression tests

```sh
uv run --project backend/agents python -m unittest discover -s backend/agents/test -v
uv run --project backend/db python -m unittest discover -s backend/db/test -v
ENRON_INTEGRATION=1 uv run --project backend/agents python -m unittest discover -s backend/agents/test -p test_enron.py -v
npm run typecheck
```

The Enron integration tests require the dedicated environment above. They test
idempotency, batch limits, worker write denial, anonymous access and a deliberately
poisoned FTS index that suggests another vendor's email/document.
