"""Run explicit synthetic inbox fixtures; no silent fallback from live approval."""
from __future__ import annotations

import argparse
from datetime import datetime
import json
import math
from pathlib import Path
import signal
import sys
from threading import Event

from .core import CurrentCase, Email, Proposal
from .runtime import MemoryMockRepository, poll_once


def _read(path: Path) -> dict:
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict) or data.get('mode') != 'MOCK' or data.get('schema_version') != 1:
        raise ValueError('fixture requires mode MOCK and schema_version 1')
    for field in ('proposals', 'cases', 'emails'):
        if not isinstance(data.get(field), list):
            raise ValueError('fixture requires proposals, cases and emails lists')
    return data


def _with_dates(row: dict, *fields: str) -> dict:
    result = dict(row)
    for field in fields:
        result[field] = datetime.fromisoformat(result[field])
    return result


def load_mock_repository(path: Path) -> MemoryMockRepository:
    data = _read(path)
    proposals = [Proposal(**_with_dates(row, 'issued_at', 'expires_at')) for row in data['proposals']]
    cases = {}
    for row in data['cases']:
        values = dict(row)
        key = (values.pop('company_id'), values.pop('case_id'))
        if key in cases:
            raise ValueError('duplicate current case in mock fixture')
        cases[key] = CurrentCase(**values)
    return MemoryMockRepository(proposals, cases)


class JsonMockMailbox:
    """Re-read synthetic messages each poll; proposal authority is loaded at startup."""
    def __init__(self, path: Path):
        self.path = path

    def poll(self) -> tuple[Email, ...]:
        return tuple(Email(**_with_dates(row, 'received_at')) for row in _read(self.path)['emails'])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mock-fixture', type=Path, help='explicit MOCK JSON fixture; all state is in memory')
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--poll-seconds', type=float, default=5)
    args = parser.parse_args(argv)
    if not math.isfinite(args.poll_seconds) or args.poll_seconds <= 0:
        parser.error('--poll-seconds must be finite and positive')
    if args.mock_fixture is None:
        print('Authoritative approval persistence and reviewer authentication are not configured. '
              'Use --mock-fixture only for a synthetic local demo.', file=sys.stderr)
        return 2
    stopped = Event()
    try:
        repository = load_mock_repository(args.mock_fixture)
        mailbox = JsonMockMailbox(args.mock_fixture)
        signal.signal(signal.SIGINT, lambda *_: stopped.set())
        signal.signal(signal.SIGTERM, lambda *_: stopped.set())
        print('MOCK mode: decisions and deduplication are in memory; restart resets both.', file=sys.stderr)
        while not stopped.is_set():
            for decision in poll_once(mailbox, repository):
                # Email bodies, request tokens, reviewer addresses and questions stay out of logs.
                print(json.dumps(dict(mode='MOCK', message_id=decision.message_id,
                                      outcome=decision.outcome, proposal_id=decision.proposal_id,
                                      proposal_version=decision.proposal_version,
                                      reason=decision.reason)), flush=True)
            if args.once:
                break
            stopped.wait(args.poll_seconds)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        print(f'Mock watcher stopped: invalid/unavailable fixture ({type(exc).__name__}).', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
