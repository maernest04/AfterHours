// SpacetimeDB implementation of the control plane's DataPlane port (backend/control_plane/data_plane.ts)
// for the document operations that exist in this phase. Every other operation reports
// DATA_PLANE_UNAVAILABLE until its tables and reducers are built. Control-plane files are imported
// unchanged; this adapter converts between their string IDs and the database's u64 IDs.

import type { DataPlane, Operations } from '../../control_plane/data_plane.ts';
import type { GatewayContext, SystemContext, WorkerContext } from '../../control_plane/context.ts';
import { DataPlaneUnavailableError } from '../../control_plane/errors.ts';
import type { DbConnection } from '../bindings/index';
import { readDocument, uploadDocument } from './documents';

/** The fixed demo company. Requests scoped to any other company are rejected. */
export const COMPANY_ID = process.env.COMPANY_ID ?? 'demo';

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
  const handlers: Handlers = {
    'imports.upload': async (ctx, input) => {
      const doc = await uploadDocument(conn, {
        bytes: input.bytes,
        originalFilename: input.filename,
        mimeType: input.mediaType,
        docType: input.type,
        sourceLabel: `${ctx.kind}:${ctx.serviceIdentity}`,
      });
      return { uploadId: String(doc.id), contentHash: doc.contentHash };
    },

    'evidence.readDocument': async (_ctx, input) => {
      const documentId = toDbId(input.documentId, 'Document');
      let found;
      try {
        found = readDocument(conn, documentId);
      } catch {
        throw new DataPlaneRequestError('NOT_FOUND', 404, `Document ${input.documentId} not found`);
      }
      const { document, file, bytes } = found;
      // Documents uploaded before a case exists have no reference yet; once linked, enforce it.
      if (document.referenceId !== undefined && document.referenceId !== input.caseId) {
        throw new DataPlaneRequestError('NOT_FOUND', 404, `Document ${input.documentId} not found in case ${input.caseId}`);
      }
      return {
        document: {
          id: String(document.id),
          type: document.docType as Operations['evidence.readDocument']['output']['document']['type'],
          version: document.version,
          contentHash: document.contentHash,
        },
        mediaType: file.mimeType,
        bytes,
      };
    },
  };

  return {
    async execute(operation, context, input) {
      if (context.companyId !== COMPANY_ID) {
        throw new DataPlaneRequestError('FORBIDDEN', 403, `Unknown company ${context.companyId}`);
      }
      const handler = handlers[operation] as ((ctx: Context, input: unknown) => Promise<unknown>) | undefined;
      if (!handler) throw new DataPlaneUnavailableError(operation);
      return handler(context, input) as never;
    },
  };
}
