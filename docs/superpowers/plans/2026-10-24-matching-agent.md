# Matching agent implementation plan

**Goal:** Seed realistic local cases first, then implement and test a Python matching worker using the existing SDK and leased MATCHING jobs.

**Scope:** Matching only. Extraction and investigation belong to other contributors. Their contracts and the database module stay unchanged. Approval, proposals, public APIs and frontend are separate work.

**Design:** A separate `afterhours-agents` Python package uses the SDK's case-scoped read tools to assemble evidence. Factory receives evidence and a strict output schema. The worker validates returned references and basic matching invariants before committing proposed allocations. It renews the lease during inference and stops without completion if ownership is lost. Provider failures expire through the existing retry policy. No fallback silently replaces a failed model with fabricated results.

The fixture seeder creates six independent synthetic cases (clean, amendment boundary, missing amendment, ambiguous invoices, uninvoiced work, conflicting contracts), including unrelated invoice/ledger records and unapproved timesheets. It completes only their EXTRACTION jobs with explicit REPLAYED provenance. Re-running a namespace preserves existing cases and completed jobs.

- [x] Seed fixtures and verify real imported rows, scope, idempotency and queued matching jobs before implementing the agent.
- [x] Add failing tests for output validation, prompt grounding, provider errors, lease renewal and cancellation. Implement matching handler and Factory subprocess adapter.
- [x] Add a Python worker CLI and local Docker service with uv installation, read-only evidence/token mounts and bounded model execution.
- [x] Run all six cases through the real DB/worker with explicitly replayed provider responses, assert exact persisted allocations and investigation routing. Test rejection paths and no duplicate completion.
- [ ] Run live Factory cases if credentials are available. Report separately if unavailable; replay does not prove model accuracy.
- [x] Run SDK, API, frontend and module checks; document commands, boundaries and remaining integration.

**Verification focus:** wrong-vendor/period ledger links; wrong-contractor/date invoice links; invented IDs; missing work silently accepted; duplicate allocations; unposted invoices confused with posted; rate ambiguity; model timeout or malformed output; heartbeat failure preventing completion.

**Provider:** Keep Factory as assigned in the repo and confirmed by the user. Live matching requires both key and model configuration; replay verification is independent of credentials.

**Verified:** 19 matching tests covered across host and Docker (host skips the packaged CLI check; Docker skips the owner-only short-lease check). All six replay scenarios persist expected allocations/handoffs. SDK 29 tests, API 16 tests plus live Docker pagination/stub checks, approval watcher 30 host/Docker tests, frontend 25 tests and module typecheck passed. Upstream investigation/calculator tests also passed against the updated DB with the paid live-model test skipped. Factory 0.249.0 is pinned; its tested allowlist permits only TodoWrite bookkeeping. Live inference has not been tested.

**Parallel follow-up:** Approval/email evaluation and mock polling are implemented; authoritative mailbox/storage adapters remain stubs. API listing now reads the SDK (max10); create/get/export remain501 behind typed service interfaces. Investigation commit719c2c3 was merged; both agent packages and CLIs are included in the shared Python package. These tasks do not change matching's proposal-only responsibility.
