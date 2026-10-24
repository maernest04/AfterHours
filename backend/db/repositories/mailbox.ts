// Mock finance mailbox (brief p.1: "a simulated finance mailbox in SpacetimeDB, including threads and
// attachments ... not a Gmail integration"). The gateway loads synthetic messages; agents read them
// through backend/agents/tools.

import type { DbConnection } from '../bindings/index';
import { waitFor } from './client';

type Rows<T> = T extends { iter(): Iterable<infer R> } ? R : never;
export type EmailRow = Rows<DbConnection['db']['emailsView']>;

export type EmailInput = {
  companyId: string;
  /** Idempotency key for the message. */
  messageKey: string;
  vendorId: string;
  threadId: string;
  sender: string;
  recipients: string[];
  subject: string;
  /** ISO 8601, e.g. 2026-08-28T17:05:00Z */
  sentAt: string;
  body: string;
  /** documents.id of uploaded attachments (upload them first with uploadDocument). */
  attachmentDocumentIds?: bigint[];
};

export async function storeEmail(conn: DbConnection, input: EmailInput): Promise<EmailRow> {
  await conn.reducers.storeEmail({ ...input, attachmentDocumentIds: input.attachmentDocumentIds ?? [] });
  return waitFor(() => [...conn.db.emailsView.iter()].find(e => e.messageKey === input.messageKey), `email ${input.messageKey}`);
}

export function attachmentDocumentIds(conn: DbConnection, emailId: bigint): bigint[] {
  return [...conn.db.attachmentsView.iter()].filter(a => a.emailId === emailId).map(a => a.documentId);
}
