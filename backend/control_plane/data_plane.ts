import type { GatewayContext, WorkerContext, SystemContext } from "./context.ts";
import type {
  CaseRef, RevisionRef, CaseSummary, CaseUpdate, Page, PageRequest, JobSummary,
  JobLease, LeaseRef, Proposal, Review, Question, ExportReceipt, EvidenceFact,
  DocumentSummary, CompanySettings, Id,
} from "./contracts.ts";
import type { UploadRequest, UploadReceipt, FinalizeImportRequest } from "./api/imports.ts";
import type { ListCasesRequest, SubscribeRequest } from "./api/cases.ts";
import type { ClaimRequest, CompleteRequest } from "./api/worker.ts";
import type { AskRequest } from "./api/questions.ts";
import type { ResolveRequest } from "./api/exceptions.ts";
import type { DecideRequest } from "./api/reviews.ts";
import type { CreateExportRequest, DownloadRequest, CsvDownload } from "./api/exports.ts";
import type { ConfigureRequest } from "./api/settings.ts";
import { DataPlaneUnavailableError } from "./errors.ts";

type Operation<Input, Output> = { input: Input; output: Output };
/** Consumer-owned port, not a data-plane implementation or SpacetimeDB binding. */
export interface Operations {
  "imports.upload": Operation<UploadRequest, UploadReceipt>;
  "imports.finalize": Operation<FinalizeImportRequest, CaseSummary>;
  "cases.list": Operation<ListCasesRequest, Page<CaseSummary>>;
  "cases.get": Operation<CaseRef, CaseSummary | null>;
  "cases.startReview": Operation<RevisionRef, CaseSummary>;
  "cases.listJobs": Operation<CaseRef & PageRequest, Page<JobSummary>>;
  "cases.subscribe": Operation<SubscribeRequest, AsyncIterable<CaseUpdate>>;
  "worker.claim": Operation<ClaimRequest, JobLease>;
  "worker.heartbeat": Operation<LeaseRef, { leaseExpiry: string }>;
  "worker.complete": Operation<CompleteRequest, JobSummary>;
  "questions.ask": Operation<AskRequest, Question>;
  "questions.list": Operation<CaseRef & PageRequest, Page<Question>>;
  "exceptions.resolve": Operation<ResolveRequest, CaseSummary>;
  "proposals.get": Operation<CaseRef & { proposalId: Id }, Proposal | null>;
  "proposals.build": Operation<RevisionRef, Proposal | null>;
  "reviews.decide": Operation<DecideRequest, Review>;
  "reviews.list": Operation<CaseRef & PageRequest, Page<Review>>;
  "exports.create": Operation<CreateExportRequest, ExportReceipt>;
  "exports.download": Operation<DownloadRequest, CsvDownload>;
  "evidence.list": Operation<CaseRef & PageRequest, Page<EvidenceFact>>;
  "evidence.readDocument": Operation<CaseRef & { documentId: Id }, {
    document: DocumentSummary; mediaType: string; bytes: Uint8Array;
  }>;
  "settings.get": Operation<Record<string, never>, CompanySettings>;
  "settings.configure": Operation<ConfigureRequest, CompanySettings>;
}

export interface DataPlane {
  execute<K extends keyof Operations>(
    operation: K,
    context: GatewayContext | WorkerContext | SystemContext,
    input: Operations[K]["input"],
  ): Promise<Operations[K]["output"]>;
}

/** Explicit placeholder for callers until the data-plane team supplies an adapter. */
export const unconnectedDataPlane: DataPlane = {
  async execute(operation) {
    throw new DataPlaneUnavailableError(operation);
  },
};
