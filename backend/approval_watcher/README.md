# Approval email watcher

A small Python approval evaluator and polling service with an **explicit mock
adapter**. It accepts an exact reviewer command only after checking the proposal
identity/version, input revision, policy version, content hash binding, authorized
sender, request token, thread and expiry. It never sends email, calculates amounts,
posts entries or enables exports. No model inference is used.

The authoritative mailbox authentication, approval-request records and decision
reducer are **not configured**. The default CLI exits with an error. Existing
SpacetimeDB proposals can supply proposal data, but its mock email `sender` field
alone cannot prove who approved a proposal.

## Run locally with uv

From the repository root:

```sh
uv sync --project backend/approval_watcher
uv run --project backend/approval_watcher python -m unittest discover -s backend/approval_watcher/tests -v
uv run --project backend/approval_watcher afterhours-approval-watcher \
  --mock-fixture backend/approval_watcher/examples/mock-inbox.json --once
```

The fixture emits `QUESTION`, `WAITING_FOR_ANSWER`, then `MANUAL_REVIEW`, all labeled
`MOCK`. The synthetic request expires on 2027-01-01; update fixture dates for
later demos. Its long validity and public token are demo data, not production
request policy. Omit `--once` to poll every five seconds; `--poll-seconds` changes
the interval. SIGINT/SIGTERM stop the loop. There are no runtime dependencies.

The JSON mailbox is reread on every poll, so new synthetic messages can be
appended while it runs. Write fixture updates atomically; invalid JSON stops the
CLI with an error. Proposal/current-case snapshots load at startup. Restart to
reload them. **All mock decisions, audit records and duplicate detection are
in memory and reset on restart**. This adapter must never authorize real exports.

## Docker

The Docker build context is this directory:

```sh
docker build -t afterhours-approval-watcher backend/approval_watcher
docker run --rm afterhours-approval-watcher python -m unittest discover -s tests -v
docker run --rm afterhours-approval-watcher afterhours-approval-watcher \
  --mock-fixture /app/examples/mock-inbox.json --once
```

The image installs the locked Python package with uv. Running the image without
arguments fails explicitly because authoritative persistence is unavailable.
Continuous mock polling uses the last command without `--once`. A mutable demo
inbox can be mounted read-only at a separate path and passed with
`--mock-fixture`. No database credentials, external provider keys or mail access
are required. Root Compose is intentionally outside this package's scope.

## Proposed reply contract

This is an integration assumption for the approval-request sender, not an
existing application contract. A request must present the immutable proposal
content and the exact reply command to its authorized reviewer:

```text
APPROVE 11 v2 <request-token>
REJECT 11 v2 <request-token>
QUESTION 11 v2 <request-token>
Why did the hourly rate change?
```

Choose **one** command. Approval and rejection must occupy the entire body,
apart from surrounding whitespace. A question requires text after the first
line. The proposal ID and version are positive decimal integers. Tokens are
32–128 URL-safe characters; the future request service must generate an
unpredictable token, persist it bound to the immutable proposal hash, and keep it
out of logs. Token possession alone is insufficient: reviewer authorization and
trusted sender identity are independently required. Tokens are consumed by a
terminal decision; questions do not consume them.

Quoted/forwarded commands, signatures, multiple commands, conditional approval,
and plain text such as “approved” produce `MANUAL_REVIEW`. The parser never
extracts an approval keyword from text or uses an LLM to infer approval. Natural
language questions also go to manual review unless they follow `QUESTION`.
Nothing automatically answers a question or resumes investigation. In this MVP,
any one authorized reviewer may make the first valid terminal decision; multiple
reviewer quorum policies are not implemented. An unanswered question blocks subsequent approval with `WAITING_FOR_ANSWER`.
Only the authoritative answer workflow may explicitly clear `pending_question`
after answering; the watcher never clears it from incoming approval text.
Rejection remains available. A new approval message is required after the
question is answered; the previously blocked message retains its original receipt.

## Required proposal and authority inputs

`core.Proposal` is a trusted approval-request snapshot, never constructed from
email claims. Map the current server data as follows:

- `proposal_id`, `version`: `proposals_view.id`, `.version` (Python integers).
- `case_id`, `case_revision`: proposal `.case_id`, `.input_revision`.
- `policy_version`: proposal `.policy_version`.
- `content_sha256`: proposal `.hash`, the server-computed SHA-256 digest of the
  proposal, including its journal/evidence/amount content. Do not replace it
  with a hash of an email or rederive accounting values in the watcher.
- `company_id`: the owning case's `.company_id`; check proposal/case ownership.
- `request_token`, `thread_id`, `issued_at`, `expires_at`, `reviewers`, `status`,
  `pending_question`:
  **new authoritative approval-request/decision records are required**. They do
  not currently come from proposal rows. Bind the request to the exact hash
  when issuing it. Derive reviewers from trusted company policy, never email
  text. `status` is the approval request's state, not a field the watcher assumes
  already exists on the proposal table.

`core.CurrentCase` supplies the current case input revision, current proposal ID
and version, and current policy version. Its proposal ID must come from the
case's `current_proposal_id`; merely finding a proposal with a matching version
is insufficient. Read these values and the latest authorization/status in the
same transaction that persists the decision. A changed revision, proposal or
policy makes the old request `STALE`.

`core.Email` requires a stable provider message ID, tenant/company scope, thread
ID, trusted received timestamp, body, bare sender address and
`authenticated_sender`. The last field must come from trusted authenticated
provider metadata or a controlled mock inbox, **never from a claimed From header,
email body or model output**. The existing DB mock mailbox does not supply this
proof; a future adapter must leave it `None` when it cannot establish identity.
This MVP normalizes bare ASCII email addresses to lowercase; it does not support
display names, aliases, domain-only authorization or email authentication itself.
All timestamps must include time zones. Processing after request expiry is
invalid even if the email arrived earlier.

## Repository and provider boundary

`runtime.Mailbox.poll()` returns at-least-once envelopes. No cursor is required;
`poll_once()` relies on repository idempotency, emits only newly recorded results,
and propagates storage errors. `runtime.ApprovalRepository.process()` is the
atomic authorization/persistence boundary. A production SpacetimeDB adapter must:

1. Uniquely identify messages by trusted `(company_id, message_id)` and store a
   fingerprint of the full envelope/content. Same identity/content returns the
   original receipt; changed content records `MESSAGE_ID_COLLISION` and never
   changes approval status.
2. Read current case/proposal/policy, bound request hash, reviewer authorization,
   request expiry and decision state inside its transaction/reducer. Recheck
   these at commit, rather than trusting a previously evaluated Python result.
3. Persist the immutable receipt and terminal decision together. Record message
   identity/fingerprint, proposal ID/version/hash, case/revision, policy version,
   authenticated reviewer, outcome, reason and processing time. Questions carry
   their text in the audit record. Never persist credentials in logs.
4. Apply only `APPROVED` or `REJECTED` to a pending request. A competing terminal
   decision returns `CLOSED`. A question marks the request as awaiting an answer
   and blocks APPROVE until the answer workflow explicitly clears the flag.
   Invalid, stale,
   ambiguous and unknown replies never change accounting or proposal state.
5. Keep persistence and deduplication durable across service restarts, and expose
   recorded questions/manual-review outcomes through the review workflow.

`core.evaluate()` is pure logic returning a candidate, **not write authority**.
`MemoryMockRepository` serializes evaluation and state changes under a lock for
single-process demos. `UnconfiguredRepository` raises rather than claiming a
live decision was saved. The mock records unknown/invalid messages once; if a
request was not ready when a reply arrived, a new message or an explicit audited
retry mechanism is needed. Automatic retries of rejected commands are absent.

The service does not set a database case to APPROVED/REJECTED, publish events,
create email requests, implement reviewer identities, or alter API/export routes.
Those integration pieces require the durable repository and trusted identity
boundary above; no schema or SDK changes are included here.

## Verification coverage

The tests exercise exact binding, stale revision/version/policy, unauthorized or
unauthenticated senders, thread/token mismatch, expiry and timestamp bounds,
quoted/conditional/multiple commands, questions, duplicate/colliding message IDs,
concurrent approvals/rejections, polling, explicit unconfigured failures, and
real subprocess CLI behavior. They use synthetic envelopes and do not claim
real email authentication or database approval integration.
