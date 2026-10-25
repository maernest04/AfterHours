import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { SenderError, t } from 'spacetimedb/server';
import spacetimedb, { proposals } from './schema';
import { companyForService, requireCompany, requireGateway, requireOwner } from './auth';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new SenderError(message);
}

function money(value: string): bigint {
  check(/^(0|[1-9][0-9]*)$/.test(value), 'Expected nonnegative integer cents.');
  return BigInt(value);
}

export const configurePostingPeriod = spacetimedb.reducer({ period: t.string(), open: t.bool() }, (ctx, a) => {
  requireOwner(ctx);
  check(/^\d{4}-(0[1-9]|1[0-2])$/.test(a.period), 'Invalid posting period.');
  const row = { period: a.period, open: a.open };
  if (ctx.db.postingPeriods.period.find(a.period)) ctx.db.postingPeriods.period.update(row);
  else ctx.db.postingPeriods.insert(row);
});

const WorkRate = t.object('WorkRate', { workItemId: t.u64(), rateFactId: t.u64() });
const Coverage = t.object('Coverage', { invoiceLineId: t.u64(), workItemId: t.u64(), minutes: t.u32() });

export const buildProposal = spacetimedb.reducer({
  caseId: t.u64(), expectedRevision: t.u32(), policyVersion: t.string(), entryDate: t.string(),
  workRates: t.array(WorkRate), coverage: t.array(Coverage), evidenceIds: t.array(t.string()),
}, (ctx, a) => {
  requireGateway(ctx);
  const c = ctx.db.cases.id.find(a.caseId);
  check(c && c.inputRevision === a.expectedRevision, 'Missing case or stale revision.');
  const settings = requireCompany(ctx, c.companyId);
  check(a.policyVersion === settings.policyVersion, 'Policy changed; rebuild the proposal.');
  check(ctx.db.postingPeriods.period.find(c.postingPeriod)?.open, 'Posting period closed or not configured; controller instructions required.');
  check(/^\d{4}-\d{2}-\d{2}$/.test(a.entryDate) && a.entryDate.slice(0, 7) === c.postingPeriod &&
        new Date(a.entryDate + 'T00:00:00Z').toISOString().slice(0, 10) === a.entryDate, 'Entry date must be valid and in the posting period.');
  check((['MATCHING', 'INVESTIGATING'].includes(c.state) || c.currentProposalId !== undefined) && c.blockers.length === 0,
        'Case is blocked or not awaiting a proposal.');
  const jobs = [...ctx.db.jobs.caseId.filter(c.id)].filter(j => j.caseRevision === c.inputRevision);
  check(jobs.length > 0 && jobs.every(j => j.status === 'SUCCEEDED'), 'Agent stages are incomplete.');
  const links = [...ctx.db.caseDocuments.caseId.filter(c.id)].filter(d => d.inputRevision === c.inputRevision);
  const docIds = new Set(links.map(link => link.documentId));
  for (const e of ctx.db.emails.vendorId.filter(c.vendorId)) {
    if (e.companyId === c.companyId) for (const attachment of ctx.db.attachments.emailId.filter(e.id)) docIds.add(attachment.documentId);
  }
  for (const document of ctx.db.documents.iter()) check(document.supersedesDocumentId === undefined ||
    !docIds.has(document.supersedesDocumentId), 'Source document changed; a new case revision is required.');
  if (c.currentProposalId !== undefined) {
    const existing = ctx.db.proposals.id.find(c.currentProposalId);
    check(existing && existing.inputRevision === c.inputRevision && existing.policyVersion === settings.policyVersion,
          'An existing proposal must be superseded through a new revision.');
    return;
  }
  const facts = [...ctx.db.facts.caseId.filter(c.id)].filter(f => f.inputRevision === c.inputRevision);
  const allowed = new Set([...docIds].map(id => `doc:${id}`));
  for (const f of facts) allowed.add(`fact:${f.id}`);
  for (const e of ctx.db.emails.vendorId.filter(c.vendorId)) if (e.companyId === c.companyId) allowed.add(`email:${e.id}`);
  check(a.evidenceIds.length > 0 && a.evidenceIds.every(id => allowed.has(id)), 'Proposal evidence is missing or outside scope.');
  const work = [...ctx.db.workItems.caseId.filter(c.id)].filter(w => w.inputRevision === c.inputRevision);
  check(work.length > 0 && work.length === a.workRates.length, 'Every work item needs exactly one validated rate.');
  const rates = new Map<bigint, bigint>();
  let supported = 0n;
  for (const r of a.workRates) {
    const w = work.find(w => w.id === r.workItemId);
    const fact = facts.find(f => f.id === r.rateFactId);
    check(w && !rates.has(w.id) && w.vendorId === c.vendorId && w.serviceDate >= c.servicePeriodFrom &&
          w.serviceDate <= c.servicePeriodTo, 'Duplicate, wrong-vendor or out-of-period work.');
    check(fact && fact.field === 'rate.hourlyCents' && docIds.has(fact.documentId) &&
          fact.validationStatus !== 'REJECTED' && a.evidenceIds.includes(`fact:${fact.id}`), 'Rate must cite a current, source-validated fact.');
    const rate = money(fact.value);
    const cost = BigInt(w.approvedMinutes) * rate;
    check(cost % 60n === 0n, 'Fractional-cent work cost requires a rounding policy.');
    supported += cost / 60n;
    rates.set(w.id, rate);
  }
  const ledger = [...ctx.db.ledgerRecords.caseId.filter(c.id)].filter(l => l.inputRevision === c.inputRevision);
  const accruals = ledger.filter(l => l.vendorId === c.vendorId && l.kind === 'ACCRUAL' && l.status === 'POSTED' &&
    l.period >= c.servicePeriodFrom.slice(0, 7) && l.period <= c.servicePeriodTo.slice(0, 7) && money(l.amountCents) !== 0n);
  const original = money(c.originalAmountCents);
  if (c.originalStatus === 'POSTED') check(accruals.length === 1 && accruals[0].entryId === c.sourceEntryId &&
    money(accruals[0].amountCents) === original, 'Outstanding posted accrual is missing, inconsistent or duplicated.');
  else check(accruals.length === 0, 'Another posted accrual may already cover this draft.');
  for (const other of ctx.db.cases.companyId.filter(c.companyId)) check(other.id === c.id || other.vendorId !== c.vendorId ||
    other.originalStatus !== 'POSTED' || money(other.originalAmountCents) === 0n ||
    other.servicePeriodTo < c.servicePeriodFrom || other.servicePeriodFrom > c.servicePeriodTo,
    'Another posted case may cover the same work.');
  const invoices = [...ctx.db.invoiceLines.caseId.filter(c.id)].filter(i => i.inputRevision === c.inputRevision &&
    i.postingStatus === 'POSTED' && i.postedDate <= c.servicePeriodTo &&
    work.some(w => w.contractor === i.contractor && w.serviceDate >= i.serviceStart && w.serviceDate <= i.serviceEnd));
  check(new Set(invoices.map(i => i.invoiceNumber)).size === invoices.length, 'Duplicate invoice coverage.');
  const usedWork = new Map<bigint, number>();
  const usedInvoices = new Map<bigint, number>();
  for (const allocation of a.coverage) {
    const w = work.find(w => w.id === allocation.workItemId);
    const i = invoices.find(i => i.id === allocation.invoiceLineId);
    check(w && i && allocation.minutes > 0 && w.contractor === i.contractor &&
          w.serviceDate >= i.serviceStart && w.serviceDate <= i.serviceEnd, 'Invalid invoice/work coverage.');
    usedWork.set(w.id, (usedWork.get(w.id) ?? 0) + allocation.minutes);
    usedInvoices.set(i.id, (usedInvoices.get(i.id) ?? 0) + allocation.minutes);
    check(usedWork.get(w.id)! <= w.approvedMinutes, 'Work is double counted across invoices.');
  }
  let recorded = 0n;
  for (const invoice of invoices) {
    check(usedInvoices.get(invoice.id) === invoice.minutes, 'Ambiguous or incomplete invoice allocation.');
    const entries = ledger.filter(l => l.entryId === invoice.invoiceNumber && l.kind === 'INVOICE' &&
      l.vendorId === c.vendorId && l.status === 'POSTED' && l.period <= c.servicePeriodTo.slice(0, 7));
    check(entries.length === 1 && money(entries[0].amountCents) === money(invoice.amountCents), 'Invoice is not corroborated by a unique posted ledger record.');
    recorded += money(invoice.amountCents);
  }
  check(recorded <= supported, 'Recorded invoice cost exceeds supported work cost.');
  const target = supported - recorded;
  const adjustment = target - original;
  const exportAmount = adjustment === 0n ? 0n : c.originalStatus === 'POSTED' ? adjustment : target;
  check(adjustment === 0n || c.originalStatus === 'POSTED' || target > 0n,
        'Removing a zero-target draft requires accountant instructions; no zero journal is produced.');
  const amount = exportAmount < 0n ? -exportAmount : exportAmount;
  const expense = settings.expenseAccount;
  const liability = settings.liabilityAccount;
  check(expense.code !== liability.code, 'Expense and liability accounts must differ.');
  const journalLines = amount === 0n ? [] : [
    { accountCode: expense.code, accountName: expense.name, debitCents: exportAmount > 0n ? amount.toString() : '0', creditCents: exportAmount < 0n ? amount.toString() : '0' },
    { accountCode: liability.code, accountName: liability.name, debitCents: exportAmount < 0n ? amount.toString() : '0', creditCents: exportAmount > 0n ? amount.toString() : '0' },
  ];
  const version = [...ctx.db.proposals.caseId.filter(c.id)].length + 1;
  const evidenceIds = [...new Set(a.evidenceIds)].sort();
  const canonical = JSON.stringify([c.id.toString(), version, c.inputRevision, settings.policyVersion,
    original.toString(), supported.toString(), target.toString(), adjustment.toString(), exportAmount.toString(),
    a.entryDate, settings.currency, journalLines, evidenceIds]);
  const proposal = ctx.db.proposals.insert({ id: 0n, caseId: c.id, version, inputRevision: c.inputRevision,
    policyVersion: settings.policyVersion, originalAmountCents: original.toString(), supportedCostCents: supported.toString(),
    correctedTargetCents: target.toString(), adjustmentCents: adjustment.toString(), exportAmountCents: exportAmount.toString(),
    entryDate: a.entryDate, currency: settings.currency, journalLines, evidenceIds,
    hash: bytesToHex(sha256(new TextEncoder().encode(canonical))), createdAt: ctx.timestamp });
  ctx.db.cases.id.update({ ...c, currentProposalId: proposal.id,
    state: adjustment === 0n ? 'VERIFIED_NO_CHANGE' : 'READY_FOR_REVIEW', updatedAt: ctx.timestamp });
});

/** Gateway-only: surface a deterministic proposal failure instead of leaving a case looking active. */
export const markProposalFailure = spacetimedb.reducer({
  caseId: t.u64(), expectedRevision: t.u32(), reason: t.string(),
}, (ctx, a) => {
  requireGateway(ctx);
  const c = ctx.db.cases.id.find(a.caseId);
  check(c && c.inputRevision === a.expectedRevision, 'Missing case or stale revision.');
  check(['MATCHING', 'INVESTIGATING'].includes(c.state), 'Case is no longer awaiting a proposal.');
  const reason = a.reason.slice(0, 240);
  ctx.db.cases.id.update({ ...c, state: 'RETRYABLE_ERROR', blockers: [...c.blockers, `PROPOSAL_FAILED: ${reason}`], updatedAt: ctx.timestamp });
});

export const proposalsView = spacetimedb.view({ name: 'proposals_view', public: true }, t.array(proposals.rowType), ctx => {
  const company = companyForService(ctx);
  return company ? [...ctx.db.cases.companyId.filter(company)].flatMap(c => [...ctx.db.proposals.caseId.filter(c.id)]) : [];
});
