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
