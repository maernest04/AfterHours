"""Bounded queue dispatch; SpacetimeDB remains the sole workflow authority."""
import asyncio
from calendar import monthrange
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import date
import os
import threading

from afterhours_db.cases import is_awaiting_proposal, list_cases, mark_proposal_failure, start_review
from afterhours_db.jobs import claim_job, list_claimable_jobs
from afterhours_db.client import SpacetimeError
from afterhours_agents.factory import FactoryProvider
from afterhours_agents.worker import run_once as run_matching
from afterhours_extraction.provider import bitdeer_session
from afterhours_extraction.worker import run_job as run_extraction
from afterhours_investigation.factory import factory_session
from afterhours_investigation.calculator import build_proposal
from afterhours_investigation.worker import run_job as run_investigation

_DEFAULT_BUILDER = object()


@dataclass
class CycleReport:
    started_cases: list[int] = field(default_factory=list)
    completed_jobs: list[dict] = field(default_factory=list)
    completed_proposals: list[dict] = field(default_factory=list)
    errors: list[dict] = field(default_factory=list)
    blocked: list[dict] = field(default_factory=list)
    last_calculation_case_id: int | None = None


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


@asynccontextmanager
async def live_extraction_session():
    if not os.getenv('BITDEER_API_KEY'):
        raise ValueError('Set BITDEER_API_KEY before running extraction')
    async with bitdeer_session() as decide:
        yield decide


def extraction_configured():
    return bool(os.getenv('BITDEER_API_KEY'))


async def _investigate(db, job, session, model_run, timeout, stop, runner=None):
    runner = runner or run_investigation   # resolved at call time so tests can patch it

    async def work():
        # Provider setup must succeed before acquiring a lease.
        async with session() as decide:
            if stop.is_set():
                return None
            lease = claim_job(db, job['id'], job['case_id'], job['case_revision'])
            return await runner(db, lease, decide, model_run=model_run, timeout=timeout)

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
              investigation_timeout=180, extraction_session=None, extraction_model_run='LIVE',
              extraction_timeout=240, calculation_after_case_id=None, proposal_builder=_DEFAULT_BUILDER):
    """Recover imports, then attempt at most max_jobs ready jobs, scoped optionally.

    Providers can be injected for offline replay tests. The runtime defaults only
    to LIVE providers; it never synthesizes agent results. EXTRACTION
    runs only when an extraction_session is passed (the CLI passes the live Bitdeer
    session when BITDEER_API_KEY is set); otherwise extraction jobs stay queued and are
    reported as blocked.
    Failed jobs retain their DB lease for the existing expiry/retry policy.
    Ready cases run the deterministic calculator, up to max_jobs proposal attempts
    in addition to the worker budget. Proposal entry dates use posting month-end.
    Carry last_calculation_case_id into the next poll as calculation_after_case_id
    to rotate bounded attempts past failing cases. This cursor stores no job state.
    """
    if max_jobs < 1 or (case_id is not None and case_id < 1):
        raise ValueError('max_jobs and case_id must be positive')
    if investigation_model_run not in {'LIVE', 'REPLAYED'}:
        raise ValueError('Investigation provenance must be LIVE or REPLAYED')
    if not 0 < investigation_timeout <= 600:
        raise ValueError('Investigation timeout must be between 0 and 600 seconds')
    if extraction_model_run not in {'LIVE', 'REPLAYED'} or not 0 < extraction_timeout <= 600:
        raise ValueError('Extraction needs LIVE/REPLAYED provenance and a timeout of 1-600 seconds')
    roles = ['MATCHING', 'INVESTIGATION'] + (['EXTRACTION'] if extraction_session else [])
    if proposal_builder is _DEFAULT_BUILDER:
        proposal_builder = build_proposal
    stop = stop if stop is not None else threading.Event()
    report = CycleReport(last_calculation_case_id=calculation_after_case_id)
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
        jobs = [job for job in list_claimable_jobs(worker_db, roles=roles)
                if job['id'] not in attempted and (case_id is None or job['case_id'] == case_id)]
        if not jobs:
            break
        job = jobs[0]
        attempted.add(job['id'])
        try:
            if job['role'] == 'MATCHING':
                provider = matching_provider_factory()
                result = run_matching(worker_db, provider, case_id=job['case_id'], cancel=stop)
            elif job['role'] == 'EXTRACTION':
                result = asyncio.run(_investigate(worker_db, job, extraction_session,
                    extraction_model_run, extraction_timeout, stop, runner=run_extraction))
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
        calculation_attempts = 0
        cases = list_cases(gateway_db)
        if case_id is None and calculation_after_case_id is not None:
            cases = ([case for case in cases if case['id'] > calculation_after_case_id]
                     + [case for case in cases if case['id'] <= calculation_after_case_id])
        for case in cases:
            if stop.is_set():
                break
            if case_id is not None and case['id'] != case_id:
                continue
            if case['state'] == 'EXTRACTING' and not extraction_session:
                report.blocked.append({'case_id': case['id'], 'stage': 'EXTRACTION'})
            elif (case['state'] in {'MATCHING', 'INVESTIGATING'}
                  and not case['blockers'] and case['current_proposal_id'] is None
                  and calculation_attempts < max_jobs):
                if proposal_builder is None:
                    if is_awaiting_proposal(gateway_db, case['id']):
                        report.blocked.append({'case_id': case['id'], 'stage': 'CALCULATION'})
                    continue
                try:
                    if not is_awaiting_proposal(gateway_db, case['id']):
                        continue
                    calculation_attempts += 1
                    # Advance on failure as well as success, so a closed period or
                    # invalid source cannot monopolize every bounded polling cycle.
                    report.last_calculation_case_id = case['id']
                    # Stable across retries and always inside the configured posting
                    # period. Never substitute today's date or silently open periods.
                    period = date.fromisoformat(case['posting_period'] + '-01')
                    entry_date = period.replace(day=monthrange(period.year, period.month)[1]).isoformat()
                    proposal = proposal_builder(gateway_db, case['id'], case['input_revision'], entry_date=entry_date)
                    report.completed_proposals.append(proposal)
                except Exception as error:
                    # Reducer/source validation failures stay visible and retryable;
                    # do not fabricate an approval, export or successful proposal.
                    report.errors.append({'case_id': case['id'], 'stage': 'CALCULATION',
                                          'error': type(error).__name__})
                    report.blocked.append({'case_id': case['id'], 'stage': 'CALCULATION'})
                    # A reducer validation rejection needs an explicit UI blocker.
                    # Transport/provider errors retain the teammate's retry behavior.
                    if isinstance(error, SpacetimeError) and error.status_code == 530:
                        try:
                            mark_proposal_failure(gateway_db, case['id'], case['input_revision'],
                                'Deterministic proposal validation failed; check source consistency.')
                        except Exception:
                            pass
    return report
