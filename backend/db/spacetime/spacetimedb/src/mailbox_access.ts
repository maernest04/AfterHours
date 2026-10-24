import { SenderError, t } from 'spacetimedb/server';
import spacetimedb from './schema';
import { requireGateway, requireCompany } from './auth';
import { storeEmail } from './pipeline';

// Bounded imports avoid querying an ever-growing mailbox after every insert.
const MailImport = t.object('MailImport', {
  messageKey: t.string(), vendorId: t.string(), threadId: t.string(), sender: t.string(),
  recipients: t.array(t.string()), subject: t.string(), sentAt: t.string(), body: t.string(),
  attachmentDocumentIds: t.array(t.u64()),
});
export const importMailBatch = spacetimedb.procedure({companyId: t.string(), messages: t.array(MailImport)}, t.string(), (ctx, a) => ctx.withTx(tx => {
  requireGateway(tx);
  requireCompany(tx, a.companyId);
  if (a.messages.length > 100) throw new SenderError('At most 100 messages per batch.');
  const ids = a.messages.map(message => {
    storeEmail(tx, {...message, companyId: a.companyId});
    return tx.db.emails.messageKey.find(message.messageKey)!.id.toString();
  });
  return JSON.stringify(ids);
}));

// Search indexes suggest IDs; the authoritative database always rechecks scope.
export const readMailEvidence = spacetimedb.procedure({
  caseId: t.u64(), emailIds: t.array(t.u64()), threadId: t.string(), documentId: t.u64(),
}, t.string(), (ctx, a) => ctx.withTx(tx => {
  const company = tx.db.serviceIdentity.identity.find(tx.sender) ? tx.db.settings.id.find(0)?.companyId : undefined;
  const c = tx.db.cases.id.find(a.caseId);
  if (!company || !c || c.companyId !== company) throw new SenderError('Case is outside service scope.');
  if (a.emailIds.length > 25) throw new SenderError('At most 25 email IDs.');
  const scoped = (email: {companyId: string; vendorId: string}) => email.companyId === company && email.vendorId === c.vendorId;
  const rows = a.threadId ? [...tx.db.emails.threadId.filter(a.threadId)].filter(scoped) :
    a.emailIds.flatMap(id => { const e = tx.db.emails.id.find(id); return e && scoped(e) ? [e] : []; });
  if (a.threadId && rows.length === 0) return JSON.stringify({error: 'EVIDENCE_UNAVAILABLE'});
  if (a.threadId) rows.sort((left, right) => left.sentAt.localeCompare(right.sentAt));
  let documentAllowed = false;
  if (a.documentId !== 0n) {
    documentAllowed = [...tx.db.caseDocuments.caseId.filter(c.id)].some(d => d.inputRevision === c.inputRevision && d.documentId === a.documentId) ||
      [...tx.db.attachments.documentId.filter(a.documentId)].some(link => {
        const email = tx.db.emails.id.find(link.emailId);
        return email != null && scoped(email);
      });
    if (!documentAllowed) return JSON.stringify({error: 'EVIDENCE_UNAVAILABLE'});
  }
  return JSON.stringify({documentAllowed, truncated: rows.length > 25, emails: rows.slice(0, 25).map(e => ({
    id: e.id.toString(), threadId: e.threadId, sender: e.sender, recipients: e.recipients,
    subject: e.subject, sentAt: e.sentAt, body: e.body,
    attachmentDocumentIds: [...tx.db.attachments.emailId.filter(e.id)].map(link => link.documentId.toString()),
  }))});
}));
