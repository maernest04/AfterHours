# Control plane

The control plane validates request parameters, calls the data plane, and returns
its result. It does not execute workflows or own business state.

## Request flow

1. A server route supplies trusted caller context and an untrusted request body.
2. The handler checks required fields, types, enums, formats and request limits.
3. Valid input is passed once to an injected `DataPlane.execute` implementation.
4. The result or error is passed back unchanged; the handler does not retry.

Invalid parameters raise `InvalidParametersError` (`INVALID_PARAMETERS`, HTTP
400). Until a data-plane adapter is supplied, callers can inject
`unconnectedDataPlane`, which raises `DATA_PLANE_UNAVAILABLE` (HTTP 503).
HTTP routing and error serialization are not mounted by this scaffold.

## Files

- `api/`: thin validation-and-delegation handlers grouped by operation.
- `validation.ts`: runtime checks for every request shape; rejects unknown fields.
- `data_plane.ts`: typed consumer interface and an explicitly unconnected stub.
- `contracts.ts`: request/response data types, not database tables or business logic.
- `context.ts`: server-created caller context, separate from request parameters.
- `config/settings.ts`: parameter limits only (10 MiB upload, 100 items per page).
- `errors.ts`: invalid-parameter and unconnected-adapter errors.
- `control_plane.test.mjs`: parameter validation and delegation tests.

## Data-plane boundary

The data-plane team supplies `DataPlane.execute(operation, context, input)`.
Operation names are application contracts, not generated SpacetimeDB bindings.
The data plane owns persistence, file storage, subscriptions, workflow execution,
job scheduling, retries, leases, calculation, proposal creation, approval state,
and export generation. No SpacetimeDB setup, reducers, SDK or implementation is
included here.

For example, `reviews.decide` validates the decision, reviewer name, proposal
reference and rejection reason, then delegates. The data plane checks whether
that proposal exists, whether its revision/hash is current, whether blockers
remain, and whether the caller may approve it. Similarly, `exports.create`
validates identifiers and delegates; it never writes or releases a CSV itself.

Caller identity and company scope are trusted server context, never accepted
from the request body. TypeScript context types do not authenticate callers.
Authentication must happen before calling these handlers, and the data plane
must enforce authorization and state-dependent rules atomically. The `system`
context identifies an internal request, not an additional database identity.

The gateway API barrel is not an automatic router or an agent tool registry.
Worker requests are imported separately from `api/worker.ts`. Requesting a
proposal build or a job transition delegates that action to the data plane;
the control plane does not perform it.

## Calling a handler

```ts
import { reviews } from "./api/index.ts";
import { unconnectedDataPlane } from "./data_plane.ts";

// Supply authenticated, server-created context. Replace the unconnected port
// with the data-plane team's adapter when available.
await reviews.decide(
  { kind: "gateway", companyId: "demo", serviceIdentity: "gateway", requestId: "request-1" },
  { caseId: "case-1", expectedRevision: 1, proposalId: "proposal-1",
    proposalHash: "hash-1", reviewerName: "Reviewer", decision: "APPROVE" },
  unconnectedDataPlane,
);
```

All handlers take `(context, input, dataPlane)`. Pass `{}` for `settings.get`.
Money is represented as integer-cent strings, dates as `YYYY-MM-DD`, and posting
periods as `YYYY-MM`. Semantic financial checks and actual file-content parsing
belong to the data plane. Allowed upload MIME types are CSV, JSON, plain text and
PDF; an allowed MIME label alone does not establish valid file content.

## Verification

From this directory, `npm test` runs the tests using Node's native TypeScript
support (Node 22.18+). With TypeScript installed, `tsc -p tsconfig.json` checks
strict types. No external service is required for these checks.
