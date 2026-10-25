import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Exercise the exact browser package builder against the live API twice.
const source = await readFile(new URL('../src/data/demoPackage.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { buildDemoPackage } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const read = name => readFile(new URL('../public/demo-files/' + name, import.meta.url), 'utf8');
for (let run = 1; run <= 2; run++) {
  const documents = await buildDemoPackage('amendment', read);
  const metadata = JSON.parse(documents[0].text);
  const ledger = documents.find(d => d.name.startsWith('ledger')).text;
  if (!ledger.includes(metadata.entryId) || !ledger.includes(metadata.vendorId)) throw Error('Inconsistent demo identifiers');
  const form = new FormData();
  for (const d of documents) form.append('files', new Blob([d.text], { type: d.type }), d.name);
  const created = await fetch('http://localhost:8000/create-review', { method: 'POST', body: form });
  const body = await created.json();
  if (!created.ok) throw Error(JSON.stringify(body));
  console.log(`Run ${run}: created review ${body.review_id} for ${metadata.vendorId}`);
  const deadline = Date.now() + 600_000;
  let previous;
  while (Date.now() < deadline) {
    const response = await fetch(`http://localhost:8000/get-review?review_id=${body.review_id}`);
    if (!response.ok) throw Error(`Snapshot HTTP ${response.status}`);
    const snapshot = await response.json();
    if (snapshot.status !== previous) console.log(`Review ${body.review_id}: ${snapshot.status}`);
    previous = snapshot.status;
    if (snapshot.status === 'READY_FOR_REVIEW') {
      if (snapshot.corrected_target_cents !== '770000' || snapshot.difference_cents !== '70000' || !snapshot.proposal_id || snapshot.blockers.length) throw Error('Unexpected proposal: ' + JSON.stringify(snapshot));
      const balance = snapshot.journal_lines.reduce((total, line) => total + BigInt(line.debit_cents) - BigInt(line.credit_cents), 0n);
      if (balance !== 0n || snapshot.journal_lines.length !== 2) throw Error('Unbalanced journal');
      console.log(`PASS review ${body.review_id}: target $7,700; adjustment $700; balanced proposal ${snapshot.proposal_id}`);
      break;
    }
    if (['FAILED', 'WAITING_FOR_INPUT', 'RETRYABLE_ERROR'].includes(snapshot.status)) throw Error(JSON.stringify(snapshot.blockers));
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  if (previous !== 'READY_FOR_REVIEW') throw Error('Review deadline exceeded');
}
