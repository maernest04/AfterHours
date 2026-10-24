// SpacetimeDB implementation of the control plane's DataPlane port (backend/control_plane/data_plane.ts)
// for the operations that exist in this phase. Every other operation reports DATA_PLANE_UNAVAILABLE
// until its tables and reducers are built. Control-plane files are imported unchanged; this adapter
// converts between their string IDs and the database's u64 IDs.
//
// Pass a connection made with connectService('gateway'): document writes are gateway-only.

import type { DataPlane, Operations } from '../../control_plane/data_plane.ts';
import type { GatewayContext, SystemContext, WorkerContext } from '../../control_plane/context.ts';
import type { DocumentType as ControlPlaneDocumentType } from '../../control_plane/contracts.ts';
import { DataPlaneUnavailableError } from '../../control_plane/errors.ts';
import type { DbConnection } from '../bindings/index';
import { readDocument, uploadDocument } from './documents';

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

function toDbId(id: string, what: string): bigint {
  if (!/^\d+$/.test(id)) throw new DataPlaneRequestError('NOT_FOUND', 404, `${what} ${id} not found`);
  return BigInt(id);
}

export function createSpacetimeDataPlane(conn: DbConnection): DataPlane {
  const settings = () => {
    const s = [...conn.db.settingsView.iter()][0];
    if (!s) throw new DataPlaneRequestError('NOT_CONFIGURED', 503, 'Settings are not visible; run `npm run db:bootstrap` and connect as a service identity.');
    return s;
  };

  const handlers: Handlers = {
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

    'evidence.readDocument': async (_ctx, input) => {
      let found;
      try {
        found = readDocument(conn, toDbId(input.documentId, 'Document'));
      } catch (err) {
        if (err instanceof DataPlaneRequestError) throw err;
        throw new DataPlaneRequestError('NOT_FOUND', 404, `Document ${input.documentId} not found`);
      }
      const { document, bytes } = found;
      // Documents uploaded before a case exists have no reference yet; once linked, enforce it.
      if (document.referenceId !== undefined && document.referenceId !== input.caseId) {
        throw new DataPlaneRequestError('NOT_FOUND', 404, `Document ${input.documentId} not found in case ${input.caseId}`);
      }
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
