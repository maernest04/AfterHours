"""Python service entry point; all workflow state stays in SpacetimeDB."""
import argparse
import json
import logging
import os
from pathlib import Path
import signal
import threading

from afterhours_db import AfterHoursDB
from dotenv import load_dotenv

from .pipeline import extraction_configured, investigation_from_env, live_extraction_session, run_cycle


def main(argv=None):
    parser = argparse.ArgumentParser(description='Poll imports and dispatch ready AfterHours workers')
    parser.add_argument('--once', action='store_true', help='Run one bounded poll cycle and exit')
    parser.add_argument('--case-id', type=int, help='Restrict imports and worker jobs to one case')
    parser.add_argument('--max-jobs', type=int, default=10,
                        help='Maximum worker attempts and, separately, proposal attempts per cycle (default: 10 each)')
    parser.add_argument('--poll-seconds', type=float, default=2, help='Delay between cycles (default: 2)')
    args = parser.parse_args(argv)
    if args.max_jobs < 1 or (args.case_id is not None and args.case_id < 1) or not 0 < args.poll_seconds <= 300:
        parser.error('case-id/max-jobs must be positive; poll-seconds must be between 0 and 300')
    load_dotenv(Path.cwd() / '.env')
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    stop = threading.Event()
    calculation_cursor = None
    previous = {}
    for signum in (signal.SIGINT, signal.SIGTERM):
        previous[signum] = signal.signal(signum, lambda *_: stop.set())
    try:
        while not stop.is_set():
            failed = False
            try:
                # A fresh connection each cycle recovers from transport failure;
                # workers keep it open throughout inference and final completion.
                with AfterHoursDB.connect('gateway') as gateway, AfterHoursDB.connect('worker') as worker:
                    investigation_session, investigation_model_run = investigation_from_env()
                    report = run_cycle(gateway, worker, case_id=args.case_id, max_jobs=args.max_jobs, stop=stop,
                        calculation_after_case_id=calculation_cursor,
                        investigation_session=investigation_session,
                        investigation_model_run=investigation_model_run,
                        investigation_timeout=float(os.getenv('INVESTIGATION_TIMEOUT_SECONDS', '180')),
                        extraction_session=live_extraction_session if extraction_configured() else None,
                        extraction_timeout=float(os.getenv('EXTRACTION_TIMEOUT_SECONDS', '240')))
                    calculation_cursor = report.last_calculation_case_id
                failed = bool(report.errors)
                print(json.dumps({'started_cases': report.started_cases,
                    'completed_jobs': [{key: job[key] for key in ('id', 'case_id', 'role', 'status')}
                                       for job in report.completed_jobs],
                    'completed_proposals': [{key: proposal[key] for key in (
                        'id', 'case_id', 'input_revision', 'entry_date', 'corrected_target_cents',
                        'adjustment_cents', 'export_amount_cents', 'hash')}
                        for proposal in report.completed_proposals],
                    'errors': report.errors, 'blocked': report.blocked}), flush=True)
            except Exception as error:
                failed = True
                logging.error('Pipeline poll failed (%s); next poll reconnects. No success reported.', type(error).__name__)
            if args.once:
                if failed:
                    raise SystemExit(1)
                return
            stop.wait(args.poll_seconds)
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


if __name__ == '__main__':
    main()
