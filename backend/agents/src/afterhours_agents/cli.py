"""Run from the repo root, or in the matching service container."""
import argparse
import json
import logging
import os
from pathlib import Path
import signal
import threading

from dotenv import load_dotenv
from afterhours_db import AfterHoursDB
from .factory import FactoryProvider
from .worker import run_once


def main():
    parser = argparse.ArgumentParser(description='Run the Factory MATCHING worker')
    parser.add_argument('--once', action='store_true', help='Process at most one queued job and exit')
    parser.add_argument('--case-id', type=int, help='Restrict processing to one case')
    args = parser.parse_args()
    load_dotenv(Path.cwd() / '.env')
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    try:
        provider = FactoryProvider(api_key=os.getenv('FACTORY_API_KEY', ''),
            model=os.getenv('FACTORY_MODEL_ID', ''), executable=os.getenv('DROID_EXEC_PATH', 'droid'),
            timeout=float(os.getenv('MATCHING_TIMEOUT_SECONDS', '120')))
    except (ValueError, RuntimeError) as error:
        parser.exit(2, f'{error}\n')
    stop = threading.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stop.set())
    while not stop.is_set():
        try:
            # Reconnect per job; a failed transport cannot poison later attempts.
            with AfterHoursDB.connect('worker') as db:
                result = run_once(db, provider, case_id=args.case_id, cancel=stop)
            if result:
                print(json.dumps({'job_id': result['id'], 'case_id': result['case_id'],
                                  'status': result['status'], 'model_run': provider.model_run}), flush=True)
        except Exception as error:
            # Do not emit model payloads/credentials. DB expiry handles retries.
            logging.error('Matching attempt failed (%s); no success reported. Lease expiry handles retry.',
                          type(error).__name__)
            if args.once:
                raise SystemExit(1) from None
        if args.once:
            return
        stop.wait(2)


if __name__ == '__main__':
    main()
