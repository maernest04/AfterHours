import bz2
from contextlib import closing
import io
import json
import os
from pathlib import Path
import sqlite3
import tarfile
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock

from afterhours_db import AfterHoursDB
from afterhours_db.client import SpacetimeClient, SpacetimeError
from afterhours_db.config import DatabaseConfig
from afterhours_db.tools import ToolScopeError
from afterhours_investigation.enron import corpus, index_mail, parse_email, prepare, import_messages
from afterhours_investigation.indexed_tools import IndexedAgentTools
from afterhours_investigation.enron_benchmark import make_case


MAIL = b'Date: Mon, 25 Sep 2000 07:01:00 -0700\nFrom: Real Sender\nTo: Real Recipient\nSubject: Agreement\n\nOriginal email body\n'


class EnronTests(unittest.TestCase):
    def test_attachment_before_parent_and_duplicate_rerun_preserve_sources(self):
        with TemporaryDirectory() as name:
            root = Path(name)
            with bz2.open(root / 'docids-v2.csv.bz2', 'wt') as stream:
                stream.write('mail,mail\nmail_hash,mail.2\n')
            with tarfile.open(root / 'edrmv2txt-v2.tar.bz2', 'w:bz2') as archive:
                for path, data in [('mail.2.txt', b'Actual agreement text'), ('mail.txt', MAIL)]:
                    member = tarfile.TarInfo(path); member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
            prepare(root, 1)
            prepare(root, 1)
            with corpus(root / 'corpus.sqlite') as index:
                rows = index.execute('SELECT kind,parent_id,raw FROM records ORDER BY kind').fetchall()
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]['parent_id'], 'mail')
            self.assertEqual(bytes(rows[0]['raw']), b'Actual agreement text')
            self.assertEqual(bytes(rows[1]['raw']), MAIL)

    def test_dates_missing_metadata_and_sats_encoding(self):
        self.assertEqual(parse_email(MAIL, 'mail')['sentAt'], '2000-09-25T14:01:00Z')
        with self.assertRaises(ValueError):
            parse_email(b'Subject: missing headers\n\ntext', 'bad')
        db = Mock(); db.config.company_id = 'demo'
        message = dict(messageKey='key', vendorId='v', threadId='t', sender='s', recipients=['r'],
                       subject='subject', sentAt='date', body='body', attachmentDocumentIds=[2])
        import_messages(db, [message])
        self.assertEqual(db.client.call_procedure.call_args.args[1][1][0],
                         ['key','v','t','s',['r'],'subject','date','body',[2]])

    def test_fts_is_bounded_and_source_database_rechecks_each_candidate(self):
        with TemporaryDirectory() as name:
            path = Path(name) / 'index.sqlite'
            config = DatabaseConfig(uri='http://test', database='enron-test')
            with corpus(path) as index:
                index.execute('INSERT INTO metadata VALUES (?,?)',
                    ('database', json.dumps(json.dumps([config.uri, config.database, config.company_id]))))
                for i in range(100):
                    index_mail(index, i+1, dict(subject='Contract amendment', body='hourly rate agreement',
                        sentAt='2000-09-01T00:00:00Z', vendorId='v' if i<50 else 'other'))
            db = Mock(); db.config = config
            tools = object.__new__(IndexedAgentTools)
            tools.db=db; tools.case_id=1; tools.index_path=str(path); tools.allowed=[]; tools.metrics=[]
            tools._case = lambda: {'vendor_id':'v'}
            db.client.call_procedure.return_value = {'emails': []}
            self.assertEqual(tools.search_emails('" OR ; DROP TABLE records', limit=1000), [])
            tools.search_emails('contract amendment', limit=1000)
            args = db.client.call_procedure.call_args.args[1]
            self.assertLessEqual(len(args[1]), 25)
            self.assertTrue(all(id<=50 for id in args[1]))
            self.assertEqual(tools.evidence_ids(), [])  # unverified index hits never enter scope
            with self.assertRaises(ToolScopeError):
                tools.search_emails('contract', vendor='other')
            with closing(sqlite3.connect(path)) as index:
                self.assertEqual(index.execute('SELECT count(*) FROM mail_search').fetchone()[0], 100)


@unittest.skipUnless(os.getenv('ENRON_INTEGRATION') == '1', 'Dedicated Enron database required')
class EnronAccessTests(unittest.TestCase):
    def test_real_bulk_idempotency_and_role_limits(self):
        from uuid import uuid4
        with AfterHoursDB.connect('gateway') as gateway, AfterHoursDB.connect('worker') as worker:
            message=dict(messageKey='test-'+uuid4().hex, vendorId='OTHER', threadId='test-'+uuid4().hex,
                         sender='synthetic@example.com', recipients=['test@example.com'], subject='Test',
                         sentAt='2000-09-01T00:00:00Z', body='SYNTHETIC', attachmentDocumentIds=[])
            first=import_messages(gateway,[message]); second=import_messages(gateway,[message])
            self.assertEqual(first,second)
            with self.assertRaises(SpacetimeError):
                import_messages(worker,[message])
            with self.assertRaises(SpacetimeError):
                import_messages(gateway,[message]*101)
            with self.assertRaises(SpacetimeError):
                worker.client.call_procedure('import_document_batch',['demo',[]])

    def test_poisoned_index_cannot_read_another_vendor(self):
        from uuid import uuid4
        root=Path('data/enron')
        with AfterHoursDB.connect('gateway') as gateway, AfterHoursDB.connect('worker') as worker:
            case=make_case(gateway,root,'missing')
            document=gateway.upload_document(data=b'SYNTHETIC foreign evidence',original_filename='foreign.txt',
                media_type='text/plain',type='OTHER',source_label='Enron authorization test')
            message=dict(messageKey='poison-'+uuid4().hex,vendorId='OTHER',threadId='foreign-'+uuid4().hex,
                sender='synthetic@example.com',recipients=['test@example.com'],subject='Poisoned needle',
                sentAt='2000-09-01T00:00:00Z',body='SYNTHETIC',attachmentDocumentIds=[document.id])
            email_id=import_messages(gateway,[message])[0]
            with TemporaryDirectory() as temporary:
                path=Path(temporary)/'corpus.sqlite'
                with corpus(path) as index:
                    config=gateway.config
                    index.execute('INSERT INTO metadata VALUES (?,?)',('database',json.dumps(json.dumps([config.uri,config.database,config.company_id]))))
                    index_mail(index,email_id,{**message,'vendorId':'ENRON-BENCH'})
                tools=IndexedAgentTools(worker,case['case_id'],path)
                self.assertEqual(tools.search_emails('poisoned needle'),[])
                with self.assertRaises(ToolScopeError):
                    tools.read_email_thread(message['threadId'])
                with self.assertRaises(ToolScopeError):
                    tools.read_attachment(str(document.id))
                with SpacetimeClient(config.uri,config.database) as anonymous:
                    with self.assertRaises(SpacetimeError):
                        anonymous.call_procedure('read_mail_evidence',[case['case_id'],[int(email_id)],'',0])
