"""Bounded queue dispatch; SpacetimeDB remains the sole workflow authority."""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import os
import threading

from afterhours_db.cases import is_awaiting_proposal, list_cases, start_review
from afterhours_db.jobs import claim_job, list_claimable_jobs
from afterhours_agents.factory import FactoryProvider
from afterhours_agents.worker import run_once as run_matching
from afterhours_investigation.factory import factory_session
from afterhours_investigation.worker import run_job as run_investigation


@dataclass
class CycleReport:
    started_cases: list[int] = field(default_factory=list)
    completed_jobs: list[dict] = field(default_factory=list)
    errors: list[dict] = field(default_factory=list)
    blocked: list[dict] = field(default_factory=list)


def live_matching_provider():
    return FactoryProvider(api_key=os.getenv('FACTORY_API_KEY', ''),
        model=os.getenv('FACTORY_MODEL_ID', ''), executable=os.getenv('DROID_EXEC_PATH', 'droid'),
        timeout=float(os.getenv('MATCHING_TIMEOUT_SECONDS', '120')))


@asynccontextmanager
async def live_investigation_session():
    if not os.getenv('FACTORY_API_KEY') or not os.getenv('FACTORY_MODEL_ID'):
        raise ValueError('Set FACTORY_API_KEY and FACTORY_MODEL_ID before running investigation')
    async with factory_session() as decide:
        yield decide


async def _investigate(db, job, session, model_run, timeout, stop):
    async def work():
        # Provider setup must succeed before acquiring a lease.
        async with session() as decide:
            if stop.is_set():
                return None
            lease = claim_job(db, job['id'], job['case_id'], job['case_revision'])
            return await run_investigation(db, lease, decide, model_run=model_run, timeout=timeout)

    async def wait_for_shutdown():
        while not stop.is_set():
            await asyncio.sleep(0.05)

    task = asyncio.create_task(work())
    shutdown = asyncio.create_task(wait_for_shutdown())
    try:
        # Include provider startup in the deadline, not only leased inference.
        async with asyncio.timeout(timeout):
            done, _ = await asyncio.wait({task, shutdown}, return_when=asyncio.FIRST_COMPLETED)
            if shutdown in done:
                return None
            return await task
    finally:
        task.cancel()
        shutdown.cancel()
        await asyncio.gather(task, shutdown, return_exceptions=True)


def run_cycle(gateway_db, worker_db, *, case_id=None, max_jobs=10, stop=None,
              matching_provider_factory=live_matching_provider,
              investigation_session=live_investigation_session, investigation_model_run='LIVE',
              investigation_timeout=180):
    """Recover imports, then attempt at most max_jobs ready jobs, scoped optionally.

    Providers can be injected for offline replay tests. The runtime defaults only
    to LIVE providers; it never synthesizes extraction or proposal results.
    Failed jobs retain their DB lease for the existing expiry/retry policy.
    """
    if max_jobs < 1 or (case_id is not None and case_id < 1):
        raise ValueError('max_jobs and case_id must be positive')
    if investigation_model_run not in {'LIVE', 'REPLAYED'}:
        raise ValueError('Investigation provenance must be LIVE or REPLAYED')
    if not 0 < investigation_timeout <= 600:
        raise ValueError('Investigation timeout must be between 0 and 600 seconds')
    stop = stop if stop is not None else threading.Event()
    report = CycleReport()
    if stop.is_set():
        return report

    # Import acceptance and scheduling are deliberately separate transactions.
    # A restart after either one simply rediscovers authoritative database state.
    for case in list_cases(gateway_db, state='IMPORTED'):
        if stop.is_set():
            return report
        if case_id is not None and case['id'] != case_id:
            continue
        try:
            start_review(gateway_db, case['id'], case['input_revision'])
            report.started_cases.append(case['id'])
        except Exception as error:
            report.errors.append({'case_id': case['id'], 'stage': 'START_REVIEW',
                                  'error': type(error).__name__})

    attempted = set()
    while len(attempted) < max_jobs and not stop.is_set():
        jobs = [job for job in list_claimable_jobs(worker_db, roles=['MATCHING', 'INVESTIGATION'])
                if job['id'] not in attempted and (case_id is None or job['case_id'] == case_id)]
        if not jobs:
            break
        job = jobs[0]
        attempted.add(job['id'])
        try:
            if job['role'] == 'MATCHING':
                provider = matching_provider_factory()
                result = run_matching(worker_db, provider, case_id=job['case_id'], cancel=stop)
            else:
                result = asyncio.run(_investigate(worker_db, job, investigation_session,
                    investigation_model_run, investigation_timeout, stop))
            if result is not None:
                report.completed_jobs.append(result)
        except Exception as error:
            # Exception messages can include credentials or model output.
            report.errors.append({'case_id': job['case_id'], 'job_id': job['id'],
                                  'stage': job['role'], 'error': type(error).__name__})

    if not stop.is_set():
        for case in list_cases(gateway_db):
            if case_id is not None and case['id'] != case_id:
                continue
            if case['state'] == 'EXTRACTING':
                report.blocked.append({'case_id': case['id'], 'stage': 'EXTRACTION'})
            elif is_awaiting_proposal(gateway_db, case['id']):
                report.blocked.append({'case_id': case['id'], 'stage': 'PROPOSAL'})
    return report
