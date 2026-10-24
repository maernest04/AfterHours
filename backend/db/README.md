# Database

The datastore is **SpacetimeDB** 2.13, run locally at `http://localhost:3000`, with database `accrual-docs` by default. It's the sole authoritative state store. It follows the revised implementation brief:
- tables are private, and clients read through views that check `ctx.sender`
- reducers check the caller: gateway or worker service identities, and the owner for setup
- original files live on a persistent file store, referenced by `storageKey` and hash

The current phase covers **document storage only**.

**Setup, schema, reducers and handoff:** [docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md](../../docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md)

- `spacetime/`: the SpacetimeDB module. Private tables are in `spacetimedb/src/schema.ts`; reducers and views are in `spacetimedb/src/index.ts`. `CLAUDE.md` is the SpacetimeDB API reference for coding agents.
- `bindings/`: generated TypeScript client bindings for the views and reducers (`npm run db:generate`). Don't edit them by hand.
- `repositories/`: the Node API for the gateway and worker:
  - `client.ts`: service connections
  - `file_store.ts`: file storage
  - `documents.ts`: the document API
  - `data_plane.ts`: implements the control plane's `DataPlane` port
- `seed/`: `bootstrap.ts` does the owner setup (settings and service identities); `seed.ts` loads the synthetic documents.
- `test/`: the end-to-end smoke test (`npm run smoke`).
- `models/`, `migrations/`: unused. In SpacetimeDB, the schema lives in the module and migrations happen on publish.

Other backend components (control plane, agents) call `repositories/` rather than the generated bindings directly.
