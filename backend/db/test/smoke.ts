// Local smoke test for document storage: upload, retrieval, listing, versioning, integrity.
// Uses a unique reference ID per run, so it can run repeatedly against the same database.

import { randomUUID } from 'node:crypto';
import { connect, DB_NAME, DB_URI } from '../repositories/client';
import {
  addDocumentVersion,
  getDocument,
  getFile,
  getVersionHistory,
  listDocuments,
  readDocument,
  saveDocumentText,
  sha256,
  getDocumentText,
  uploadDocument,
  verifyFileLocally,
  verifyFileOnServer,
} from '../repositories/documents';
import { waitFor } from '../repositories/client';

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
async function rejects(p: Promise<unknown>, pattern: RegExp) {
  try {
    await p;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(pattern.test(msg), `rejected with unexpected message: ${msg}`);
    return;
  }
  throw new Error('expected the call to be rejected');
}

const { conn } = await connect();
const ref = `SMOKE-${randomUUID().slice(0, 8)}`;
const text = (s: string) => new TextEncoder().encode(s);
const contractBytes = text(`SYNTHETIC contract for ${ref}\nHourly rate: $100.00 per hour, effective 2026-01-01.\n`);
const sheetV1 = text('service_date,contractor,approved_minutes\n2026-09-01,Test (SYNTHETIC),420\n');
const sheetV2 = text('service_date,contractor,approved_minutes\n2026-09-01,Test (SYNTHETIC),420\n2026-09-02,Test (SYNTHETIC),420\n');
console.log(`[smoke] ${DB_URI} / ${DB_NAME}  reference ${ref}`);

let contractId = 0n;
let sheetV1Id = 0n;
let sheetV2Id = 0n;

await check('upload stores file + document metadata', async () => {
  const doc = await uploadDocument(conn, {
    bytes: contractBytes, originalFilename: 'contract.txt', mimeType: 'text/plain',
    docType: 'CONTRACT', referenceId: ref, sourceLabel: 'smoke test (SYNTHETIC)',
  });
  contractId = doc.id;
  const file = getFile(conn, doc.fileId);
  assert(file, 'file row missing');
  assert(doc.version === 1 && doc.supersedesDocumentId === undefined, 'expected version 1 with no predecessor');
  assert(doc.docType === 'CONTRACT' && doc.referenceId === ref, 'metadata mismatch');
  assert(file.originalFilename === 'contract.txt' && file.mimeType === 'text/plain', 'file metadata mismatch');
  assert(file.byteSize === contractBytes.length, 'byte size mismatch');
  assert(file.sha256 === sha256(contractBytes) && doc.contentHash === file.sha256, 'server SHA-256 differs from Node crypto');
});

await check('fetch by id returns identical bytes', () => {
  const { document, bytes } = readDocument(conn, contractId);
  assert(document.id === contractId, 'wrong document');
  assert(Buffer.from(bytes).equals(Buffer.from(contractBytes)), 'bytes differ');
});

await check('verify size + hash (client and server)', async () => {
  const doc = getDocument(conn, contractId)!;
  assert(verifyFileLocally(conn, doc.fileId).ok, 'local verification failed');
  await verifyFileOnServer(conn, doc.fileId);
});

await check('upload with wrong expected hash is rejected', async () => {
  await rejects(
    conn.reducers.storeDocument({
      uploadKey: randomUUID(), originalFilename: 'bad.txt', mimeType: 'text/plain', bytes: contractBytes,
      expectedSha256: '0'.repeat(64), docType: 'OTHER', referenceId: ref, sourceLabel: 'smoke',
    }),
    /Integrity check failed/
  );
});

await check('invalid doc type and MIME type are rejected', async () => {
  const base = { originalFilename: 'x.txt', bytes: contractBytes, expectedSha256: '', referenceId: ref, sourceLabel: 'smoke' };
  await rejects(conn.reducers.storeDocument({ ...base, uploadKey: randomUUID(), mimeType: 'text/plain', docType: 'RECEIPT' }), /docType/);
  await rejects(conn.reducers.storeDocument({ ...base, uploadKey: randomUUID(), mimeType: 'image/png', docType: 'OTHER' }), /MIME/);
});

await check('retrying with the same uploadKey does not duplicate', async () => {
  const key = randomUUID();
  const input = { uploadKey: key, bytes: sheetV1, originalFilename: 'timesheet.csv', mimeType: 'text/csv', docType: 'TIMESHEET' as const, referenceId: ref, sourceLabel: 'smoke test (SYNTHETIC)' };
  const first = await uploadDocument(conn, input);
  const second = await uploadDocument(conn, input);
  sheetV1Id = first.id;
  assert(first.id === second.id, 'retry created a second document');
  assert(listDocuments(conn, { referenceId: ref, docType: 'TIMESHEET' }).length === 1, 'duplicate rows found');
});

await check('add version 2 without mutating version 1', async () => {
  const before = { ...getDocument(conn, sheetV1Id)! };
  const v2 = await addDocumentVersion(conn, sheetV1Id, {
    bytes: sheetV2, originalFilename: 'timesheet_v2.csv', mimeType: 'text/csv', sourceLabel: 'smoke test (SYNTHETIC)',
  });
  sheetV2Id = v2.id;
  const after = getDocument(conn, sheetV1Id)!;
  assert(v2.version === 2 && v2.supersedesDocumentId === sheetV1Id, 'v2 does not point at v1');
  assert(v2.docType === 'TIMESHEET' && v2.referenceId === ref, 'v2 did not inherit type/reference');
  assert(after.fileId === before.fileId && after.contentHash === before.contentHash && after.version === 1, 'v1 changed');
  assert(Buffer.from(readDocument(conn, sheetV1Id).bytes).equals(Buffer.from(sheetV1)), 'v1 bytes changed');
  const history = getVersionHistory(conn, sheetV2Id).map(d => d.id);
  assert(history.length === 2 && history[0] === sheetV1Id && history[1] === sheetV2Id, 'history chain wrong');
});

await check('versioning a superseded or identical version is rejected', async () => {
  await rejects(addDocumentVersion(conn, sheetV1Id, { bytes: text('other'), originalFilename: 'x.csv', mimeType: 'text/csv', sourceLabel: 'smoke' }), /already superseded/);
  await rejects(addDocumentVersion(conn, sheetV2Id, { bytes: sheetV2, originalFilename: 'x.csv', mimeType: 'text/csv', sourceLabel: 'smoke' }), /identical content/);
});

await check('list documents with filters', () => {
  const all = listDocuments(conn, { referenceId: ref });
  const sheets = listDocuments(conn, { referenceId: ref, docType: 'TIMESHEET' });
  const latest = listDocuments(conn, { referenceId: ref, latestOnly: true });
  assert(all.length === 3, `expected 3 documents for ${ref}, got ${all.length}`);
  assert(sheets.length === 2, `expected 2 timesheet versions, got ${sheets.length}`);
  assert(latest.length === 2 && latest.every(d => d.id !== sheetV1Id), 'latestOnly should hide v1');
  assert(listDocuments(conn, { docType: 'CONTRACT' }).some(d => d.id === contractId), 'type filter missed contract');
});

await check('store and read extracted text', async () => {
  await saveDocumentText(conn, contractId, new TextDecoder().decode(contractBytes), 'EXTRACTED');
  const row = await waitFor(() => getDocumentText(conn, contractId), 'document text');
  assert(row.extractionStatus === 'EXTRACTED' && row.text.includes(ref), 'text row mismatch');
});

conn.disconnect();
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`);
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
