# Database

The datastore is **SpacetimeDB** 2.13, run locally at `http://localhost:3000`, with database `accrual-docs` by default. The current phase covers **document storage only**: versioned, hash-verified source files and their metadata.

**Setup, schema, reducers and handoff:** [docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md](../../docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md)

- `spacetime/`: the SpacetimeDB module. Tables are in `spacetimedb/src/schema.ts` and reducers in `spacetimedb/src/index.ts`. `CLAUDE.md` is the SpacetimeDB API reference for coding agents.
- `bindings/`: generated TypeScript client bindings (`npm run db:generate`). Don't edit them by hand.
- `repositories/`: the Node API other components should use (`client.ts`, `documents.ts`). `data_plane.ts` implements the control plane's `DataPlane` port for document operations.
- `seed/`: synthetic seed documents (`npm run db:seed`).
- `test/`: the end-to-end smoke test (`npm run smoke`).
- `models/`, `migrations/`: unused. In SpacetimeDB, the schema lives in the module and migrations happen on publish.

Keep transactions and connection handling here. Other backend components (control plane, agents) call `repositories/` rather than the generated bindings directly.
