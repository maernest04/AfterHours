from __future__ import annotations

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import tempfile


@dataclass(frozen=True)
class StoredFile:
    storage_key: str
    content_hash: str
    byte_length: int


class FileStore:
    def __init__(self, root: Path | str):
        self.root = Path(root)

    def path_for(self, storage_key: str) -> Path:
        match = re.fullmatch(r'sha256/([0-9a-f]{64})', storage_key)
        if not match:
            raise ValueError('Invalid storage key')
        digest = match[1]
        return self.root / 'sha256' / digest[:2] / digest

    def put(self, data: bytes) -> StoredFile:
        digest = hashlib.sha256(data).hexdigest()
        saved = StoredFile(f'sha256/{digest}', digest, len(data))
        path = self.path_for(saved.storage_key)
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            # Link a complete temporary file atomically; never replace existing content.
            fd, temporary = tempfile.mkstemp(dir=path.parent, suffix='.tmp')
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                try:
                    os.link(temporary, path)
                except FileExistsError:
                    pass
            finally:
                os.unlink(temporary)
        self.read(saved.storage_key, digest, len(data))
        return saved

    def read(self, storage_key: str, content_hash: str, byte_length: int) -> bytes:
        data = self.path_for(storage_key).read_bytes()
        if len(data) != byte_length:
            raise ValueError(f'File size differs from recorded {byte_length}')
        if hashlib.sha256(data).hexdigest() != content_hash:
            raise ValueError('File hash differs from recorded hash')
        return data
