// Seed synthetic source documents through the gateway identity. Idempotent: fixed upload keys make
// re-runs no-ops. Requires `npm run db:bootstrap` first.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectService, DB_NAME, DB_URI } from '../repositories/client';
import { addDocumentVersion, findByUploadKey, listDocuments, uploadDocument, type DocumentType } from '../repositories/documents';
import { FILE_STORE_DIR } from '../repositories/file_store';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'documents');
const REFERENCE_ID = 'DEMO-ACME-2026-09';
const SOURCE = 'seed (SYNTHETIC)';

const SEED: Array<{ key: string; file: string; mediaType: string; type: DocumentType }> = [
  { key: 'seed:acme-msa', file: 'acme_msa.txt', mediaType: 'text/plain', type: 'CONTRACT' },
  { key: 'seed:acme-amendment-1', file: 'acme_amendment_1.txt', mediaType: 'text/plain', type: 'AMENDMENT' },
  { key: 'seed:acme-timesheet-2026-09', file: 'acme_timesheet_2026-09_v1.csv', mediaType: 'text/csv', type: 'TIMESHEET' },
  { key: 'seed:acme-invoices-2026-08', file: 'acme_invoices_2026-08.csv', mediaType: 'text/csv', type: 'INVOICE' },
  { key: 'seed:ledger-2026-09', file: 'ledger_2026-09.csv', mediaType: 'text/csv', type: 'LEDGER' },
  { key: 'seed:acme-accrual-2026-09', file: 'acme_accrual_2026-09.json', mediaType: 'application/json', type: 'ACCRUAL' },
];

const read = (file: string) => new Uint8Array(readFileSync(join(DIR, file)));

const { conn } = await connectService('gateway');
const companyId = [...conn.db.settingsView.iter()][0].companyId;
console.log(`[seed] ${DB_URI} / ${DB_NAME}, company "${companyId}", files in ${FILE_STORE_DIR}`);

for (const s of SEED) {
  const doc = await uploadDocument(conn, {
    companyId,
    uploadKey: s.key,
    bytes: read(s.file),
    originalFilename: s.file,
    mediaType: s.mediaType,
    type: s.type,
    referenceId: REFERENCE_ID,
    sourceLabel: SOURCE,
  });
  console.log(`[seed] ${s.type.padEnd(9)} doc ${doc.id} v${doc.version}  ${s.file}`);
}

// Version 2 of the timesheet (adds the final approved day) to demonstrate versioning.
const v2Key = 'seed:acme-timesheet-2026-09:v2';
if (!findByUploadKey(conn, v2Key)) {
  const v1 = findByUploadKey(conn, 'seed:acme-timesheet-2026-09')!;
  const v2 = await addDocumentVersion(conn, v1.id, {
    companyId,
    uploadKey: v2Key,
    bytes: read('acme_timesheet_2026-09_v2.csv'),
    originalFilename: 'acme_timesheet_2026-09_v2.csv',
    mediaType: 'text/csv',
    sourceLabel: SOURCE,
  });
  console.log(`[seed] TIMESHEET doc ${v2.id} v${v2.version}  supersedes doc ${v1.id}`);
}

console.log(`[seed] done: ${listDocuments(conn, { referenceId: REFERENCE_ID }).length} document rows for ${REFERENCE_ID}`);
conn.disconnect();
process.exit(0);
