# Control plane

Provide the external API and operational controls for the backend.

- `api/`: health checks, run submission/status/cancellation, and configuration
  endpoints with request validation and response contracts.
- `config/`: environment-backed application settings and workflow/agent config.
- `policies/`: authentication, authorization, quotas, and execution permissions.

Validate callers and requests before delegating execution to the orchestrator.
Expose status/results to the frontend and record operational changes through
the database layer. Long-running work belongs in the orchestrator and workers.

Suggested initial API surface, to implement later:

- `GET /health`: service health.
- `POST /runs`: submit a workflow and return its run identifier.
- `GET /runs/{run_id}`: retrieve run status and result references.
- `POST /runs/{run_id}/cancel`: request cancellation.

Keep secrets in environment variables or a secret store; commit only example
configuration with placeholder values.
