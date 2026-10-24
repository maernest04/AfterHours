// Read-only agent tools (brief p.3 "Agent tools and contracts"). Worker tools query the worker's
// authorized SpacetimeDB view cache and the file store; scope is bound to the job (its case and
// vendor), never chosen by the model. There is deliberately no tool that writes, approves, exports
// or changes policy — the only write path is completeJob (backend/db/repositories/jobs.ts).
//
// previewCorrection(candidateMatches) arrives with the calculator in the build_proposal phase.
//
// IDs are decimal strings in tool I/O. Evidence references use "doc:N", "fact:N" and "email:N".

import type { DbConnection } from '../../db/bindings/index';
import { caseDocumentIds, getCase, listFacts, listJobs, toCaseSummary, toEvidenceFact, toJobSummary } from '../../db/repositories/cases';
import { readDocument } from '../../db/repositories/documents';
import { allowedEvidenceIds } from '../../db/repositories/jobs';

export class ToolScopeError extends Error {}

const MAX_SEARCH_RESULTS = 25;
const SNIPPET_CHARS = 240;

function snippet(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const hit = terms.map(t => lower.indexOf(t)).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, hit - 60);
  return (start > 0 ? '…' : '') + flat.slice(start, start + SNIPPET_CHARS) + (start + SNIPPET_CHARS < flat.length ? '…' : '');
}

export function createAgentTools(conn: DbConnection, job: { caseId: bigint | string }) {
  const caseId = BigInt(job.caseId);
  const theCase = () => {
    const c = getCase(conn, caseId);
    if (!c) throw new ToolScopeError(`Case ${caseId} is not visible to this worker`);
    return c;
  };
  const vendorEmails = () => [...conn.db.emailsView.iter()].filter(e => e.vendorId === theCase().vendorId);
  const attachmentsOf = (emailId: bigint) =>
    [...conn.db.attachmentsView.iter()].filter(a => a.emailId === emailId).map(a => String(a.documentId));

  return {
    /**
     * Keyword search over the vendor's mock mailbox. Returns bounded snippets and IDs only; read
     * threads or attachments for full text. `vendor`, if given, must be the job's vendor.
     */
    searchEmails(args: { vendor?: string; query: string; dateRange?: { from?: string; to?: string }; limit?: number }) {
      const c = theCase();
      if (args.vendor && args.vendor !== c.vendorId) throw new ToolScopeError(`Vendor ${args.vendor} is outside this job's scope`);
      const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
      const from = args.dateRange?.from;
      const to = args.dateRange?.to;
      return vendorEmails()
        .filter(e => (!from || e.sentAt.slice(0, 10) >= from) && (!to || e.sentAt.slice(0, 10) <= to))
        .map(e => ({ e, score: terms.filter(t => `${e.subject}\n${e.body}`.toLowerCase().includes(t)).length }))
        .filter(x => terms.length === 0 || x.score > 0)
        .sort((a, b) => b.score - a.score || (a.e.sentAt < b.e.sentAt ? 1 : -1))
        .slice(0, Math.min(args.limit ?? 10, MAX_SEARCH_RESULTS))
        .map(({ e }) => ({
          emailId: String(e.id),
          evidenceId: `email:${e.id}`,
          threadId: e.threadId,
          sender: e.sender,
          subject: e.subject,
          sentAt: e.sentAt,
          snippet: snippet(e.body, terms),
          attachmentDocumentIds: attachmentsOf(e.id),
        }));
    },

    /** Every message in one of the vendor's threads, oldest first. */
    readEmailThread(threadId: string) {
      const msgs = vendorEmails().filter(e => e.threadId === threadId);
      if (msgs.length === 0) throw new ToolScopeError(`Thread ${threadId} is outside this job's scope`);
      return msgs
        .sort((a, b) => (a.sentAt < b.sentAt ? -1 : 1))
        .map(e => ({
          emailId: String(e.id),
          evidenceId: `email:${e.id}`,
          sender: e.sender,
          recipients: e.recipients,
          subject: e.subject,
          sentAt: e.sentAt,
          body: e.body,
          attachmentDocumentIds: attachmentsOf(e.id),
        }));
    },

    /** Text of a case document or vendor attachment (CSV/JSON/text; PDFs page by page). Hash-verified. */
    async readAttachment(documentId: string) {
      if (!allowedEvidenceIds(conn, caseId).includes(`doc:${documentId}`)) {
        throw new ToolScopeError(`Document ${documentId} is outside this job's scope`);
      }
      const { document, bytes } = readDocument(conn, BigInt(documentId));
      let text: string;
      if (document.mediaType === 'application/pdf') {
        const { extractText, getDocumentProxy } = await import('unpdf');
        const { text: pages } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: false });
        text = (pages as string[]).map((p, i) => `--- page ${i + 1} ---\n${p}`).join('\n');
      } else {
        text = new TextDecoder().decode(bytes);
      }
      return {
        documentId: String(document.id),
        evidenceId: `doc:${document.id}`,
        type: document.type,
        version: document.version,
        filename: document.originalFilename,
        mediaType: document.mediaType,
        contentHash: document.contentHash,
        text,
      };
    },

    /** Everything recorded for the case at its current revision. */
    getCaseEvidence() {
      const c = theCase();
      const cur = <T extends { caseId: bigint; inputRevision: number }>(rows: Iterable<T>) =>
        [...rows].filter(r => r.caseId === caseId && r.inputRevision === c.inputRevision);
      const docs = new Set(caseDocumentIds(conn, caseId));
      return {
        case: toCaseSummary(c),
        documents: [...conn.db.documentsView.iter()]
          .filter(d => docs.has(d.id))
          .map(d => ({ documentId: String(d.id), evidenceId: `doc:${d.id}`, type: d.type, version: d.version, filename: d.originalFilename, mediaType: d.mediaType })),
        facts: listFacts(conn, caseId).map(f => ({ ...toEvidenceFact(f), evidenceId: `fact:${f.id}`, source: f.source })),
        workItems: cur(conn.db.workItemsView.iter()).map(w => ({
          id: String(w.id), factId: String(w.factId), contractor: w.contractor, serviceDate: w.serviceDate,
          approvedMinutes: w.approvedMinutes, claimedRateCents: w.claimedRateCents ?? null, approvedBy: w.approvedBy,
        })),
        invoiceLines: cur(conn.db.invoiceLinesView.iter()).map(l => ({
          id: String(l.id), factId: String(l.factId), invoiceNumber: l.invoiceNumber, contractor: l.contractor,
          serviceStart: l.serviceStart, serviceEnd: l.serviceEnd, minutes: l.minutes, amountCents: l.amountCents,
          postingStatus: l.postingStatus, postedDate: l.postedDate,
        })),
        ledgerRecords: cur(conn.db.ledgerRecordsView.iter()).map(r => ({
          id: String(r.id), factId: String(r.factId), entryId: r.entryId, vendorId: r.vendorId, period: r.period,
          kind: r.kind, amountCents: r.amountCents, status: r.status, description: r.description,
        })),
        allocations: cur(conn.db.allocationsView.iter()).map(a => ({
          id: String(a.id), workItemId: String(a.workItemId), contractId: String(a.contractDocumentId),
          invoiceLineIds: a.invoiceLineIds.map(String), ledgerEntryIds: a.ledgerRecordIds.map(String), evidenceIds: a.evidenceIds,
        })),
        jobs: listJobs(conn, caseId).map(toJobSummary),
        jobResults: [...conn.db.jobResultsView.iter()]
          .filter(r => r.caseId === caseId)
          .map(r => ({ jobId: String(r.jobId), modelRun: r.modelRun, summary: r.summary, unresolvedQuestions: r.unresolvedQuestions })),
        allowedEvidenceIds: allowedEvidenceIds(conn, caseId),
      };
    },
  };
}

export type AgentTools = ReturnType<typeof createAgentTools>;

/** Tool definitions for LLM function calling (Bitdeer / Factory). Read-only by construction. */
export const AGENT_TOOL_SPECS = [
  {
    name: 'searchEmails',
    description: "Keyword search of the mock finance mailbox for this case's vendor. Returns short snippets and IDs; use readEmailThread / readAttachment for full text.",
    input_schema: {
      type: 'object',
      properties: {
        vendor: { type: 'string', description: "Optional; must equal the case's vendorId" },
        query: { type: 'string', description: 'Keywords, e.g. "amendment hourly rate"' },
        dateRange: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, description: 'YYYY-MM-DD bounds' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS },
      },
      required: ['query'],
    },
  },
  {
    name: 'readEmailThread',
    description: 'All messages in a mailbox thread, oldest first, with attachment document IDs.',
    input_schema: { type: 'object', properties: { threadId: { type: 'string' } }, required: ['threadId'] },
  },
  {
    name: 'readAttachment',
    description: 'Full text of a case document or vendor email attachment, by document ID.',
    input_schema: { type: 'object', properties: { documentId: { type: 'string' } }, required: ['documentId'] },
  },
  {
    name: 'getCaseEvidence',
    description: 'The case, its documents, facts, work items, invoice lines, ledger records, allocations, jobs and allowed evidence IDs.',
    input_schema: { type: 'object', properties: {} },
  },
] as const;
