// Owner bootstrap (run after every publish/reset): configure the fixed demo company and register
// the gateway and worker service identities. Idempotent.

import { Identity } from 'spacetimedb';
import { connect, connectAs, DB_NAME, DB_URI, ownerToken } from '../repositories/client';

const COMPANY_ID = process.env.COMPANY_ID ?? 'demo';

// Service identities are created (and their tokens saved to backend/.secrets/) on first use.
const gateway = await connectAs('gateway');
const worker = await connectAs('worker');
gateway.conn.disconnect();
worker.conn.disconnect();

const owner = await connect(ownerToken());
console.log(`[bootstrap] ${DB_URI} / ${DB_NAME} as owner ${owner.identityHex.slice(0, 12)}…`);

await owner.conn.reducers.configureSettings({
  companyId: COMPANY_ID,
  currency: 'USD',
  expenseAccount: { code: '6100', name: 'Contractor Services Expense' },
  liabilityAccount: { code: '2105', name: 'Accrued Liabilities' },
  policyVersion: '2026.10-demo',
});
console.log(`[bootstrap] settings: company "${COMPANY_ID}", USD, 6100 / 2105`);

await owner.conn.reducers.registerServiceIdentity({ identity: Identity.fromString(gateway.identityHex), role: 'GATEWAY', label: 'Next.js gateway' });
await owner.conn.reducers.registerServiceIdentity({ identity: Identity.fromString(worker.identityHex), role: 'WORKER', label: 'Node agent worker' });
console.log(`[bootstrap] GATEWAY ${gateway.identityHex.slice(0, 12)}…  WORKER ${worker.identityHex.slice(0, 12)}…`);

owner.conn.disconnect();
process.exit(0);
