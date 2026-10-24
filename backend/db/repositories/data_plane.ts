// SpacetimeDB implementation of the control plane's DataPlane port (backend/control_plane/data_plane.ts).
// Control-plane files are imported unchanged; this adapter converts between their string IDs and the
// database's u64 IDs. Operations not built yet (proposals, reviews, questions, exceptions, exports,
// settings.configure) report DATA_PLANE_UNAVAILABLE.
//
// Connect with connectService('gateway') for gateway operations and connectService('worker') for
// worker.* operations — the reducers check the caller identity.

import type { DataPlane, Operations } from '../../control_plane/data_plane.ts';
import type { GatewayContext, SystemContext, WorkerContext } from '../../control_plane/context.ts';
import type { CaseUpdate, DocumentType as ControlPlaneDocumentType } from '../../control_plane/contracts.ts';
import { DataPlaneUnavailableError } from '../../control_plane/errors.ts';
import type { DbConnection } from '../bindings/index';
import { finalizeImport, getCase, listCases, listFacts, listJobs, paginate, startReview, toCaseSummary, toEvidenceFact, toJobSummary } from './cases';
import { readDocument, uploadDocument } from './documents';
import { allowedEvidenceIds, claimJob, completeJob, heartbeatJob } from './jobs';

type Context = GatewayContext | WorkerContext | SystemContext;
type Handlers = { [K in keyof Operations]?: (ctx: Context, input: Operations[K]['input']) => Promise<Operations[K]['output']> };

export class DataPlaneRequestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'DataPlaneRequestError';
    this.code = code;
    this.status = status;
  }
}

const notFound = (what: string) => new DataPlaneRequestError('NOT_FOUND', 404, `${what} not found`);

function toDbId(id: string, what: string): bigint {
  if (!/^\d+$/.test(id)) throw notFound(`${what} ${id}`);
  return BigInt(id);
}

function requireKind(ctx: Context, kind: Context['kind']) {
  if (ctx.kind !== kind) throw new DataPlaneRequestError('FORBIDDEN', 403, `This operation requires a ${kind} context.`);
}

export function createSpacetimeDataPlane(conn: DbConnection): DataPlane {
  const settings = () => {
    const s = [...conn.db.settingsView.iter()][0];
    if (!s) throw new DataPlaneRequestError('NOT_CONFIGURED', 503, 'Settings are not visible; run `npm run db:bootstrap` and connect as a service identity.');
    return s;
  };
  const caseOrThrow = (caseId: string) => {
    const c = getCase(conn, toDbId(caseId, 'Case'));
    if (!c) throw notFound(`Case ${caseId}`);
    return c;
  };

  const handlers: Handlers = {
    // --- imports -------------------------------------------------------------------------------
    'imports.upload': async (ctx, input) => {
      const doc = await uploadDocument(conn, {
        companyId: ctx.companyId,
        bytes: input.bytes,
        originalFilename: input.filename,
        mediaType: input.mediaType,
        type: input.type,
        sourceLabel: `${ctx.kind}:${ctx.serviceIdentity}`,
      });
      return { uploadId: String(doc.id), contentHash: doc.contentHash };
    },

    'imports.finalize': async (ctx, input) => {
      const c = await finalizeImport(conn, {
        companyId: ctx.companyId,
        idempotencyKey: input.idempotencyKey,
        documentIds: input.uploadIds.map(id => toDbId(id, 'Upload')),
        vendorId: input.vendorId,
        servicePeriod: input.servicePeriod,
        postingPeriod: input.postingPeriod,
        originalStatus: input.originalStatus,
        originalAmountCents: input.originalAmountCents,
        sourceEntryId: input.sourceEntryId,
      });
      return toCaseSummary(c);
    },

    // --- cases ---------------------------------------------------------------------------------
    'cases.list': async (_ctx, input) =>
      paginate(listCases(conn, { state: input.state }).map(toCaseSummary), input.cursor, input.limit),

    'cases.get': async (_ctx, input) => {
      const c = /^\d+$/.test(input.caseId) ? getCase(conn, BigInt(input.caseId)) : undefined;
      return c ? toCaseSummary(c) : null;
    },

    'cases.startReview': async (_ctx, input) => {
      const c = caseOrThrow(input.caseId);
      return toCaseSummary(await startReview(conn, c.id, input.expectedRevision));
    },

    'cases.listJobs': async (_ctx, input) => {
      const c = caseOrThrow(input.caseId);
      return paginate(listJobs(conn, c.id).map(toJobSummary), input.cursor, input.limit);
    },

    /** Live CASE_UPDATED / JOB_UPDATED events for one case (relayed from the gateway's views). */
    'cases.subscribe': async (_ctx, input) => {
      const c = caseOrThrow(input.caseId);
      return subscribeToCase(conn, c.id);
    },

    // --- worker (brief p.4 claim_job / heartbeat_job / complete_job) -----------------------------
    'worker.claim': async (ctx, input) => {
      requireKind(ctx, 'worker');
      return claimJob(conn, { jobId: toDbId(input.jobId, 'Job'), caseId: toDbId(input.caseId, 'Case'), expectedRevision: input.expectedRevision });
    },

    'worker.heartbeat': async (ctx, input) => {
      requireKind(ctx, 'worker');
      return heartbeatJob(conn, { jobId: toDbId(input.jobId, 'Job'), caseId: toDbId(input.caseId, 'Case'), expectedRevision: input.expectedRevision, leaseToken: input.leaseToken });
    },

    'worker.complete': async (ctx, input) => {
      requireKind(ctx, 'worker');
      const ref = { jobId: toDbId(input.jobId, 'Job'), caseId: toDbId(input.caseId, 'Case'), expectedRevision: input.expectedRevision, leaseToken: input.leaseToken };
      return toJobSummary(await completeJob(conn, ref, input.modelRun, input.output));
    },

    // --- evidence ------------------------------------------------------------------------------
    'evidence.list': async (_ctx, input) => {
      const c = caseOrThrow(input.caseId);
      return paginate(listFacts(conn, c.id).map(toEvidenceFact), input.cursor, input.limit);
    },

    'evidence.readDocument': async (_ctx, input) => {
      const c = caseOrThrow(input.caseId);
      const documentId = toDbId(input.documentId, 'Document');
      // Case documents plus the vendor's mailbox attachments (same scope agents get).
      if (!allowedEvidenceIds(conn, c.id).includes(`doc:${documentId}`)) throw notFound(`Document ${input.documentId} in case ${input.caseId}`);
      const { document, bytes } = readDocument(conn, documentId);
      return {
        document: {
          id: String(document.id),
          type: document.type as ControlPlaneDocumentType,
          version: document.version,
          contentHash: document.contentHash,
        },
        mediaType: document.mediaType,
        bytes,
      };
    },

    'settings.get': async () => {
      const s = settings();
      return {
        companyId: s.companyId,
        currency: 'USD',
        expenseAccount: s.expenseAccount,
        liabilityAccount: s.liabilityAccount,
        policyVersion: s.policyVersion,
      };
    },
  };

  return {
    async execute(operation, context, input) {
      // Brief: bind all operations to the fixed demo company.
      if (context.companyId !== settings().companyId) {
        throw new DataPlaneRequestError('FORBIDDEN', 403, `Unknown company ${context.companyId}`);
      }
      const handler = handlers[operation] as ((ctx: Context, input: unknown) => Promise<unknown>) | undefined;
      if (!handler) throw new DataPlaneUnavailableError(operation);
      return handler(context, input) as never;
    },
  };
}

/** Async stream of case/job changes from the replica. Stop by calling `return()` on the iterator. */
function subscribeToCase(conn: DbConnection, caseId: bigint): AsyncIterable<CaseUpdate> {
  return {
    [Symbol.asyncIterator]() {
      const queue: CaseUpdate[] = [];
      let wake: (() => void) | undefined;
      let sequence = 0n;
      let closed = false;
      const push = (u: Omit<CaseUpdate, 'sequence'> & { kind: CaseUpdate['kind'] }) => {
        if (closed) return;
        queue.push({ ...u, sequence: String(++sequence) } as CaseUpdate);
        wake?.();
      };
      const onCase = (_ctx: unknown, row: Parameters<typeof toCaseSummary>[0]) => {
        if (row.id === caseId) push({ kind: 'CASE_UPDATED', case: toCaseSummary(row) } as CaseUpdate);
      };
      const onJob = (_ctx: unknown, row: Parameters<typeof toJobSummary>[0]) => {
        if (row.caseId === caseId) push({ kind: 'JOB_UPDATED', job: toJobSummary(row) } as CaseUpdate);
      };
      // Views emit onInsert for new rows and onUpdate for changed rows (same primary key).
      const onCaseUpdate = (ctx: unknown, _old: Parameters<typeof toCaseSummary>[0], row: Parameters<typeof toCaseSummary>[0]) => onCase(ctx, row);
      const onJobUpdate = (ctx: unknown, _old: Parameters<typeof toJobSummary>[0], row: Parameters<typeof toJobSummary>[0]) => onJob(ctx, row);
      conn.db.casesView.onInsert(onCase);
      conn.db.casesView.onUpdate(onCaseUpdate);
      conn.db.jobsView.onInsert(onJob);
      conn.db.jobsView.onUpdate(onJobUpdate);
      const close = () => {
        closed = true;
        conn.db.casesView.removeOnInsert(onCase);
        conn.db.casesView.removeOnUpdate(onCaseUpdate);
        conn.db.jobsView.removeOnInsert(onJob);
        conn.db.jobsView.removeOnUpdate(onJobUpdate);
        wake?.();
      };
      return {
        async next() {
          while (queue.length === 0 && !closed) await new Promise<void>(r => (wake = r));
          wake = undefined;
          const value = queue.shift();
          return value ? { value, done: false } : { value: undefined, done: true };
        },
        async return() {
          close();
          return { value: undefined, done: true };
        },
      };
    },
  };
}
