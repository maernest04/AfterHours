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

from .handler import extract
from .provider import bitdeer_session


async def run_job(db, lease, decide, *, model_run, timeout=240):
    if lease.role != 'EXTRACTION':
        raise ValueError('This handler only accepts EXTRACTION leases')
    interval = min(10, max(0.1, (lease.lease_expiry - datetime.now(timezone.utc)).total_seconds() / 3))

    async def renew():
        while True:
            await asyncio.sleep(interval)
            await asyncio.to_thread(heartbeat_job, db, lease)

    async def process():
        tools = AgentTools(db, lease.case_id)
        evidence = await asyncio.to_thread(tools.get_case_evidence)
        if evidence['case']['inputRevision'] != lease.case_revision:
            raise ValueError('Case revision changed before extraction')
        return await extract(evidence, tools, decide)

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


async def dry_run(case_id):
    """Read a case and print what Bitdeer would extract. Claims nothing and writes nothing."""
    with AfterHoursDB.connect('worker') as db:
        tools = AgentTools(db, case_id)
        evidence = await asyncio.to_thread(tools.get_case_evidence)
        async with bitdeer_session() as decide:
            print(json.dumps(await extract(evidence, tools, decide), indent=2))


async def run(case_id, watch):
    with AfterHoursDB.connect('worker') as db:
        while True:
            jobs = [job for job in list_claimable_jobs(db, ['EXTRACTION']) if job['case_id'] == case_id]
            if jobs:
                async with bitdeer_session() as decide:
                    job = jobs[0]
                    lease = claim_job(db, job['id'], job['case_id'], job['case_revision'])
                    result = await run_job(db, lease, decide, model_run='LIVE')
                    print(json.dumps({'jobId': result['id'], 'status': result['status'], 'modelRun': 'LIVE'}))
            if not watch:
                return
            await asyncio.sleep(2)


def main():
    parser = argparse.ArgumentParser(description='Run LIVE Bitdeer EXTRACTION jobs for one case')
    parser.add_argument('--case-id', type=int)
    parser.add_argument('--watch', action='store_true', help='keep polling for this case')
    parser.add_argument('--dry-run', action='store_true', help='print the extraction without claiming a job')
    parser.add_argument('--check-provider', action='store_true', help='one tiny live Bitdeer structured-output call')
    args = parser.parse_args()
    load_dotenv(Path.cwd() / '.env')
    if args.check_provider:
        async def check():
            async with bitdeer_session() as decide:
                result = await decide('Return {"ok": true}.', {
                    'type': 'object', 'properties': {'ok': {'type': 'boolean'}},
                    'required': ['ok'], 'additionalProperties': False})
                if result.get('ok') is not True:
                    raise RuntimeError('Bitdeer structured-output smoke failed')
                print('LIVE Bitdeer structured-output smoke passed')
        asyncio.run(check())
    elif args.case_id is None or args.case_id < 1:
        parser.error('--case-id must be a positive integer')
    elif args.dry_run:
        asyncio.run(dry_run(args.case_id))
    else:
        asyncio.run(run(args.case_id, args.watch))


if __name__ == '__main__':
    main()
