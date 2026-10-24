"""Local derived FTS index; source reads and authorization stay in SpacetimeDB."""
from contextlib import closing
import json
import re
import sqlite3
import time

from afterhours_db.cases import case_document_ids, list_facts
from afterhours_db.tools import AgentTools, ToolScopeError, _snippet


class ScopedAgentTools(AgentTools):
    def __init__(self, db, case_id):
        super().__init__(db, case_id)
        self.allowed = [f'doc:{id}' for id in case_document_ids(db, case_id)]
        self.allowed += [f'fact:{row["id"]}' for row in list_facts(db, case_id)]
        self.metrics = []
        self.read_document_ids = set()
        self.scope_errors = 0

    def evidence_ids(self):
        # Keep the same list: newly discovered, DB-authorized IDs extend handler scope.
        return self.allowed

    def _read(self, ids=(), thread='', document=0):
        result = self.db.client.call_procedure('read_mail_evidence', [
            self.case_id, [int(id) for id in ids], thread, int(document)])
        if result.get('error') == 'EVIDENCE_UNAVAILABLE':
            self.scope_errors += 1
            raise ToolScopeError('Requested evidence is unavailable in this case')
        return result

    def _remember(self, messages):
        for message in messages:
            for ref in [f'email:{message["id"]}', *[f'doc:{id}' for id in message['attachmentDocumentIds']]]:
                if ref not in self.allowed:
                    self.allowed.append(ref)

    def read_email_thread(self, thread_id):
        response = self._read(thread=thread_id)
        messages = response['emails']
        self._remember(messages)
        return [{'emailId': mail['id'], 'evidenceId': f'email:{mail["id"]}',
                 'sender': mail['sender'], 'recipients': mail['recipients'], 'subject': mail['subject'],
                 'sentAt': mail['sentAt'], 'body': mail['body'][:2000],
                 'truncated': response['truncated'] or len(mail['body']) > 2000,
                 'attachmentDocumentIds': mail['attachmentDocumentIds']} for mail in messages]

    def read_attachment(self, document_id):
        self._read(document=document_id)
        ref = f'doc:{document_id}'
        if ref not in self.allowed:
            self.allowed.append(ref)
        result = super().read_attachment(document_id)
        self.read_document_ids.add(str(document_id))
        return result


class IndexedAgentTools(ScopedAgentTools):
    def __init__(self, db, case_id, index_path):
        super().__init__(db, case_id)
        self.index_path = str(index_path)
        with closing(sqlite3.connect(self.index_path)) as index:
            row = index.execute("SELECT value FROM metadata WHERE key='database'").fetchone()
        expected = json.dumps([db.config.uri, db.config.database, db.config.company_id])
        if row is None or json.loads(row[0]) != expected:
            raise ValueError('Search index belongs to a different database')

    def search_emails(self, query, vendor=None, date_range=None, limit=10):
        started = time.perf_counter()
        case = self._case()
        if vendor and vendor != case['vendor_id']:
            raise ToolScopeError('Vendor is outside this case')
        terms = re.findall(r'[\w]+', query.lower(), re.UNICODE)[:20]
        if not terms:
            return []
        expression = ' OR '.join('"' + term + '"' for term in terms)
        dates = date_range or {}
        with closing(sqlite3.connect(f'file:{self.index_path}?mode=ro', uri=True)) as index:
            candidates = index.execute('''SELECT email_id FROM mail_search
                WHERE mail_search MATCH ? AND vendor=? AND sent_at>=? AND sent_at<=?
                ORDER BY bm25(mail_search) LIMIT ?''',
                (expression, case['vendor_id'], dates.get('from', ''), dates.get('to', '9999-12-31') + 'T23:59:59Z',
                 min(25, max(1, limit)))).fetchall()
        messages = self._read(ids=[row[0] for row in candidates])['emails']
        self._remember(messages)
        result = [{'emailId': mail['id'], 'evidenceId': f'email:{mail["id"]}',
                   'threadId': mail['threadId'], 'sender': mail['sender'], 'subject': mail['subject'],
                   'sentAt': mail['sentAt'], 'snippet': _snippet(mail['body'], terms),
                   'attachmentDocumentIds': mail['attachmentDocumentIds']} for mail in messages]
        self.metrics.append({'tool': 'searchEmails', 'seconds': time.perf_counter()-started,
                             'query': query, 'date_range': dates, 'vendor': case['vendor_id'],
                             'returned': len(result), 'response_bytes': len(json.dumps(result).encode())})
        return result

