import argparse
import asyncio
from contextlib import suppress
from datetime import datetime, timezone
import json
from pathlib import Path

from afterhours_db import AfterHoursDB
from afterhours_db.jobs import claim_job, complete_job, heartbeat_job, list_claimable_jobs
from afterhours_db.tools import AgentTools
from dotenv import load_dotenv

from .factory import factory_session
from .handler import investigate


async def run_job(db, lease, decide, *, model_run, timeout=180, tools=None):
    if lease.role != 'INVESTIGATION':
        raise ValueError('This handler only accepts INVESTIGATION leases')
    interval = min(10, max(0.1, (lease.lease_expiry - datetime.now(timezone.utc)).total_seconds() / 3))

    async def renew():
        while True:
            await asyncio.sleep(interval)
            await asyncio.to_thread(heartbeat_job, db, lease)

    async def process():
        scoped_tools = tools or AgentTools(db, lease.case_id)
        evidence = await asyncio.to_thread(scoped_tools.get_case_evidence)
        if evidence['case']['inputRevision'] != lease.case_revision:
            raise ValueError('Case revision changed before investigation')
        return await investigate(evidence, scoped_tools, decide)

    task = asyncio.create_task(process())
    heartbeat = asyncio.create_task(renew())
    try:
        async with asyncio.timeout(timeout):
            done, _ = await asyncio.wait({task, heartbeat}, return_when=asyncio.FIRST_COMPLETED)
            if heartbeat in done:
                await heartbeat
            output = await task
            heartbeat.cancel()
            with suppress(asyncio.CancelledError):
                await heartbeat
            await asyncio.to_thread(heartbeat_job, db, lease)
            return await asyncio.to_thread(complete_job, db, lease, model_run, output)
    finally:
        for pending in (task, heartbeat):
            pending.cancel()
        await asyncio.gather(task, heartbeat, return_exceptions=True)


async def run(case_id, watch, search_index=None):
    with AfterHoursDB.connect('worker') as db:
        while True:
            jobs = [job for job in list_claimable_jobs(db, ['INVESTIGATION']) if job['case_id'] == case_id]
            if jobs:
                async with factory_session() as decide:
                    job = jobs[0]
                    tools = None
                    if search_index:
                        from .indexed_tools import IndexedAgentTools
                        tools = IndexedAgentTools(db, case_id, search_index)
                    lease = claim_job(db, job['id'], job['case_id'], job['case_revision'],
                                      evidence_ids=tools.evidence_ids() if tools else None)
                    result = await run_job(db, lease, decide, model_run='LIVE', tools=tools)
                    print(json.dumps({'jobId': result['id'], 'status': result['status'], 'modelRun': 'LIVE'}))
            if not watch:
                return
            await asyncio.sleep(2)


def main():
    parser = argparse.ArgumentParser(description='Run LIVE Investigation jobs for one case')
    parser.add_argument('--case-id', type=int)
    parser.add_argument('--watch', action='store_true')
    parser.add_argument('--search-index', type=Path, help='Derived Enron corpus.sqlite index for bounded retrieval')
    parser.add_argument('--check-provider', action='store_true')
    args = parser.parse_args()
    load_dotenv(Path.cwd() / '.env')
    if args.check_provider:
        async def check():
            async with factory_session() as decide:
                result = await decide('Return {"ok": true}; do not use any tools.', {
                    'type': 'object', 'properties': {'ok': {'const': True}},
                    'required': ['ok'], 'additionalProperties': False})
                if result != {'ok': True}:
                    raise RuntimeError('Factory structured-output smoke failed')
                print('LIVE Factory structured-output smoke passed; all native tools disabled')
        asyncio.run(check())
    elif args.case_id is None or args.case_id < 1:
        parser.error('--case-id must be a positive integer')
    else:
        asyncio.run(run(args.case_id, args.watch, args.search_index))


if __name__ == '__main__':
    main()
