# Database

Own persistence schemas, schema evolution, and reusable data-access operations.

- `models/`: entities such as runs, tasks, agent results, and pipeline records.
- `migrations/`: ordered, versioned schema changes.
- `repositories/`: queries and persistence operations used by backend modules.

Initial storage needs include run/task status, inputs or input references,
outputs or artifact references, pipeline checkpoints, and configuration/audit
records. Choose a database engine before implementing models and migrations.

Keep transactions and connection handling here. Expose repositories to backend
components; the frontend should access persisted data through the control plane.
