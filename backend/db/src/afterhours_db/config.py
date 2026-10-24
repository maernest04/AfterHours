from dataclasses import dataclass
import os
from pathlib import Path
import shutil


@dataclass(frozen=True)
class DatabaseConfig:
    uri: str = 'http://localhost:3000'
    database: str = 'accrual-docs'
    company_id: str = 'demo'
    file_store_dir: Path = Path('data/files')
    secrets_dir: Path = Path('backend/.secrets')

    @classmethod
    def from_env(cls):
        return cls(uri=os.getenv('SPACETIMEDB_URI', cls.uri),
                   database=os.getenv('SPACETIMEDB_DATABASE', cls.database),
                   company_id=os.getenv('COMPANY_ID', cls.company_id),
                   file_store_dir=Path(os.getenv('FILE_STORE_DIR', 'data/files')),
                   secrets_dir=Path(os.getenv('SPACETIMEDB_SECRETS_DIR', 'backend/.secrets')))


def spacetime_binary() -> str:
    configured = os.getenv('SPACETIME_BIN') or shutil.which('spacetime')
    if configured:
        return configured
    candidates = [Path.home() / '.local/bin/spacetime']
    if os.getenv('LOCALAPPDATA'):
        candidates.append(Path(os.environ['LOCALAPPDATA']) / 'SpacetimeDB/spacetime.exe')
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    raise RuntimeError('Install the SpacetimeDB CLI or set SPACETIME_BIN')
