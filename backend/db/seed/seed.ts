// Seed synthetic source documents. Idempotent: fixed upload keys make re-runs no-ops.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, DB_NAME, DB_URI } from '../repositories/client';
import { addDocumentVersion, findByUploadKey, listDocuments, uploadDocument, type DocType } from '../repositories/documents';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'documents');
const REFERENCE_ID = 'DEMO-ACME-2026-09';
const SOURCE = 'seed (SYNTHETIC)';

const SEED: Array<{ key: string; file: string; mimeType: string; docType: DocType }> = [
  { key: 'seed:acme-msa', file: 'acme_msa.txt', mimeType: 'text/plain', docType: 'CONTRACT' },
  { key: 'seed:acme-amendment-1', file: 'acme_amendment_1.txt', mimeType: 'text/plain', docType: 'AMENDMENT' },
  { key: 'seed:acme-timesheet-2026-09', file: 'acme_timesheet_2026-09_v1.csv', mimeType: 'text/csv', docType: 'TIMESHEET' },
  { key: 'seed:acme-invoices-2026-08', file: 'acme_invoices_2026-08.csv', mimeType: 'text/csv', docType: 'INVOICE' },
  { key: 'seed:ledger-export-2026-09', file: 'ledger_export_2026-09.csv', mimeType: 'text/csv', docType: 'LEDGER_EXPORT' },
];

const read = (file: string) => new Uint8Array(readFileSync(join(DIR, file)));

const { conn } = await connect();
console.log(`[seed] ${DB_URI} / ${DB_NAME}`);

for (const s of SEED) {
  const doc = await uploadDocument(conn, {
    uploadKey: s.key,
    bytes: read(s.file),
    originalFilename: s.file,
    mimeType: s.mimeType,
    docType: s.docType,
    referenceId: REFERENCE_ID,
    sourceLabel: SOURCE,
  });
  console.log(`[seed] ${s.docType.padEnd(13)} doc ${doc.id} v${doc.version}  ${s.file}`);
}

// Version 2 of the timesheet (adds the final approved day) to demonstrate versioning.
const v2Key = 'seed:acme-timesheet-2026-09:v2';
if (!findByUploadKey(conn, v2Key)) {
  const v1 = findByUploadKey(conn, 'seed:acme-timesheet-2026-09')!;
  const v2 = await addDocumentVersion(conn, v1.id, {
    uploadKey: v2Key,
    bytes: read('acme_timesheet_2026-09_v2.csv'),
    originalFilename: 'acme_timesheet_2026-09_v2.csv',
    mimeType: 'text/csv',
    sourceLabel: SOURCE,
  });
  console.log(`[seed] TIMESHEET     doc ${v2.id} v${v2.version}  supersedes doc ${v1.id}`);
}

console.log(`[seed] done: ${listDocuments(conn, { referenceId: REFERENCE_ID }).length} document rows for ${REFERENCE_ID}`);
conn.disconnect();
process.exit(0);
