// Local smoke test for document storage, following the brief's process boundaries:
// gateway-only writes, private tables behind sender-checked views, bytes on the file store.
// Uses a unique reference ID per run, so it can run repeatedly. Requires `npm run db:bootstrap`.

import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, connectService, DB_NAME, DB_URI, waitFor } from '../repositories/client';
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

const ledgerBytes = text(`entry_id,vendor_id,period,kind,amount,status\n${ref},V-TEST,2026-09,ACCRUAL,1.00,POSTED\n`);

await check('repository uploads and reads a ledger', async () => {
  const doc = await uploadDocument(conn, { ...base, originalFilename: 'ledger.csv', mediaType: 'text/csv', bytes: ledgerBytes, type: 'LEDGER' });
  assert(doc.contentHash === sha256Hex(ledgerBytes), 'document hash mismatch');
  const read = readDocument(conn, doc.id);
  assert(read.document.id === doc.id && read.document.type === 'LEDGER' && read.document.version === 1, 'document summary mismatch');
  assert(read.document.mediaType === 'text/csv' && Buffer.from(read.bytes).equals(Buffer.from(ledgerBytes)), 'bytes mismatch');
});

await check('gateway reads configured company settings', () => {
  const s = [...conn.db.settingsView.iter()][0];
  assert(s.companyId === companyId && s.currency === 'USD' && s.expenseAccount.code === '6100' && s.liabilityAccount.code === '2105', 'settings mismatch');
});

await check('repository accepts a 10 MiB upload at its limit', async () => {
  const big = new Uint8Array(10 * 1024 * 1024).fill(0x41);
  big.set(text(ref));
  const doc = await uploadDocument(conn, { ...base, originalFilename: 'big.txt', mediaType: 'text/plain', bytes: big, type: 'OTHER' });
  assert(getDocument(conn, doc.id)!.byteLength === big.length, 'size mismatch');
});

for (const c of [gateway, worker, anon]) c.conn.disconnect();
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`);
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
