"""Reproducible Enron text-corpus preparation and bounded database import."""
import argparse
import bz2
import csv
from contextlib import contextmanager
from datetime import timezone
from email import policy
from email.parser import BytesParser
from email.utils import parsedate_to_datetime
import hashlib
import json
from pathlib import Path
import sqlite3
import tarfile
import time

from afterhours_db import AfterHoursDB
from dotenv import load_dotenv

SOURCE = 'https://trec-legal.umiacs.umd.edu/corpora/trec/legal10/'
ATTRIBUTION = 'EDRM Enron Email Data Set, produced by ZL Technologies, Inc. (http://www.zlti.com), CC BY 3.0 US'
VENDOR = 'ENRON-BENCH'


@contextmanager
def corpus(path):
    db = sqlite3.connect(path, timeout=60)
    db.row_factory = sqlite3.Row
    db.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS records (
            source_id TEXT PRIMARY KEY, parent_id TEXT, kind TEXT, path TEXT,
            sha256 TEXT, raw BLOB, metadata TEXT, db_id INTEGER);
        CREATE INDEX IF NOT EXISTS parent ON records(parent_id);
        CREATE TABLE IF NOT EXISTS relationships (document_id TEXT PRIMARY KEY, parent_id TEXT);
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT);
        CREATE VIRTUAL TABLE IF NOT EXISTS mail_search USING fts5(
            email_id UNINDEXED, vendor UNINDEXED, sent_at UNINDEXED, subject, body, attachments);
    ''')
    try:
        with db:
            yield db
    finally:
        db.close()


def parse_email(raw, source_id):
    message = BytesParser(policy=policy.default).parsebytes(raw)
    if not message.get('Date') or not message.get('From'):
        raise ValueError('Missing email date or sender')
    date = parsedate_to_datetime(str(message['Date']))
    if date.tzinfo is None:
        raise ValueError('Email date has no timezone')
    subject = str(message.get('Subject', '(no subject)')).strip() or '(no subject)'
    body = message.get_payload()
    if not isinstance(body, str):
        raise ValueError('Unexpected multipart text rendering')
    # Original raw bytes remain in records; this is a normalized search representation.
    return {'sender': str(message['From'])[:255],
            'recipients': [str(message.get('To') or '(recipient absent in source)')],
            'subject': subject[:500], 'sentAt': date.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'body': body, 'threadId': 'enron:' + hashlib.sha256(subject.lower().removeprefix('re:').strip().encode()).hexdigest()[:24]}


def prepare(directory, limit):
    index_path = directory / 'corpus.sqlite'
    with corpus(index_path) as index:
        if index.execute('SELECT count(*) FROM relationships').fetchone()[0] == 0:
            with bz2.open(directory / 'docids-v2.csv.bz2', 'rt') as stream:
                batch = []
                for parent, document in csv.reader(stream):
                    batch.append((document, parent.split('_')[0]))
                    if len(batch) == 5000:
                        index.executemany('INSERT OR IGNORE INTO relationships VALUES (?,?)', batch)
                        batch.clear()
                index.executemany('INSERT OR IGNORE INTO relationships VALUES (?,?)', batch)
            index.commit()
        inserted, skipped, attachments = 0, 0, 0
        started = time.monotonic()
        with tarfile.open(directory / 'edrmv2txt-v2.tar.bz2', 'r|bz2') as archive:
            for member in archive:
                if not member.isfile():
                    continue
                source_id = Path(member.name).stem
                link = index.execute('SELECT parent_id FROM relationships WHERE document_id=?', (source_id,)).fetchone()
                parent = link[0] if link else source_id
                attachment = parent != source_id
                if not attachment and inserted >= limit:
                    continue
                if attachment and not index.execute('SELECT 1 FROM records WHERE source_id=? AND kind=\'email\'', (parent,)).fetchone():
                    continue
                if member.size > 10 * 1024 * 1024:
                    skipped += 1
                    continue
                raw = archive.extractfile(member).read()
                try:
                    metadata = {} if attachment else parse_email(raw, source_id)
                except (ValueError, TypeError, OverflowError):
                    skipped += 1
                    continue
                index.execute('INSERT OR IGNORE INTO records VALUES (?,?,?,?,?,?,?,NULL)',
                              (source_id, parent, 'attachment' if attachment else 'email', member.name,
                               hashlib.sha256(raw).hexdigest(), raw, json.dumps(metadata)))
                attachments += int(attachment)
                inserted += int(not attachment)
                if (inserted + attachments) % 5000 == 0:
                    index.commit()
                    print(json.dumps({'prepared_emails': inserted, 'attachments': attachments}), flush=True)
        for key, value in {'source': SOURCE, 'attribution': ATTRIBUTION, 'email_limit': limit,
                           'parse_failures': skipped, 'prepare_seconds': round(time.monotonic()-started, 2)}.items():
            index.execute('INSERT OR REPLACE INTO metadata VALUES (?,?)', (key, json.dumps(value)))
        prepare_attachments(directory, index)
        stats = {row[0]: row[1] for row in index.execute('SELECT kind,count(*) FROM records GROUP BY kind')}
        print(json.dumps({'prepared': stats, 'skipped': skipped}), flush=True)


def prepare_attachments(directory, index):
    # Archive ordering puts attachments before their parent email; use a second pass.
    selected = {row[0] for row in index.execute("SELECT source_id FROM records WHERE kind='email'")}
    links = {row[0]: row[1] for row in index.execute('SELECT document_id,parent_id FROM relationships WHERE document_id != parent_id') if row[1] in selected}
    count = 0
    with tarfile.open(directory / 'edrmv2txt-v2.tar.bz2', 'r|bz2') as archive:
        for member in archive:
            source_id = Path(member.name).stem
            if not member.isfile() or source_id not in links or not 0 < member.size <= 10 * 1024 * 1024:
                continue
            raw = archive.extractfile(member).read()
            index.execute('INSERT OR IGNORE INTO records VALUES (?,?,?,?,?,?,?,NULL)',
                (source_id, links[source_id], 'attachment', member.name, hashlib.sha256(raw).hexdigest(), raw, '{}'))
            count += 1
            if count % 1000 == 0:
                index.commit()
                print(json.dumps({'prepared_attachments': count}), flush=True)
    index.execute('INSERT OR REPLACE INTO metadata VALUES (?,?)', ('attachment_relationships_not_loaded', json.dumps(len(links)-count)))
    index.commit()
    print(json.dumps({'prepared_attachments': count, 'expected_relationships': len(links)}), flush=True)


def require_test_database(db):
    if not db.config.database.startswith('enron-'):
        raise ValueError('Benchmark requires a dedicated enron-* database')


def index_mail(index, email_id, mail, attachments=''):
    index.execute('DELETE FROM mail_search WHERE rowid=?', (int(email_id),))
    index.execute('INSERT INTO mail_search(rowid,email_id,vendor,sent_at,subject,body,attachments) VALUES (?,?,?,?,?,?,?)',
                  (int(email_id), str(email_id), mail.get('vendorId', VENDOR), mail['sentAt'], mail['subject'], mail['body'][:20000], attachments))


def import_messages(db, messages):
    fields = ('messageKey', 'vendorId', 'threadId', 'sender', 'recipients', 'subject', 'sentAt', 'body', 'attachmentDocumentIds')
    encoded = [[message[field] for field in fields] for message in messages]
    # The HTTP endpoint has a request-body limit; bound bytes as well as row count.
    if len(encoded) > 1 and len(json.dumps(encoded).encode()) > 200000:
        middle = len(messages)//2
        return import_messages(db, messages[:middle]) + import_messages(db, messages[middle:])
    return db.client.call_procedure('import_mail_batch', [db.config.company_id, encoded])


def import_corpus(directory, limit):
    with corpus(directory / 'corpus.sqlite') as index, AfterHoursDB.connect('gateway') as db:
        require_test_database(db)
        config_key = json.dumps([db.config.uri, db.config.database, db.config.company_id])
        previous = index.execute("SELECT value FROM metadata WHERE key='database'").fetchone()
        if previous and json.loads(previous[0]) != config_key:
            raise ValueError('Index belongs to a different database; create a separate corpus index')
        index.execute('INSERT OR REPLACE INTO metadata VALUES (?,?)', ('database', json.dumps(config_key)))
        started = time.monotonic()
        rows = index.execute("SELECT source_id FROM records WHERE kind='email' ORDER BY rowid LIMIT ?", (limit,)).fetchall()
        pending, source_ids, attachment_texts = [], [], []
        imported = 0

        def flush():
            nonlocal imported
            if not pending:
                return
            ids = import_messages(db, pending)
            for source_id, mail, email_id, text in zip(source_ids, pending, ids, attachment_texts):
                index.execute('UPDATE records SET db_id=? WHERE source_id=?', (int(email_id), source_id))
                index_mail(index, email_id, mail, text)
            imported += len(pending)
            index.commit()
            pending.clear(); source_ids.clear(); attachment_texts.clear()
            if imported % 1000 == 0:
                print(json.dumps({'imported_emails': imported, 'seconds': round(time.monotonic()-started, 1)}), flush=True)

        # Upload document metadata in bounded transactions, not one growing-view scan per file.
        attachment_rows = index.execute("""SELECT a.source_id FROM records a JOIN records e ON a.parent_id=e.source_id
            WHERE a.kind='attachment' AND a.db_id IS NULL AND e.source_id IN
            (SELECT source_id FROM records WHERE kind='email' ORDER BY rowid LIMIT ?)""", (limit,)).fetchall()
        for offset in range(0, len(attachment_rows), 100):
            batch = []
            source_batch = []
            for selected_attachment in attachment_rows[offset:offset+100]:
                attachment = index.execute('SELECT * FROM records WHERE source_id=?', (selected_attachment[0],)).fetchone()
                saved = db.files.put(bytes(attachment['raw']))
                batch.append(['enron:' + attachment['source_id'], saved.storage_key, saved.content_hash,
                              saved.byte_length, 'text/plain', Path(attachment['path']).name, 'OTHER',
                              {'some': attachment['source_id']}, 'Public Enron EDRM attachment text'])
                source_batch.append(attachment['source_id'])
            ids = db.client.call_procedure('import_document_batch', [db.config.company_id, batch])
            index.executemany('UPDATE records SET db_id=? WHERE source_id=?', zip(map(int, ids), source_batch))
            index.commit()
            if offset % 1000 == 0:
                print(json.dumps({'attachment_metadata_imported': offset+len(batch), 'attachment_total': len(attachment_rows)}), flush=True)

        for selected in rows:
            record = index.execute('SELECT * FROM records WHERE source_id=?', (selected[0],)).fetchone()
            if record['db_id'] is not None:
                continue
            documents, texts = [], []
            for attachment in index.execute("SELECT * FROM records WHERE parent_id=? AND kind='attachment'", (record['source_id'],)).fetchall():
                document_id = attachment['db_id']
                if document_id is None:
                    raise RuntimeError('Attachment batch was not committed')
                documents.append(document_id)
                texts.append(bytes(attachment['raw']).decode('utf-8', errors='replace'))
            mail = json.loads(record['metadata'])
            # Subject grouping is approximate; source IDs/headers remain available in the corpus.
            pending.append({'messageKey': 'enron:' + record['source_id'], 'vendorId': VENDOR,
                            **mail, 'body': mail['body'][:20000], 'attachmentDocumentIds': documents})
            source_ids.append(record['source_id']); attachment_texts.append('\n'.join(texts))
            if len(pending) == 100:
                flush()
        flush()
        counts = dict(index.execute('SELECT kind,count(*) FROM records WHERE db_id IS NOT NULL GROUP BY kind'))
        report = {'database': db.config.database, 'imported': counts, 'requested_emails': limit,
                  'seconds': round(time.monotonic()-started, 2), 'source': SOURCE, 'attribution': ATTRIBUTION,
                  'mapping': 'All public emails assigned artificial benchmark vendor ENRON-BENCH; original parties/dates preserved.',
                  'body_truncations': index.execute("SELECT count(*) FROM records WHERE kind='email' AND db_id IS NOT NULL AND length(json_extract(metadata,'$.body'))>20000").fetchone()[0]}
        (directory / 'import-report.json').write_text(json.dumps(report, indent=2))
        (directory / f'import-{limit}.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(report), flush=True)


def main():
    load_dotenv(Path.cwd() / '.env')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'attachments', 'import'])
    parser.add_argument('--directory', type=Path, default=Path('data/enron'))
    parser.add_argument('--limit', type=int, default=100000)
    args = parser.parse_args()
    if args.limit < 1:
        parser.error('--limit must be positive')
    if args.command == 'attachments':
        with corpus(args.directory / 'corpus.sqlite') as index:
            prepare_attachments(args.directory, index)
    else:
        (prepare if args.command == 'prepare' else import_corpus)(args.directory, args.limit)


if __name__ == '__main__':
    main()
