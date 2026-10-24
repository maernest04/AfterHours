"""One matching lease at a time, with independent heartbeat during inference."""
from datetime import datetime, timezone
import threading
import time

from afterhours_db.jobs import claim_job, complete_job, heartbeat_job, list_claimable_jobs
from afterhours_db.tools import AgentTools
from .matching import collect_context, validate_output


class LeaseLost(RuntimeError):
    pass


def run_once(db, provider, *, case_id=None, cancel=None, heartbeat_interval=None):
    shutdown = cancel if cancel is not None else threading.Event()
    cancel = threading.Event()
    if shutdown.is_set():
        return None
    if provider.model_run not in {'LIVE', 'REPLAYED'}:
        raise ValueError('Provider must declare LIVE or REPLAYED provenance')
    jobs = [j for j in list_claimable_jobs(db, roles=['MATCHING'])
            if case_id is None or j['case_id'] == case_id]
    if not jobs:
        return None
    job = jobs[0]
    lease = claim_job(db, job['id'], job['case_id'], job['case_revision'])
    duration = (lease.lease_expiry - datetime.now(timezone.utc)).total_seconds()
    interval = max(0.05, min(10, duration / 3))
    if heartbeat_interval is not None:
        if heartbeat_interval <= 0:
            raise ValueError('Heartbeat interval must be positive')
        interval = min(interval, heartbeat_interval)
    stopped = threading.Event()
    errors = []

    def renew():
        next_heartbeat = time.monotonic() + interval
        while not stopped.wait(min(0.05, interval)):
            if shutdown.is_set():
                cancel.set()
                return
            if time.monotonic() < next_heartbeat:
                continue
            try:
                heartbeat_job(db, lease)
                next_heartbeat = time.monotonic() + interval
            except Exception as error:
                errors.append(error)
                cancel.set()
                return

    heartbeats = threading.Thread(target=renew, name=f'matching-heartbeat-{lease.id}', daemon=True)
    heartbeats.start()
    try:
        context = collect_context(AgentTools(db, lease.case_id), lease)
        output = provider.generate(context, lease.output_schema, cancel=cancel)
        validate_output(output, context)
        stopped.set()
        heartbeats.join()
        if errors:
            raise LeaseLost('Matching job lost its lease; result was not submitted') from errors[0]
        if cancel.is_set() or shutdown.is_set():
            raise LeaseLost('Matching job cancelled; result was not submitted')
        # Revalidate ownership immediately before committing the output.
        heartbeat_job(db, lease)
        if cancel.is_set() or shutdown.is_set():
            raise LeaseLost('Matching job cancelled during final renewal; result was not submitted')
        return complete_job(db, lease, provider.model_run, output)
    except Exception:
        if errors:
            raise LeaseLost('Matching job lost its lease; result was not submitted') from errors[0]
        raise
    finally:
        stopped.set()
        heartbeats.join()
