from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import uuid4

from .client import SpacetimeClient
from .config import DatabaseConfig
from .files import FileStore
from .identity import service_client

DocumentType = Literal['ACCRUAL', 'CONTRACT', 'AMENDMENT', 'TIMESHEET', 'INVOICE', 'LEDGER', 'OTHER']
DOCUMENT_TYPES = {'ACCRUAL', 'CONTRACT', 'AMENDMENT', 'TIMESHEET', 'INVOICE', 'LEDGER', 'OTHER'}
MEDIA_TYPES = {'text/csv', 'application/json', 'text/plain', 'application/pdf'}
MAX_UPLOAD_BYTES = 10 * 1024 * 1024


@dataclass(frozen=True)
class Document:
    id: int
    company_id: str
    storage_key: str
    type: DocumentType
    version: int
    content_hash: str
    byte_length: int
    media_type: str
    original_filename: str
    reference_id: str | None
    source_label: str
    supersedes_document_id: int | None
    upload_key: str
    created_at: datetime

    @classmethod
    def from_row(cls, row: dict):
        values = dict(row)
        timestamp = values['created_at']
        if isinstance(timestamp, dict):
            timestamp = timestamp['__timestamp_micros_since_unix_epoch__']
        values['created_at'] = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=int(timestamp))
        return cls(**values)


@dataclass(frozen=True)
class Verification:
    ok: bool
    error: str | None = None


def _check_upload(data: bytes, media_type: str):
    if not 1 <= len(data) <= MAX_UPLOAD_BYTES:
        raise ValueError(f'Upload must be 1 to {MAX_UPLOAD_BYTES} bytes')
    if media_type not in MEDIA_TYPES:
        raise ValueError(f'Unsupported media type {media_type}')


class AfterHoursDB:
    """Typed document repository backed by service-authorized views and reducers."""
    def __init__(self, client: SpacetimeClient, config: DatabaseConfig):
        self.client = client
        self.config = config
        self.files = FileStore(config.file_store_dir)

    @classmethod
    def connect(cls, role: Literal['gateway', 'worker'], config: DatabaseConfig | None = None):
        config = config or DatabaseConfig.from_env()
        client = service_client(role, config, persistent=(role == 'worker'))
        try:
            roles = client.query('SELECT * FROM my_service_identity')
            if len(roles) != 1 or roles[0]['role'] != role.upper():
                raise RuntimeError(f'Identity is not registered as {role}; run afterhours-db bootstrap')
            return cls(client, config)
        except Exception:
            client.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        self.client.close()

    def settings(self) -> dict:
        rows = self.client.query('SELECT * FROM settings_view')
        if len(rows) != 1:
            raise RuntimeError('Settings unavailable; run afterhours-db bootstrap')
        return rows[0]

    def list_documents(self, *, type: DocumentType | None = None,
                       reference_id: str | None = None, latest_only: bool = False) -> list[Document]:
        documents = [Document.from_row(row) for row in self.client.query('SELECT * FROM documents_view')]
        superseded = {doc.supersedes_document_id for doc in documents}
        return sorted((doc for doc in documents if (type is None or doc.type == type)
                       and (reference_id is None or doc.reference_id == reference_id)
                       and (not latest_only or doc.id not in superseded)), key=lambda doc: doc.id)

    def get_document(self, document_id: int) -> Document | None:
        return next((doc for doc in self.list_documents() if doc.id == document_id), None)

    def find_by_upload_key(self, upload_key: str) -> Document | None:
        return next((doc for doc in self.list_documents() if doc.upload_key == upload_key), None)

    def find_by_content_hash(self, content_hash: str) -> list[Document]:
        return [doc for doc in self.list_documents() if doc.content_hash == content_hash]

    def _stored_document(self, upload_key: str) -> Document:
        document = self.find_by_upload_key(upload_key)
        if document is None:
            raise RuntimeError(f'Reducer committed but document {upload_key} is not visible')
        return document

    def upload_document(self, *, data: bytes, original_filename: str, media_type: str,
                        type: DocumentType, source_label: str, reference_id: str | None = None,
                        upload_key: str | None = None) -> Document:
        _check_upload(data, media_type)
        if type not in DOCUMENT_TYPES:
            raise ValueError(f'Unsupported document type {type}')
        key = upload_key if upload_key is not None else str(uuid4())
        saved = self.files.put(data)
        self.client.call_reducer('store_document', [self.config.company_id, key,
            saved.storage_key, saved.content_hash, saved.byte_length, media_type,
            original_filename, type, {'none': []} if reference_id is None else {'some': reference_id}, source_label])
        return self._stored_document(key)

    def add_document_version(self, previous_document_id: int, *, data: bytes,
                             original_filename: str, media_type: str, source_label: str,
                             upload_key: str | None = None) -> Document:
        _check_upload(data, media_type)
        key = upload_key if upload_key is not None else str(uuid4())
        saved = self.files.put(data)
        self.client.call_reducer('store_document_version', [self.config.company_id, key, previous_document_id,
            saved.storage_key, saved.content_hash, saved.byte_length, media_type, original_filename, source_label])
        return self._stored_document(key)

    def get_version_history(self, document_id: int) -> list[Document]:
        documents = self.list_documents()
        by_id = {doc.id: doc for doc in documents}
        first = by_id.get(document_id)
        if first is None:
            return []
        while first.supersedes_document_id is not None:
            first = by_id[first.supersedes_document_id]
        next_versions = {doc.supersedes_document_id: doc for doc in documents if doc.supersedes_document_id is not None}
        chain = [first]
        while chain[-1].id in next_versions:
            chain.append(next_versions[chain[-1].id])
        return chain

    def read_document(self, document_id: int) -> tuple[Document, bytes]:
        document = self.get_document(document_id)
        if document is None:
            raise LookupError(f'Document {document_id} not found')
        return document, self.files.read(document.storage_key, document.content_hash, document.byte_length)

    def verify_document(self, document_id: int) -> Verification:
        try:
            self.read_document(document_id)
            return Verification(True)
        except (LookupError, OSError, ValueError) as error:
            return Verification(False, str(error))
