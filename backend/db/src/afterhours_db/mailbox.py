"""Synthetic finance mailbox with vendor threads and document attachments."""
from __future__ import annotations

from .documents import AfterHoursDB

AMENDMENT_MAIL = {
    'sender': 'contracts@acme-contracting.example',
    'recipients': ['ap@northwind-demo.example'],
    'subject': 'Countersigned Amendment No. 1 - revised hourly rate (SYNTHETIC)',
    'sent_at': '2026-08-28T17:05:00Z',
    'body': ('Hi Northwind AP,\n\nAttached is Amendment No. 1, countersigned by Dana Whitfield. '
             'The hourly rate for J. Rivera moves to $110.00 per hour effective 2026-09-01.\n\n'
             'Thanks,\nAcme Contracts (SYNTHETIC)'),
}


def store_email(db: AfterHoursDB, *, message_key: str, vendor_id: str, thread_id: str,
                sender: str, recipients: list[str], subject: str, sent_at: str, body: str,
                attachment_document_ids: list[int] | None = None) -> dict:
    """Store an idempotent message; upload attachment documents before calling."""
    db.client.call_reducer('store_email', [db.config.company_id, message_key, vendor_id, thread_id,
        sender, recipients, subject, sent_at, body,
        [] if attachment_document_ids is None else attachment_document_ids])
    email = next((row for row in db.client.query('SELECT * FROM emails_view')
                  if row['message_key'] == message_key), None)
    if email is None:
        raise RuntimeError(f'Reducer committed but email {message_key} is not visible')
    return email


def attachment_document_ids(db: AfterHoursDB, email_id: int) -> list[int]:
    return [row['document_id'] for row in db.client.query('SELECT * FROM attachments_view')
            if row['email_id'] == email_id]


def seed_vendor_amendment_mailbox(db: AfterHoursDB, *, vendor_id: str, message_key: str,
                                  amendment_document_ids: list[int]) -> dict | None:
    """Put this vendor's uploaded amendments in the mock mailbox investigation searches."""
    if not amendment_document_ids:
        return None
    return store_email(db, message_key=message_key, vendor_id=vendor_id, thread_id=f'{message_key}:thread',
                       attachment_document_ids=amendment_document_ids, **AMENDMENT_MAIL)
