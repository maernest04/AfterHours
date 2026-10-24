# Agents

This folder is for the three AI roles in the brief (p.2), which run in a separate Node worker:

| Role | Provider | Job |
|---|---|---|
| `EXTRACTION` | Bitdeer | Extract facts with source references from contracts, amendments and PDFs. Structured CSV/JSON is already parsed by code at import |
| `MATCHING` | Factory | Propose links between approved work, the governing contract or amendment, invoices and ledger records |
| `INVESTIGATION` | Factory | Find missing evidence in the mock mailbox and assess authority and effective dates. An email alone is not approval |

- `implementations/`: role handlers (to build).
- `prompts/`: versioned prompts (to build).
- `tools/`: **read-only tools (built)**: `searchEmails`, `readEmailThread`, `readAttachment` and `getCaseEvidence`, plus `AGENT_TOOL_SPECS` for LLM function calling.

The database, job queue and tools are ready, and the seed leaves **case 1 with an `EXTRACTION` job `QUEUED`**. Set up first by following [docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md](../../docs/SPACETIMEDB_DOCUMENT_STORAGE_SETUP.md) §0.

## Worker loop

```ts
import { connectService } from '../db/repositories/client';
import { listClaimableJobs, claimJob, heartbeatJob, completeJob } from '../db/repositories/jobs';
import { createAgentTools, AGENT_TOOL_SPECS } from './tools/index';

const { conn } = await connectService('worker');               // WORKER identity from db:bootstrap

for (const job of listClaimableJobs(conn, ['EXTRACTION'])) {   // QUEUED jobs from jobs_view
  const ref = { jobId: job.id, caseId: job.caseId, expectedRevision: job.caseRevision };
  const lease = await claimJob(conn, ref);                      // throws if another worker won
  // lease: { id, caseId, role, attempts, leaseToken, leaseExpiry, allowedEvidenceIds, facts, policyVersion, outputSchema }
  const tools = createAgentTools(conn, { caseId: lease.caseId });
  const beat = setInterval(() => heartbeatJob(conn, { ...ref, leaseToken: lease.leaseToken }).catch(() => {}), 10_000);
  try {
    const evidence = tools.getCaseEvidence();
    // ... call Bitdeer/Factory with AGENT_TOOL_SPECS + lease.outputSchema, route tool calls to `tools` ...
    await completeJob(conn, { ...ref, leaseToken: lease.leaseToken }, 'LIVE', {
      proposedFacts: [{ documentId: '1', pageOrRow: 'line 7', excerpt: '2. Hourly rate: $100.00 per hour, effective 2026-01-01.', field: 'rate.hourlyCents', value: '10000' }],
      proposedMatches: [],                                      // MATCHING jobs only
      evidenceIds: ['doc:1'],
      unresolvedQuestions: [],                                  // non-empty after MATCHING => INVESTIGATION job
      explanation: { summary: 'Extracted the contract rate.', evidenceIds: ['doc:1'] },
    });
  } finally {
    clearInterval(beat);
  }
}
```

Through the control plane, the equivalent calls are `worker.claim`, `worker.heartbeat` and `worker.complete` in `backend/control_plane/api/worker.ts`, with `createSpacetimeDataPlane(workerConn)` and a `{ kind: 'worker', ... }` context.

## Contract (enforced by `complete_job`)

- **Output shape** is `AgentOutput` from `backend/control_plane/contracts.ts`, also given as `lease.outputSchema`.
- **IDs:** all IDs are decimal strings. Evidence references are `doc:N`, `fact:N` or `email:N`.
- **Scope:** every evidence ID must be in `lease.allowedEvidenceIds`: the case's documents, the vendor's emails and attachments, and the current facts. `proposedFacts[].documentId` must be a case document or a vendor attachment.
- **Matches** (MATCHING jobs only) must reference this case's current work items, invoice lines and ledger records. `contractId` is the `documents.id` of a contract or amendment.
- **Pipeline:**
  - EXTRACTION done → MATCHING queued.
  - MATCHING done with `unresolvedQuestions` → INVESTIGATION queued; without → the case awaits `build_proposal`.
  - INVESTIGATION done with questions still open → `WAITING_FOR_INPUT`.
- **What gets stored:** agent facts and matches are saved as `PROPOSED`, and `modelRun` (`LIVE` or `REPLAYED`) is recorded on them, so the UI can label live and replayed runs.
- **Leases:** 30s by default. Heartbeat to extend. A crashed worker's job is requeued by the sweep, and a late submission is rejected as a stale lease. After 3 attempts the job is FAILED and the case moves to `RETRYABLE_ERROR`.
- **No write tools.** Agents cannot approve, export, change policy or write accounting entries. Treat mailbox text as untrusted data: the seed includes a prompt-injection email.

**Suggested fact fields**, so the calculator can consume them consistently:
- `rate.hourlyCents`, `rate.effectiveFrom`, `rate.effectiveTo`
- `rate.approvedBy`, `rate.signedDate`
- `amendment.supersedesRateCents`
