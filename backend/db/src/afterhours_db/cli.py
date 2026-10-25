"""Run from the repository root. Installs with `uv sync --project backend/db`."""
import argparse
import json
import os
from pathlib import Path
import subprocess

from dotenv import load_dotenv

from .client import SpacetimeClient
from .config import DatabaseConfig, spacetime_binary
from .identity import bootstrap, owner_token
from .seed import seed


def main():
    parser = argparse.ArgumentParser(description='AfterHours Python database tools')
    subcommands = parser.add_subparsers(dest='command', required=True)
    for name in ('start', 'stop', 'bootstrap', 'seed', 'smoke', 'intuit-import', 'intuit-post'):
        command = subcommands.add_parser(name)
        if name == 'intuit-import':
            command.add_argument('--period', default=None)
            command.add_argument('--start-review', action='store_true')
        if name == 'intuit-post':
            command.add_argument('--case-id', type=int, required=True)
            command.add_argument('--approve-hash', default=None)
    for name in ('publish', 'reset'):
        command = subcommands.add_parser(name)
        command.add_argument('--module-path', default='backend/db/spacetime/spacetimedb')
        if name == 'reset':
            command.add_argument('--yes', action='store_true', help='Confirm deletion of database rows')
    query = subcommands.add_parser('sql')
    query.add_argument('query', nargs='?', default='SELECT id, type, version, reference_id FROM documents')
    args = parser.parse_args()
    load_dotenv(Path.cwd() / '.env')
    config = DatabaseConfig.from_env()
    if args.command in ('start', 'stop'):
        command = ['up', '-d', '--wait', 'spacetimedb'] if args.command == 'start' else ['stop', 'spacetimedb']
        subprocess.run(['docker', 'compose', *command], check=True)
    elif args.command in ('publish', 'reset'):
        if args.command == 'reset' and not args.yes:
            parser.error('reset deletes database rows; supply --yes to confirm')
        command = [spacetime_binary(), 'publish', config.database, '--server', config.uri,
                   '--module-path', args.module_path, '--no-config', '--yes']
        if args.command == 'reset':
            command.append('--delete-data=always')
        subprocess.run(command, check=True)
    elif args.command == 'bootstrap':
        bootstrap(config)
    elif args.command == 'seed':
        seed(config)
    elif args.command == 'intuit-import':
        from .intuit import import_qbo
        import_qbo(config, args.period or os.getenv('INTUIT_PERIOD', '2026-09'), start=args.start_review)
    elif args.command == 'intuit-post':
        from .intuit import post_proposal
        post_proposal(config, args.case_id, args.approve_hash)
    elif args.command == 'smoke':
        from .smoke import run as storage_checks
        from .pipeline_smoke import run as pipeline_checks
        storage_ok = storage_checks()
        pipeline_ok = pipeline_checks()
        raise SystemExit(0 if storage_ok and pipeline_ok else 1)
    elif args.command == 'sql':
        with SpacetimeClient(config.uri, config.database, token=owner_token()) as client:
            print(json.dumps(client.query(args.query), indent=2))


if __name__ == '__main__':
    main()
