// Local smoke test for document storage, following the brief's process boundaries:
// gateway-only writes, private tables behind sender-checked views, bytes on the file store.
// Uses a unique reference ID per run, so it can run repeatedly. Requires `npm run db:bootstrap`.

import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, connectService, DB_NAME, DB_URI, ownerToken, waitFor } from '../repositories/client';
import { getCase, isAwaitingProposal, listFacts, listJobs } from '../repositories/cases';
import { storeEmail } from '../repositories/mailbox';
import { createAgentTools } from '../../agents/tools/index';
import type { AgentOutput, CaseUpdate } from '../../control_plane/contracts.ts';
import * as workerApi from '../../control_plane/api/worker.ts';
import {
  addDocumentVersion,
  findByContentHash,
  getDocument,
  getVersionHistory,
  listDocuments,
  readDocument,
  uploadDocument,
  verifyDocument,
} from '../repositories/documents';
import { FILE_STORE_DIR, putFile, sha256Hex } from '../repositories/file_store';
import { createSpacetimeDataPlane } from '../repositories/data_plane';
import * as api from '../../control_plane/api/index.ts';

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
async function rejects(p: Promise<unknown> | (() => unknown), pattern: RegExp) {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(pattern.test(msg), `rejected with unexpected message: ${msg}`);
    return;
  }
  throw new Error('expected the call to be rejected');
}

const gateway = await connectService('gateway');
const worker = await connectService('worker');
const anon = await connect(); // fresh, unregistered identity (stands in for a browser)
const conn = gateway.conn;
const companyId = [...conn.db.settingsView.iter()][0].companyId;
const ref = `SMOKE-${randomUUID().slice(0, 8)}`;
const text = (s: string) => new TextEncoder().encode(s);
const contractBytes = text(`SYNTHETIC contract for ${ref}\nHourly rate: $100.00 per hour, effective 2026-01-01.\n`);
const sheetV1 = text(`service_date,contractor,approved_minutes\n2026-09-01,Test ${ref} (SYNTHETIC),420\n`);
const sheetV2 = text(`service_date,contractor,approved_minutes\n2026-09-01,Test ${ref} (SYNTHETIC),420\n2026-09-02,Test ${ref} (SYNTHETIC),420\n`);
const base = { companyId, sourceLabel: 'smoke test (SYNTHETIC)', referenceId: ref };
console.log(`[smoke] ${DB_URI} / ${DB_NAME}, company "${companyId}", reference ${ref}`);

let contractId = 0n;
let sheetV1Id = 0n;
let sheetV2Id = 0n;

await check('gateway upload: bytes on file store, metadata in SpacetimeDB', async () => {
  const doc = await uploadDocument(conn, { ...base, bytes: contractBytes, originalFilename: 'contract.txt', mediaType: 'text/plain', type: 'CONTRACT' });
  contractId = doc.id;
  assert(doc.version === 1 && doc.supersedesDocumentId === undefined, 'expected version 1 with no predecessor');
  assert(doc.companyId === companyId && doc.type === 'CONTRACT' && doc.referenceId === ref, 'metadata mismatch');
  assert(doc.contentHash === sha256Hex(contractBytes) && doc.storageKey === `sha256/${doc.contentHash}`, 'hash/storageKey mismatch');
  assert(doc.byteLength === contractBytes.length && doc.mediaType === 'text/plain', 'size/media type mismatch');
  assert(existsSync(join(FILE_STORE_DIR, 'sha256', doc.contentHash.slice(0, 2), doc.contentHash)), 'file not on the file store');
});

await check('fetch by id returns identical, hash-verified bytes', () => {
  const { document, bytes } = readDocument(conn, contractId);
  assert(document.id === contractId && Buffer.from(bytes).equals(Buffer.from(contractBytes)), 'bytes differ');
  assert(verifyDocument(conn, contractId).ok, 'verification failed');
});

await check('tampered file on the store is detected on read', async () => {
  const bytes = text(`tamper target ${ref}`);
  const doc = await uploadDocument(conn, { ...base, bytes, originalFilename: 'tamper.txt', mediaType: 'text/plain', type: 'OTHER' });
  writeFileSync(join(FILE_STORE_DIR, 'sha256', doc.contentHash.slice(0, 2), doc.contentHash), text('altered'));
  const v = verifyDocument(conn, doc.id);
  assert(!v.ok && /size|hash/.test(v.error ?? ''), 'tampering not detected');
});

await check('reducer rejects inconsistent metadata', async () => {
  const stored = putFile(contractBytes);
  const args = { ...base, uploadKey: randomUUID(), ...stored, mediaType: 'text/plain', originalFilename: 'x.txt', type: 'OTHER' };
  await rejects(conn.reducers.storeDocument({ ...args, storageKey: 'sha256/' + '0'.repeat(64) }), /storageKey/);
  await rejects(conn.reducers.storeDocument({ ...args, type: 'RECEIPT' }), /type must be/);
  await rejects(conn.reducers.storeDocument({ ...args, mediaType: 'image/png' }), /media type/);
  await rejects(conn.reducers.storeDocument({ ...args, companyId: 'other-co' }), /Unknown company/);
});

await check('only the gateway identity can write documents', async () => {
  const stored = putFile(contractBytes);
  const args = { ...base, uploadKey: randomUUID(), ...stored, mediaType: 'text/plain', originalFilename: 'x.txt', type: 'OTHER' };
  await rejects(anon.conn.reducers.storeDocument(args), /Only the configured gateway/);
  await rejects(worker.conn.reducers.storeDocument(args), /Only the configured gateway/);
  await rejects(anon.conn.reducers.configureSettings({ companyId, currency: 'USD', expenseAccount: { code: '1', name: 'x' }, liabilityAccount: { code: '2', name: 'y' }, policyVersion: 'x' }), /module owner/);
});

await check('views: gateway and worker see documents, unregistered clients see nothing', async () => {
  await waitFor(() => getDocument(worker.conn, contractId), 'worker replica');
  assert([...worker.conn.db.settingsView.iter()].length === 1, 'worker cannot see settings');
  assert([...anon.conn.db.documentsView.iter()].length === 0, 'anonymous client can see documents');
  assert([...anon.conn.db.settingsView.iter()].length === 0, 'anonymous client can see settings');
  assert([...anon.conn.db.myServiceIdentity.iter()].length === 0, 'anonymous client has a role');
});

await check('retrying with the same uploadKey does not duplicate', async () => {
  const input = { ...base, uploadKey: randomUUID(), bytes: sheetV1, originalFilename: 'timesheet.csv', mediaType: 'text/csv', type: 'TIMESHEET' as const };
  const first = await uploadDocument(conn, input);
  const second = await uploadDocument(conn, input);
  sheetV1Id = first.id;
  assert(first.id === second.id, 'retry created a second document');
  assert(findByContentHash(conn, first.contentHash).length === 1, 'duplicate rows found');
});

await check('add version 2 without mutating version 1', async () => {
  const before = { ...getDocument(conn, sheetV1Id)! };
  const v2 = await addDocumentVersion(conn, sheetV1Id, { ...base, bytes: sheetV2, originalFilename: 'timesheet_v2.csv', mediaType: 'text/csv' });
  sheetV2Id = v2.id;
  const after = getDocument(conn, sheetV1Id)!;
  assert(v2.version === 2 && v2.supersedesDocumentId === sheetV1Id, 'v2 does not point at v1');
  assert(v2.type === 'TIMESHEET' && v2.referenceId === ref, 'v2 did not inherit type/reference');
  assert(after.storageKey === before.storageKey && after.contentHash === before.contentHash && after.version === 1, 'v1 changed');
  assert(Buffer.from(readDocument(conn, sheetV1Id).bytes).equals(Buffer.from(sheetV1)), 'v1 bytes changed');
  const history = getVersionHistory(conn, sheetV2Id).map(d => d.id);
  assert(history.length === 2 && history[0] === sheetV1Id && history[1] === sheetV2Id, 'history chain wrong');
});

await check('versioning a superseded or identical version is rejected', async () => {
  await rejects(addDocumentVersion(conn, sheetV1Id, { ...base, bytes: text(`other ${ref}`), originalFilename: 'x.csv', mediaType: 'text/csv' }), /already superseded/);
  await rejects(addDocumentVersion(conn, sheetV2Id, { ...base, bytes: sheetV2, originalFilename: 'x.csv', mediaType: 'text/csv' }), /identical content/);
});

await check('list documents with filters', () => {
  const all = listDocuments(conn, { referenceId: ref });
  const sheets = listDocuments(conn, { referenceId: ref, type: 'TIMESHEET' });
  const latest = listDocuments(conn, { referenceId: ref, latestOnly: true });
  assert(all.length === 4, `expected 4 documents for ${ref}, got ${all.length}`);
  assert(sheets.length === 2, `expected 2 timesheet versions, got ${sheets.length}`);
  assert(latest.length === 3 && latest.every(d => d.id !== sheetV1Id), 'latestOnly should hide v1');
});

// --- control plane -> DataPlane adapter -> SpacetimeDB --------------------------------------
const dataPlane = createSpacetimeDataPlane(conn);
const workerPlane = createSpacetimeDataPlane(worker.conn);
const gatewayCtx = { kind: 'gateway' as const, companyId, serviceIdentity: 'smoke', requestId: ref };
const workerCtx = { kind: 'worker' as const, companyId, serviceIdentity: 'smoke-worker', requestId: ref };

await check('control plane settings.get', async () => {
  const s = await api.settings.get(gatewayCtx, {}, dataPlane);
  assert(s.companyId === companyId && s.currency === 'USD' && s.expenseAccount.code === '6100' && s.liabilityAccount.code === '2105', 'settings mismatch');
});

await check('control plane accepts a 10 MiB upload at its limit', async () => {
  const big = new Uint8Array(10 * 1024 * 1024).fill(0x41);
  big.set(text(ref));
  const receipt = await api.imports.upload(gatewayCtx, { filename: 'big.txt', mediaType: 'text/plain', bytes: big, type: 'OTHER' }, dataPlane);
  assert(getDocument(conn, BigInt(receipt.uploadId))!.byteLength === big.length, 'size mismatch');
});

// --- cases, import, mailbox, job queue (brief p.3-4) --------------------------------------------
const vendor = `V-${ref}`;
const otherVendor = `V-OTHER-${ref}`;
type UploadType = 'ACCRUAL' | 'CONTRACT' | 'AMENDMENT' | 'TIMESHEET' | 'INVOICE' | 'LEDGER' | 'OTHER';
const up = async (filename: string, mediaType: string, type: UploadType, body: string) =>
  (await api.imports.upload(gatewayCtx, { filename, mediaType, bytes: text(body), type }, dataPlane)).uploadId;

const ids = {
  contract: await up('msa.txt', 'text/plain', 'CONTRACT', `SYNTHETIC MSA ${ref}\nHourly rate: $100.00 per hour, effective 2026-01-01.\nAuthorized signatory: Dana Whitfield, Controller\n`),
  timesheet: await up('timesheet.csv', 'text/csv', 'TIMESHEET', `service_date,contractor,approved_minutes,billing_rate,status,approved_by\n2026-09-01,Pat ${ref},420,110.00,APPROVED,PM\n2026-09-02,Pat ${ref},480,110.00,APPROVED,PM\n2026-09-03,Pat ${ref},60,110.00,PENDING,\n`),
  invoice: await up('invoices.csv', 'text/csv', 'INVOICE', `invoice_number,contractor,service_start,service_end,minutes,amount,posting_status,posted_date\nINV-${ref},Pat ${ref},2026-09-01,2026-09-01,420,"700.00",POSTED,2026-09-20\n`),
  ledger: await up('ledger.csv', 'text/csv', 'LEDGER', `entry_id,vendor_id,period,kind,amount,status,description\nACR-${ref},${vendor},2026-09,ACCRUAL,"1,500.00",POSTED,SYNTHETIC accrual\n`),
  accrual: await up('accrual.json', 'application/json', 'ACCRUAL', JSON.stringify({ entryId: `ACR-${ref}`, vendorId: vendor, status: 'POSTED', amountCents: '150000', postingPeriod: '2026-09' })),
  amendment: await up('amendment.txt', 'text/plain', 'AMENDMENT', `SYNTHETIC AMENDMENT ${ref}\nThe hourly rate changes from $100.00 to $110.00 per hour effective 2026-09-01.\nApproved and signed: Dana Whitfield, Controller\n`),
  otherDoc: await up('other.txt', 'text/plain', 'OTHER', `unrelated ${ref}`),
};
const mailAmendment = await storeEmail(conn, {
  companyId, messageKey: `${ref}:m1`, vendorId: vendor, threadId: `${ref}:T1`, sender: 'contracts@vendor.example', recipients: ['ap@northwind-demo.example'],
  subject: `Signed amendment ${ref}`, sentAt: '2026-08-28T17:05:00Z', body: 'Countersigned amendment attached: new hourly rate effective 2026-09-01.', attachmentDocumentIds: [BigInt(ids.amendment)],
});
const mailOther = await storeEmail(conn, {
  companyId, messageKey: `${ref}:m2`, vendorId: otherVendor, threadId: `${ref}:T2`, sender: 'ar@other.example', recipients: ['ap@northwind-demo.example'],
  subject: `Other vendor amendment rate ${ref}`, sentAt: '2026-09-01T10:00:00Z', body: 'amendment hourly rate for a different vendor', attachmentDocumentIds: [BigInt(ids.otherDoc)],
});
const importInput = {
  idempotencyKey: `${ref}:import`,
  uploadIds: [ids.contract, ids.timesheet, ids.invoice, ids.ledger, ids.accrual],
  vendorId: vendor,
  servicePeriod: { from: '2026-09-01', to: '2026-09-30' },
  postingPeriod: '2026-09',
  originalStatus: 'POSTED' as const,
  originalAmountCents: '150000',
  sourceEntryId: `ACR-${ref}`,
};
let caseId = '';
const rev = 1;
const leaseOf = async (role: string) => {
  const job = await waitFor(() => listJobs(conn, BigInt(caseId)).find(j => j.role === role && j.status === 'QUEUED'), `${role} job`);
  return workerApi.claim(workerCtx, { caseId, expectedRevision: rev, jobId: String(job.id) }, workerPlane);
};
const output = (o: Partial<AgentOutput> & { summary: string }): AgentOutput => ({
  proposedFacts: o.proposedFacts ?? [],
  proposedMatches: o.proposedMatches ?? [],
  evidenceIds: o.evidenceIds ?? [],
  unresolvedQuestions: o.unresolvedQuestions ?? [],
  explanation: { summary: o.summary, evidenceIds: o.evidenceIds ?? [] },
});

await check('imports.finalize parses structured files with code into facts and evidence rows', async () => {
  const c = await api.imports.finalize(gatewayCtx, importInput, dataPlane);
  caseId = c.id;
  assert(c.state === 'IMPORTED' && c.inputRevision === 1 && c.blockers.length === 0, `unexpected case ${JSON.stringify(c)}`);
  assert(c.servicePeriod.from === '2026-09-01' && c.originalAmountCents === '150000' && c.currentProposalId === null, 'case fields mismatch');
  await waitFor(() => getCase(worker.conn, BigInt(caseId)), 'case replicated to the worker');
  const ev = createAgentTools(worker.conn, { caseId }).getCaseEvidence();
  assert(ev.workItems.length === 2 && ev.workItems.every(w => w.claimedRateCents === '11000'), 'expected 2 approved work items at 11000');
  assert(ev.invoiceLines.length === 1 && ev.invoiceLines[0].amountCents === '70000', 'invoice line mismatch');
  assert(ev.ledgerRecords.length === 1 && ev.ledgerRecords[0].amountCents === '150000', 'ledger record mismatch ("1,500.00" -> 150000)');
  const pending = ev.facts.find(f => f.value.includes('PENDING'));
  assert(pending && pending.validationStatus === 'REJECTED' && pending.pageOrRow === 'row 4', 'unapproved timesheet row should be a REJECTED fact with its row');
  assert(ev.facts.some(f => f.field === 'accrual.amountCents' && f.value === '150000'), 'accrual fact missing');
});

await check('imports.finalize is idempotent and rejects duplicate source entries', async () => {
  const again = await api.imports.finalize(gatewayCtx, importInput, dataPlane);
  assert(again.id === caseId, 'same idempotencyKey created a second case');
  await rejects(api.imports.finalize(gatewayCtx, { ...importInput, idempotencyKey: `${ref}:import-2` }, dataPlane), /already exists for source entry/);
});

await check('missing inputs and duplicate work block the case (WAITING_FOR_INPUT)', async () => {
  const dupSheet = await up('dup.csv', 'text/csv', 'TIMESHEET', `service_date,contractor,approved_minutes,status\n2026-09-01,Dup ${ref},60,APPROVED\n2026-09-01,Dup ${ref},60,APPROVED\n`);
  const c = await api.imports.finalize(gatewayCtx, { ...importInput, idempotencyKey: `${ref}:blocked`, sourceEntryId: `ACR-${ref}-B`, uploadIds: [dupSheet] }, dataPlane);
  assert(c.state === 'WAITING_FOR_INPUT', `state ${c.state}`);
  assert(c.blockers.some(b => b.startsWith('DUPLICATE_WORK')) && c.blockers.filter(b => b.startsWith('MISSING_INPUT')).length === 4, `blockers ${c.blockers}`);
  await rejects(api.cases.startReview(gatewayCtx, { caseId: c.id, expectedRevision: 1 }, dataPlane), /Case is WAITING_FOR_INPUT/);
});

let updates: AsyncIterator<CaseUpdate> | undefined;
await check('cases.get / list / startReview / listJobs (+ subscribe relays updates)', async () => {
  assert((await api.cases.get(gatewayCtx, { caseId }, dataPlane))?.id === caseId, 'cases.get');
  assert((await api.cases.list(gatewayCtx, { state: 'IMPORTED', limit: 100 }, dataPlane)).items.some(c => c.id === caseId), 'cases.list');
  updates = (await api.cases.subscribe(gatewayCtx, { caseId }, dataPlane))[Symbol.asyncIterator]();
  const started = await api.cases.startReview(gatewayCtx, { caseId, expectedRevision: 1 }, dataPlane);
  assert(started.state === 'EXTRACTING', `state ${started.state}`);
  await api.cases.startReview(gatewayCtx, { caseId, expectedRevision: 1 }, dataPlane); // idempotent
  const jobs = (await api.cases.listJobs(gatewayCtx, { caseId }, dataPlane)).items;
  assert(jobs.length === 1 && jobs[0].role === 'EXTRACTION' && jobs[0].status === 'QUEUED', `jobs ${JSON.stringify(jobs)}`);
  const kinds = new Set<string>();
  const it = updates;
  while (!(kinds.has('CASE_UPDATED') && kinds.has('JOB_UPDATED'))) {
    const next = await Promise.race([it.next(), new Promise<never>((_, r) => setTimeout(() => r(new Error('no update relayed')), 5000))]);
    if (next.done) throw new Error('subscription ended');
    kinds.add(next.value.kind);
  }
});

await check('only the worker can claim; unregistered clients see no cases', async () => {
  const job = listJobs(conn, BigInt(caseId))[0];
  await rejects(conn.reducers.claimJob({ jobId: job.id, caseId: BigInt(caseId), expectedRevision: 1 }), /Only the configured worker/);
  await rejects(workerApi.claim({ ...workerCtx, kind: 'gateway' } as never, { caseId, expectedRevision: 1, jobId: String(job.id) }, workerPlane), /requires a worker context/);
  assert([...anon.conn.db.casesView.iter()].length === 0 && [...anon.conn.db.jobsView.iter()].length === 0, 'anonymous client sees cases or jobs');
});

await check('EXTRACTION: claim lease, heartbeat, scope-checked complete -> MATCHING queued', async () => {
  const lease = await leaseOf('EXTRACTION');
  assert(lease.status === 'RUNNING' && lease.attempts === 1 && /^[0-9a-f]{32}$/.test(lease.leaseToken), 'bad lease');
  assert(lease.allowedEvidenceIds.includes(`doc:${ids.contract}`) && lease.allowedEvidenceIds.includes(`email:${mailAmendment.id}`) && lease.allowedEvidenceIds.includes(`doc:${ids.amendment}`), 'scope missing case/mailbox evidence');
  assert(!lease.allowedEvidenceIds.includes(`email:${mailOther.id}`) && !lease.allowedEvidenceIds.includes(`doc:${ids.otherDoc}`), 'scope includes another vendor');
  assert(lease.facts.length > 0 && lease.policyVersion !== '' && typeof lease.outputSchema === 'object', 'lease payload incomplete');
  await rejects(workerApi.claim(workerCtx, { caseId, expectedRevision: rev, jobId: lease.id }, workerPlane), /under another lease/);
  const hb = await workerApi.heartbeat(workerCtx, { caseId, expectedRevision: rev, jobId: lease.id, leaseToken: lease.leaseToken }, workerPlane);
  assert(hb.leaseExpiry >= lease.leaseExpiry, 'heartbeat did not extend');

  const lref = { caseId, expectedRevision: rev, jobId: lease.id, leaseToken: lease.leaseToken, modelRun: 'REPLAYED' as const };
  const rateFact = { documentId: ids.contract, pageOrRow: 'line 2', excerpt: 'Hourly rate: $100.00 per hour, effective 2026-01-01.', field: 'rate.hourlyCents', value: '10000' };
  await rejects(workerApi.complete(workerCtx, { ...lref, leaseToken: 'f'.repeat(32), output: output({ summary: 'x' }) }, workerPlane), /Stale or unknown lease/);
  await rejects(workerApi.complete(workerCtx, { ...lref, output: output({ summary: 'x', evidenceIds: [`email:${mailOther.id}`] }) }, workerPlane), /outside this job's scope/);
  await rejects(workerApi.complete(workerCtx, { ...lref, output: output({ summary: 'x', proposedFacts: [{ ...rateFact, documentId: ids.otherDoc }] }) }, workerPlane), /outside this case/);
  const done = await workerApi.complete(workerCtx, { ...lref, output: output({ summary: 'Contract rate extracted', proposedFacts: [rateFact], evidenceIds: [`doc:${ids.contract}`] }) }, workerPlane);
  assert(done.status === 'SUCCEEDED', `status ${done.status}`);
  await waitFor(() => getCase(conn, BigInt(caseId))?.state === 'MATCHING', 'MATCHING state');
  const f = listFacts(conn, BigInt(caseId)).find(x => x.field === 'rate.hourlyCents');
  assert(f && f.validationStatus === 'PROPOSED' && f.source === 'AGENT' && f.modelRun === 'REPLAYED', 'agent fact not stored as PROPOSED');
});

await check('MATCHING: proposed matches saved; unresolved question -> INVESTIGATION queued', async () => {
  const lease = await leaseOf('MATCHING');
  const ev = createAgentTools(worker.conn, { caseId }).getCaseEvidence();
  const ledgerId = ev.ledgerRecords[0].id;
  const matches = ev.workItems.map(w => ({
    workItemId: w.id,
    contractId: ids.contract,
    invoiceLineIds: w.serviceDate === '2026-09-01' ? [ev.invoiceLines[0].id] : [],
    ledgerEntryIds: [ledgerId],
    evidenceIds: [`fact:${w.factId}`],
  }));
  const lref = { caseId, expectedRevision: rev, jobId: lease.id, leaseToken: lease.leaseToken, modelRun: 'REPLAYED' as const };
  await rejects(workerApi.complete(workerCtx, { ...lref, output: output({ summary: 'x', proposedMatches: [{ ...matches[0], workItemId: '999999' }] }) }, workerPlane), /not in this case revision/);
  await workerApi.complete(workerCtx, { ...lref, output: output({ summary: 'Matched 2 work days', proposedMatches: matches, unresolvedQuestions: ['Timesheet bills $110/h but the contract says $100/h. Is there an approved amendment?'] }) }, workerPlane);
  await waitFor(() => getCase(conn, BigInt(caseId))?.state === 'INVESTIGATING', 'INVESTIGATING state');
  const allocations = createAgentTools(worker.conn, { caseId }).getCaseEvidence().allocations;
  assert(allocations.length === 2 && allocations.every(a => a.contractId === ids.contract), 'allocations not stored');
});

await check('agent tools: vendor-scoped search, thread, attachment text', async () => {
  const tools = createAgentTools(worker.conn, { caseId });
  const hits = tools.searchEmails({ query: 'amendment hourly rate' });
  assert(hits.length === 1 && hits[0].emailId === String(mailAmendment.id) && hits[0].attachmentDocumentIds[0] === ids.amendment, `hits ${JSON.stringify(hits)}`);
  assert(hits[0].snippet.length <= 242, 'snippet not bounded');
  await rejects(() => tools.searchEmails({ vendor: otherVendor, query: 'rate' }), /outside this job's scope/);
  assert(tools.readEmailThread(`${ref}:T1`)[0].body.includes('Countersigned'), 'thread body');
  await rejects(() => tools.readEmailThread(`${ref}:T2`), /outside this job's scope/);
  const att = await tools.readAttachment(ids.amendment);
  assert(att.type === 'AMENDMENT' && att.text.includes('$110.00 per hour'), 'attachment text');
  await rejects(tools.readAttachment(ids.otherDoc), /outside this job's scope/);
});

await check('INVESTIGATION: amendment evidence submitted -> awaiting build_proposal', async () => {
  const lease = await leaseOf('INVESTIGATION');
  const lref = { caseId, expectedRevision: rev, jobId: lease.id, leaseToken: lease.leaseToken, modelRun: 'LIVE' as const };
  const ev = [`email:${mailAmendment.id}`, `doc:${ids.amendment}`];
  await workerApi.complete(workerCtx, { ...lref, output: output({
    summary: 'Signed Amendment No. 1 sets $110/h from 2026-09-01',
    evidenceIds: ev,
    proposedFacts: [{ documentId: ids.amendment, pageOrRow: 'line 2', excerpt: 'The hourly rate changes from $100.00 to $110.00 per hour effective 2026-09-01.', field: 'rate.hourlyCents', value: '11000' }],
  }) }, workerPlane);
  await waitFor(() => isAwaitingProposal(conn, BigInt(caseId)), 'awaiting proposal');
  const c = getCase(conn, BigInt(caseId))!;
  assert(c.state === 'INVESTIGATING' && c.blockers.length === 0, `state ${c.state}`);
  const jobs = (await api.cases.listJobs(gatewayCtx, { caseId }, dataPlane)).items;
  assert(jobs.map(j => `${j.role}:${j.status}`).join(',') === 'EXTRACTION:SUCCEEDED,MATCHING:SUCCEEDED,INVESTIGATION:SUCCEEDED', `jobs ${JSON.stringify(jobs)}`);
});

await check('evidence.list paginates; evidence.readDocument enforces case scope', async () => {
  const first = await api.evidence.list(gatewayCtx, { caseId, limit: 3 }, dataPlane);
  assert(first.items.length === 3 && first.nextCursor !== null, 'first page');
  const second = await api.evidence.list(gatewayCtx, { caseId, cursor: first.nextCursor!, limit: 100 }, dataPlane);
  assert(second.items.length > 0 && BigInt(second.items[0].id) > BigInt(first.items[2].id) && second.nextCursor === null, 'second page');
  const read = await api.evidence.readDocument(gatewayCtx, { caseId, documentId: ids.amendment }, dataPlane); // vendor attachment
  assert(read.document.type === 'AMENDMENT' && new TextDecoder().decode(read.bytes).includes('$110.00'), 'attachment read');
  await rejects(api.evidence.readDocument(gatewayCtx, { caseId, documentId: ids.otherDoc }, dataPlane), /not found/);
  await rejects(api.evidence.readDocument({ ...gatewayCtx, companyId: 'other-co' }, { caseId, documentId: ids.contract }, dataPlane), /Unknown company/);
});

await check('expired lease: sweep requeues, stale completion rejected, retries exhausted -> RETRYABLE_ERROR', async () => {
  const owner = await connect(ownerToken());
  try {
    await owner.conn.reducers.configureJobPolicy({ leaseSeconds: 1, maxAttempts: 2 });
    const c = await api.imports.finalize(gatewayCtx, { ...importInput, idempotencyKey: `${ref}:lease`, sourceEntryId: `ACR-${ref}-L` }, dataPlane);
    await api.cases.startReview(gatewayCtx, { caseId: c.id, expectedRevision: 1 }, dataPlane);
    const job = await waitFor(() => listJobs(conn, BigInt(c.id))[0], 'job');
    const first = await workerApi.claim(workerCtx, { caseId: c.id, expectedRevision: 1, jobId: String(job.id) }, workerPlane);
    const requeued = await waitFor(() => listJobs(conn, BigInt(c.id)).find(j => j.status === 'QUEUED' && j.attempts === 1), 'sweep requeue', 10000);
    assert(requeued.lastError === 'Lease expired', 'requeue reason');
    await rejects(workerApi.complete(workerCtx, { caseId: c.id, expectedRevision: 1, jobId: first.id, leaseToken: first.leaseToken, modelRun: 'REPLAYED', output: output({ summary: 'late' }) }, workerPlane), /Stale or unknown lease/);
    await workerApi.claim(workerCtx, { caseId: c.id, expectedRevision: 1, jobId: String(job.id) }, workerPlane);
    await waitFor(() => listJobs(conn, BigInt(c.id)).find(j => j.status === 'FAILED'), 'job failed after max attempts', 10000);
    const failed = await waitFor(() => (getCase(conn, BigInt(c.id))?.state === 'RETRYABLE_ERROR' ? getCase(conn, BigInt(c.id)) : undefined), 'RETRYABLE_ERROR');
    assert(failed.blockers.some(b => b.startsWith('JOB_FAILED')), 'failure not surfaced on case');
  } finally {
    await owner.conn.reducers.configureJobPolicy({ leaseSeconds: 30, maxAttempts: 3 });
    owner.conn.disconnect();
  }
});

await check('operations not built yet report DATA_PLANE_UNAVAILABLE', async () => {
  await rejects(api.proposals.get(gatewayCtx, { caseId, proposalId: '1' }, dataPlane), /No data-plane adapter is connected for proposals.get/);
  await rejects(api.reviews.list(gatewayCtx, { caseId }, dataPlane), /No data-plane adapter is connected for reviews.list/);
});

await updates?.return?.();

for (const c of [gateway, worker, anon]) c.conn.disconnect();
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`);
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
