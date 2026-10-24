import type { Operations } from "./data_plane.ts";
import { InvalidParametersError } from "./errors.ts";
import { parameterLimits } from "./config/settings.ts";

type Check = (value: unknown, path: string) => void;
const fail = (path: string, message: string): never => { throw new InvalidParametersError(path, message); };
const text: Check = (value, path) => {
  if (typeof value !== "string" || !value.trim()) fail(path, "expected a nonempty string");
};
const integer = (min: number, max = Number.MAX_SAFE_INTEGER): Check => (value, path) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(path, `expected an integer between ${min} and ${max}`);
  }
};
const oneOf = (values: readonly string[]): Check => (value, path) => {
  if (typeof value !== "string" || !values.includes(value)) fail(path, "unsupported value");
};
const optional = (check: Check): Check => (value, path) => {
  if (value !== undefined) check(value, path);
};
const array = (check: Check, min = 0): Check => (value, path) => {
  if (!Array.isArray(value) || value.length < min) return fail(path, `expected an array with at least ${min} items`);
  for (let i = 0; i < value.length; i++) check(value[i], `${path}[${i}]`);
};
const object = (fields: Record<string, Check>): Check => (value, path) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(path, "expected an object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(fields, key)) fail(`${path}.${key}`, "unexpected parameter");
  }
  for (const [key, check] of Object.entries(fields)) {
    check(Object.hasOwn(record, key) ? record[key] : undefined, `${path}.${key}`);
  }
};
const cents: Check = (value, path) => {
  if (typeof value !== "string" || !/^-?(0|[1-9]\d*)$/.test(value)) fail(path, "expected an integer-cent string");
};
const date: Check = (value, path) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail(path, "expected YYYY-MM-DD");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(path, "invalid calendar date");
};
const dateRange: Check = (value, path) => {
  object({ from: date, to: date })(value, path);
  const range = value as { from: string; to: string };
  if (range.from > range.to) fail(path, "from must be on or before to");
};
const postingPeriod: Check = (value, path) => {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) fail(path, "expected YYYY-MM");
};
const bytes: Check = (value, path) => {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > parameterLimits.maxUploadBytes) {
    fail(path, `expected 1 to ${parameterLimits.maxUploadBytes} bytes`);
  }
};

const page = { cursor: optional(text), limit: optional(integer(1, parameterLimits.maxPageSize)) };
const caseRef = { caseId: text };
const revision = { ...caseRef, expectedRevision: integer(0) };
const proposal = { ...revision, proposalId: text, proposalHash: text };
const lease = { ...revision, jobId: text, leaseToken: text };
const evidenceIds = array(text);
const account = object({ code: text, name: text });
const casePage = object({ ...caseRef, ...page });
const review: Check = (value, path) => {
  const decision = value && typeof value === "object" ? (value as Record<string, unknown>).decision : undefined;
  const fields = { ...proposal, reviewerName: text };
  if (decision === "REJECT") object({ ...fields, decision: oneOf(["REJECT"]), reason: text })(value, path);
  else object({ ...fields, decision: oneOf(["APPROVE"]) })(value, path);
};

/** Syntactic request checks only. Existence, approvals, leases and accounting rules belong to the data plane. */
const checks: Record<keyof Operations, Check> = {
  "imports.upload": object({ filename: text, mediaType: oneOf(parameterLimits.allowedMediaTypes), bytes,
    type: oneOf(["ACCRUAL", "CONTRACT", "AMENDMENT", "TIMESHEET", "INVOICE", "LEDGER", "OTHER"]) }),
  "imports.finalize": object({ idempotencyKey: text, uploadIds: array(text, 1), vendorId: text,
    servicePeriod: dateRange, postingPeriod, originalStatus: oneOf(["DRAFT", "POSTED"]),
    originalAmountCents: cents, sourceEntryId: text }),
  "cases.list": object({ ...page, state: optional(oneOf(["IMPORTED", "EXTRACTING", "MATCHING", "INVESTIGATING",
    "READY_FOR_REVIEW", "APPROVED", "EXPORTED", "WAITING_FOR_INPUT", "VERIFIED_NO_CHANGE",
    "NEEDS_REVISION", "RETRYABLE_ERROR", "FAILED"])) }),
  "cases.get": object(caseRef),
  "cases.startReview": object(revision),
  "cases.listJobs": casePage,
  "cases.subscribe": object({ ...caseRef, afterSequence: optional(text) }),
  "worker.claim": object({ ...revision, jobId: text }),
  "worker.heartbeat": object(lease),
  "worker.complete": object({ ...lease, modelRun: oneOf(["LIVE", "REPLAYED"]), output: object({
    proposedFacts: array(object({ documentId: text, pageOrRow: text, excerpt: text, field: text, value: text })),
    proposedMatches: array(object({ workItemId: text, contractId: text, invoiceLineIds: array(text),
      ledgerEntryIds: array(text), evidenceIds })),
    evidenceIds, unresolvedQuestions: array(text), explanation: object({ summary: text, evidenceIds }),
  }) }),
  "questions.ask": object({ ...proposal, reviewerName: text, question: text }),
  "questions.list": casePage,
  "exceptions.resolve": object({ ...revision, exceptionId: text, reviewerName: text, explanation: text,
    evidenceIds, controllerTreatment: optional(text) }),
  "proposals.get": object({ ...caseRef, proposalId: text }),
  "proposals.build": object(revision),
  "reviews.decide": review,
  "reviews.list": casePage,
  "exports.create": object({ ...proposal, idempotencyKey: text }),
  "exports.download": object({ ...caseRef, exportId: text }),
  "evidence.list": casePage,
  "evidence.readDocument": object({ ...caseRef, documentId: text }),
  "settings.get": object({}),
  "settings.configure": object({ expenseAccount: account, liabilityAccount: account, expectedPolicyVersion: text }),
};

export function validateParameters<K extends keyof Operations>(
  operation: K, input: unknown,
): asserts input is Operations[K]["input"] {
  checks[operation](input, "input");
}
