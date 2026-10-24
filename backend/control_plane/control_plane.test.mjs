import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from './api/index.ts';
import * as worker from './api/worker.ts';

const ctx = { kind: 'gateway', companyId: 'demo', serviceIdentity: 'gateway', requestId: 'request-1' };
const proposal = { caseId: 'case-1', expectedRevision: 2, proposalId: 'proposal-1', proposalHash: 'hash-1' };

test('invalid review parameters are rejected before any data-plane call', async () => {
  let calls = 0;
  const dataPlane = { async execute() { calls++; return {}; } };
  for (const input of [
    null,
    { ...proposal, reviewerName: 'A', decision: 'REJECT' },
    { ...proposal, reviewerName: ' ', decision: 'APPROVE' },
    { ...proposal, reviewerName: 'A', decision: 'APPROVE', expectedRevision: -1 },
    { ...proposal, reviewerName: 'A', decision: 'APPROVE', companyId: 'other' },
  ]) {
    await assert.rejects(api.reviews.decide(ctx, input, dataPlane), { code: 'INVALID_PARAMETERS' });
  }
  assert.equal(calls, 0);
});

test('valid review is delegated once with trusted context and its exact proposal reference', async () => {
  const input = { ...proposal, reviewerName: 'A', decision: 'REJECT', reason: 'Wrong rate' };
  const result = { id: 'review-1', proposalId: 'proposal-1', proposalHash: 'hash-1', reviewerName: 'A', decision: 'REJECT', reason: 'Wrong rate', timestamp: '2026-10-23T00:00:00Z' };
  const calls = [];
  const dataPlane = { async execute(...args) { calls.push(args); return result; } };
  assert.equal(await api.reviews.decide(ctx, input, dataPlane), result);
  assert.deepEqual(calls, [['reviews.decide', ctx, input]]);
});

test('data-plane failures propagate without retries or fabricated results', async () => {
  const failure = new Error('Stale proposal');
  let calls = 0;
  const dataPlane = { async execute() { calls++; throw failure; } };
  await assert.rejects(api.exports.create(ctx, { ...proposal, idempotencyKey: 'export-1' }, dataPlane), error => error === failure);
  assert.equal(calls, 1);
});

test('imports reject fractional cents, impossible dates and empty upload references', async () => {
  const input = { idempotencyKey: 'import-1', uploadIds: ['upload-1'], vendorId: 'vendor-1', servicePeriod: { from: '2026-10-01', to: '2026-10-31' }, postingPeriod: '2026-10', originalStatus: 'DRAFT', originalAmountCents: '700000', sourceEntryId: 'entry-1' };
  let calls = 0;
  const dataPlane = { async execute() { calls++; return null; } };
  for (const invalid of [
    { ...input, originalAmountCents: '700000.5' },
    { ...input, originalAmountCents: 700000 },
    { ...input, servicePeriod: { from: '2026-02-30', to: '2026-03-01' } },
    { ...input, uploadIds: [] },
  ]) {
    await assert.rejects(api.imports.finalize(ctx, invalid, dataPlane), { code: 'INVALID_PARAMETERS' });
  }
  assert.equal(calls, 0);
  await api.imports.finalize(ctx, input, dataPlane);
  assert.equal(calls, 1);
});

test('upload and pagination parameter bounds are enforced before delegation', async () => {
  let calls = 0;
  const dataPlane = { async execute() { calls++; return null; } };
  for (const input of [{ limit: 0 }, { limit: 1.5 }, { limit: 101 }, { state: 'MADE_UP' }]) {
    await assert.rejects(api.cases.list(ctx, input, dataPlane), { code: 'INVALID_PARAMETERS' });
  }
  await assert.rejects(api.imports.upload(ctx, { filename: 'file.csv', mediaType: 'text/csv', bytes: new Uint8Array(), type: 'ACCRUAL' }, dataPlane), { code: 'INVALID_PARAMETERS' });
  assert.equal(calls, 0);
});

test('worker output validates nested facts and matches before delegation', async () => {
  const workerCtx = { ...ctx, kind: 'worker' };
  const input = { caseId: 'case-1', expectedRevision: 2, jobId: 'job-1', leaseToken: 'lease', modelRun: 'LIVE', output: { proposedFacts: [], proposedMatches: [], evidenceIds: ['evidence-1'], unresolvedQuestions: [], explanation: { summary: 'Done', evidenceIds: ['evidence-1'] } } };
  const calls = [];
  const dataPlane = { async execute(...args) { calls.push(args); return { id: 'job-1' }; } };
  await assert.rejects(worker.complete(workerCtx, { ...input, output: { ...input.output, proposedMatches: [{}] } }, dataPlane), { code: 'INVALID_PARAMETERS' });
  assert.equal(calls.length, 0);
  await worker.complete(workerCtx, input, dataPlane);
  assert.deepEqual(calls, [['worker.complete', workerCtx, input]]);
});
