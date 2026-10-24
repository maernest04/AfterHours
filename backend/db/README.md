# Database

The datastore is **SpacetimeDB** 2.13, run locally at `http://localhost:3000`, with database `accrual-docs` by default. It's the sole authoritative state store. It follows the revised implementation brief:
- tables are private, and clients read through views that check `ctx.sender`
- reducers check the caller: gateway or worker service identities, and the owner for setup
- original files live on a persistent file store, referenced by `storageKey` and hash

It holds:
- documents
- cases and import (structured files parsed with code into facts)
- evidence tables
- the mock mailbox
- the job queue (leases, retries and an expired-lease sweep)

Proposals, reviews and exports come in a later phase.

**Setup, schema, reducers and handoff:** [docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md](../../docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md)

- `spacetime/`: the SpacetimeDB module. Private tables are in `spacetimedb/src/schema.ts`, caller checks in `auth.ts`, and reducers and views in `index.ts` (documents) and `pipeline.ts` (cases, mailbox, jobs). `CLAUDE.md` is the SpacetimeDB API reference for coding agents.
- `bindings/`: generated TypeScript client bindings for the views and reducers (`npm run db:generate`). Don't edit them by hand.
- `repositories/`: the Node API for the gateway and worker:
  - `client.ts`: service connections
  - `file_store.ts`: file storage
  - `documents.ts`: the document API
  - `parsers.ts` / `cases.ts`: import parsing and cases
  - `mailbox.ts`: the mock mailbox
  - `jobs.ts`: the worker's claim / heartbeat / complete
- `seed/`: `bootstrap.ts` does the owner setup (settings, job policy and service identities); `seed.ts` loads the demo Acme case and mailbox and leaves an EXTRACTION job queued.
- `test/`: the end-to-end smoke test (`npm run smoke`).
- `models/`, `migrations/`: unused. In SpacetimeDB, the schema lives in the module and migrations happen on publish.

The application backend uses Python; integration with this TypeScript storage tooling is still pending. The Python API lives in `backend/api/` and currently returns explicit 501 stub errors. Each application service will run in its own local Docker container; database container configuration is still pending.
