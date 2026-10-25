// Owner-only maintenance for the explicitly labelled Intuit rehearsal. This is
// intentionally absent from the application API and cannot reset other cases.
import { SenderError, t } from 'spacetimedb/server';
import spacetimedb from './schema';
import { requireOwner } from './auth';

export const resetIntuitDemoCase = spacetimedb.reducer({
  caseId: t.u64(), sourceEntryId: t.string(), vendorId: t.string(),
  expectedRevision: t.u32(), expectedProposalHash: t.string(),
}, (ctx, a) => {
  requireOwner(ctx);
  const c = ctx.db.cases.id.find(a.caseId);
  const intuit = c && /^QBO-JE-\d+-DEMO-7000$/.test(c.sourceEntryId) && /^QBO-\d+$/.test(c.vendorId) &&
    c.postingPeriod === '2026-09' && c.servicePeriodFrom === '2026-09-01' && c.servicePeriodTo === '2026-09-30';
  const synthetic = c && /^V-DEMO-[0-9a-f-]{36}$/.test(c.vendorId) &&
    c.sourceEntryId === `ACR-DEMO-${c.vendorId.slice('V-DEMO-'.length)}` &&
    c.postingPeriod === '2026-11' && c.servicePeriodFrom === '2026-11-01' && c.servicePeriodTo === '2026-11-30';
  if (!c || c.sourceEntryId !== a.sourceEntryId || c.vendorId !== a.vendorId ||
      (!intuit && !synthetic) ||
      c.originalAmountCents !== '700000' || c.originalStatus !== 'POSTED' ||
      c.companyId !== ctx.db.settings.id.find(0)?.companyId) {
    throw new SenderError('Only an explicitly labelled $7,000 demo case may be reset.');
  }
  const proposal = c.currentProposalId === undefined ? undefined : ctx.db.proposals.id.find(c.currentProposalId);
  const jobs = [...ctx.db.jobs.caseId.filter(c.id)];
  if (c.inputRevision !== a.expectedRevision || (proposal?.hash ?? '') !== a.expectedProposalHash ||
      ['IMPORTED', 'EXTRACTING', 'MATCHING', 'INVESTIGATING'].includes(c.state) ||
      jobs.some(j => ['QUEUED', 'RUNNING'].includes(j.status))) {
    throw new SenderError('Review changed or still has active work. Wait for the pipeline to stop and retry.');
  }
  // One transaction: no intermediate state with dangling case/evidence references.
  for (const row of ctx.db.allocations.caseId.filter(c.id)) ctx.db.allocations.id.delete(row.id);
  for (const row of ctx.db.jobResults.caseId.filter(c.id)) ctx.db.jobResults.id.delete(row.id);
  for (const row of ctx.db.proposals.caseId.filter(c.id)) ctx.db.proposals.id.delete(row.id);
  for (const row of jobs) ctx.db.jobs.id.delete(row.id);
  for (const row of ctx.db.workItems.caseId.filter(c.id)) ctx.db.workItems.id.delete(row.id);
  for (const row of ctx.db.invoiceLines.caseId.filter(c.id)) ctx.db.invoiceLines.id.delete(row.id);
  for (const row of ctx.db.ledgerRecords.caseId.filter(c.id)) ctx.db.ledgerRecords.id.delete(row.id);
  for (const row of ctx.db.facts.caseId.filter(c.id)) ctx.db.facts.id.delete(row.id);
  for (const row of ctx.db.caseDocuments.caseId.filter(c.id)) ctx.db.caseDocuments.id.delete(row.id);
  ctx.db.cases.id.delete(c.id);
  // Immutable original documents, mailbox evidence, settings and other cases stay intact.
});
