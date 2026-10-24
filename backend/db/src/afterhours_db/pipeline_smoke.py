"""Live synthetic import/mailbox/worker checks, run sequentially against a local DB.

No model API is called: agent output is explicitly replayed test evidence. Reads
query fresh server state; the only polling waits are for the scheduled lease sweep.
The final check temporarily changes job policy and restores its configured values.
"""
from contextlib import ExitStack
from dataclasses import replace
import json
import os
import time
import unittest
from uuid import uuid4

from .cases import (finalize_import, get_case, is_awaiting_proposal, list_cases,
                    list_facts, list_jobs, start_review)
from .client import SpacetimeClient, SpacetimeError
from .config import DatabaseConfig
from .documents import AfterHoursDB
from .identity import owner_token
from .jobs import claim_job, complete_job, heartbeat_job, list_claimable_jobs
from .mailbox import store_email
from .tools import AgentTools, ToolScopeError


def _output(summary: str, *, proposed_facts=None, proposed_matches=None,
            evidence_ids=None, unresolved_questions=None) -> dict:
    evidence = [] if evidence_ids is None else evidence_ids
    return {
        'proposedFacts': [] if proposed_facts is None else proposed_facts,
        'proposedMatches': [] if proposed_matches is None else proposed_matches,
        'evidenceIds': evidence,
        'unresolvedQuestions': [] if unresolved_questions is None else unresolved_questions,
        'explanation': {'summary': summary, 'evidenceIds': evidence},
    }


def _wait_for_sweep(read, description: str):
    deadline = time.monotonic() + 10
    while True:
        value = read()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise AssertionError(f'Timed out waiting for scheduled sweep: {description}')
        time.sleep(0.05)


class PipelineSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = DatabaseConfig.from_env()
        connections = ExitStack()
        cls.addClassCleanup(connections.close)
        cls.gateway = connections.enter_context(AfterHoursDB.connect('gateway', cls.config))
        cls.worker = connections.enter_context(AfterHoursDB.connect('worker', cls.config))
        cls.anon = connections.enter_context(SpacetimeClient(cls.config.uri, cls.config.database))
        cls.ref = f'PIPELINE-{uuid4().hex[:8]}'
        cls.vendor = f'V-{cls.ref}'
        cls.other_vendor = f'V-OTHER-{cls.ref}'
        cls.revision = 1
        cls.case_id = None
        ref = cls.ref
        cls.ids = {
            'contract': cls.upload('msa.txt', 'text/plain', 'CONTRACT',
                f'SYNTHETIC MSA {ref}\nHourly rate: $100.00 per hour, effective 2026-01-01.\n'
                'Authorized signatory: Dana Whitfield, Controller\n'),
            'timesheet': cls.upload('timesheet.csv', 'text/csv', 'TIMESHEET',
                'service_date,contractor,approved_minutes,billing_rate,status,approved_by\n'
                f'2026-09-01,Pat {ref},420,110.00,APPROVED,PM\n'
                f'2026-09-02,Pat {ref},480,110.00,APPROVED,PM\n'
                f'2026-09-03,Pat {ref},60,110.00,PENDING,\n'),
            'invoice': cls.upload('invoices.csv', 'text/csv', 'INVOICE',
                'invoice_number,contractor,service_start,service_end,minutes,amount,posting_status,posted_date\n'
                f'INV-{ref},Pat {ref},2026-09-01,2026-09-01,420,"700.00",POSTED,2026-09-20\n'),
            'ledger': cls.upload('ledger.csv', 'text/csv', 'LEDGER',
                'entry_id,vendor_id,period,kind,amount,status,description\n'
                f'ACR-{ref},{cls.vendor},2026-09,ACCRUAL,"1,500.00",POSTED,SYNTHETIC accrual\n'),
            'accrual': cls.upload('accrual.json', 'application/json', 'ACCRUAL', json.dumps({
                'entryId': f'ACR-{ref}', 'vendorId': cls.vendor, 'status': 'POSTED',
                'amountCents': '150000', 'postingPeriod': '2026-09'})),
            'amendment': cls.upload('amendment.txt', 'text/plain', 'AMENDMENT',
                f'SYNTHETIC AMENDMENT {ref}\nThe hourly rate changes from $100.00 to $110.00 '
                'per hour effective 2026-09-01.\nApproved and signed: Dana Whitfield, Controller\n'),
            'other_doc': cls.upload('other.txt', 'text/plain', 'OTHER', f'unrelated {ref}'),
        }
        cls.mail_amendment = store_email(cls.gateway, message_key=f'{ref}:m1', vendor_id=cls.vendor,
            thread_id=f'{ref}:T1', sender='contracts@vendor.example',
            recipients=['ap@northwind-demo.example'], subject=f'Signed amendment {ref}',
            sent_at='2026-08-28T17:05:00Z',
            body='Countersigned amendment attached: new hourly rate effective 2026-09-01.',
            attachment_document_ids=[cls.ids['amendment']])
        cls.mail_other = store_email(cls.gateway, message_key=f'{ref}:m2', vendor_id=cls.other_vendor,
            thread_id=f'{ref}:T2', sender='ar@other.example', recipients=['ap@northwind-demo.example'],
            subject=f'Other vendor amendment rate {ref}', sent_at='2026-09-01T10:00:00Z',
            body='amendment hourly rate for a different vendor', attachment_document_ids=[cls.ids['other_doc']])
        cls.import_input = dict(
            idempotency_key=f'{ref}:import', vendor_id=cls.vendor,
            document_ids=[cls.ids[name] for name in ('contract', 'timesheet', 'invoice', 'ledger', 'accrual')],
            service_period_from='2026-09-01', service_period_to='2026-09-30', posting_period='2026-09',
            original_status='POSTED', original_amount_cents='150000', source_entry_id=f'ACR-{ref}')
        print(f'[pipeline smoke] {cls.config.database}, reference {ref}')

    @classmethod
    def upload(cls, filename: str, media_type: str, document_type: str, body: str) -> int:
        return cls.gateway.upload_document(data=body.encode(), original_filename=filename,
            media_type=media_type, type=document_type, source_label='Python smoke (SYNTHETIC)').id

    def lease_for(self, role: str):
        jobs = [job for job in list_claimable_jobs(self.worker, roles=[role])
                if job['case_id'] == self.case_id]
        self.assertEqual(len(jobs), 1, f'Expected one claimable {role} job')
        return claim_job(self.worker, jobs[0]['id'], self.case_id, self.revision)

    def test_01_finalize_parses_facts_and_typed_evidence(self):
        case = finalize_import(self.gateway, **self.import_input)
        type(self).case_id = case['id']
        self.assertEqual((case['state'], case['input_revision'], case['blockers']), ('IMPORTED', 1, []))
        self.assertEqual(case['service_period_from'], '2026-09-01')
        self.assertEqual(case['original_amount_cents'], '150000')
        self.assertIsNone(case['current_proposal_id'])
        self.assertEqual(get_case(self.worker, self.case_id)['id'], self.case_id)
        evidence = AgentTools(self.worker, self.case_id).get_case_evidence()
        self.assertEqual(len(evidence['workItems']), 2)
        self.assertTrue(all(row['claimedRateCents'] == '11000' for row in evidence['workItems']))
        self.assertEqual([row['amountCents'] for row in evidence['invoiceLines']], ['70000'])
        self.assertEqual([row['amountCents'] for row in evidence['ledgerRecords']], ['150000'])
        pending = next(fact for fact in evidence['facts'] if 'PENDING' in fact['value'])
        self.assertEqual((pending['validationStatus'], pending['pageOrRow']), ('REJECTED', 'row 4'))
        self.assertTrue(any(fact['field'] == 'accrual.amountCents' and fact['value'] == '150000'
                            for fact in evidence['facts']))

    def test_02_import_idempotency_and_duplicate_source(self):
        self.assertEqual(finalize_import(self.gateway, **self.import_input)['id'], self.case_id)
        with self.assertRaisesRegex(SpacetimeError, 'already exists for source entry'):
            finalize_import(self.gateway, **{**self.import_input, 'idempotency_key': f'{self.ref}:import-2'})

    def test_03_missing_inputs_and_duplicate_work_block_review(self):
        duplicate = self.upload('dup.csv', 'text/csv', 'TIMESHEET',
            'service_date,contractor,approved_minutes,status\n'
            f'2026-09-01,Dup {self.ref},60,APPROVED\n2026-09-01,Dup {self.ref},60,APPROVED\n')
        case = finalize_import(self.gateway, **{**self.import_input,
            'idempotency_key': f'{self.ref}:blocked', 'source_entry_id': f'ACR-{self.ref}-B',
            'document_ids': [duplicate]})
        self.assertEqual(case['state'], 'WAITING_FOR_INPUT')
        self.assertTrue(any(blocker.startswith('DUPLICATE_WORK') for blocker in case['blockers']))
        self.assertEqual(sum(blocker.startswith('MISSING_INPUT') for blocker in case['blockers']), 4)
        with self.assertRaisesRegex(SpacetimeError, 'Case is WAITING_FOR_INPUT'):
            start_review(self.gateway, case['id'], 1)

    def test_04_start_review_is_idempotent_and_fresh_queries_see_updates(self):
        self.assertEqual(get_case(self.gateway, self.case_id)['id'], self.case_id)
        self.assertIn(self.case_id, [case['id'] for case in list_cases(self.gateway, state='IMPORTED')])
        self.assertEqual(start_review(self.gateway, self.case_id, 1)['state'], 'EXTRACTING')
        start_review(self.gateway, self.case_id, 1)
        jobs = list_jobs(self.gateway, self.case_id)
        self.assertEqual([(job['role'], job['status']) for job in jobs], [('EXTRACTION', 'QUEUED')])
        self.assertEqual(get_case(self.worker, self.case_id)['state'], 'EXTRACTING')

    def test_05_claim_requires_worker_and_anonymous_views_are_empty(self):
        job = list_jobs(self.gateway, self.case_id)[0]
        for client in (self.gateway.client, self.anon):
            with self.subTest(client=type(client).__name__):
                with self.assertRaisesRegex(SpacetimeError, 'Only the configured worker'):
                    client.call_reducer('claim_job', [job['id'], self.case_id, 1])
        for view in ('cases_view', 'jobs_view'):
            self.assertEqual(self.anon.query(f'SELECT * FROM {view}'), [])

    def test_06_extraction_lease_heartbeat_scope_and_completion(self):
        lease = self.lease_for('EXTRACTION')
        self.assertEqual((lease.status, lease.attempts), ('RUNNING', 1))
        self.assertRegex(lease.lease_token, r'^[0-9a-f]{32}$')
        for evidence in (f'doc:{self.ids["contract"]}', f'email:{self.mail_amendment["id"]}',
                         f'doc:{self.ids["amendment"]}'):
            self.assertIn(evidence, lease.allowed_evidence_ids)
        for evidence in (f'email:{self.mail_other["id"]}', f'doc:{self.ids["other_doc"]}'):
            self.assertNotIn(evidence, lease.allowed_evidence_ids)
        self.assertTrue(lease.facts)
        self.assertTrue(lease.policy_version)
        self.assertIsInstance(lease.output_schema, dict)
        with self.assertRaisesRegex(SpacetimeError, 'under another lease'):
            claim_job(self.worker, lease.id, self.case_id, self.revision)
        with AfterHoursDB.connect('worker', self.config) as competitor:
            with self.assertRaisesRegex(SpacetimeError, 'under another lease'):
                claim_job(competitor, lease.id, self.case_id, self.revision)
        self.assertGreaterEqual(heartbeat_job(self.worker, lease), lease.lease_expiry)
        rate = {'documentId': str(self.ids['contract']), 'pageOrRow': 'line 2',
                'excerpt': 'Hourly rate: $100.00 per hour, effective 2026-01-01.',
                'field': 'rate.hourlyCents', 'value': '10000'}
        with self.assertRaisesRegex(SpacetimeError, 'Stale or unknown lease'):
            complete_job(self.worker, replace(lease, lease_token='f' * 32), 'REPLAYED', _output('x'))
        with self.assertRaisesRegex(SpacetimeError, "outside this job's scope"):
            complete_job(self.worker, lease, 'REPLAYED', _output('x',
                evidence_ids=[f'email:{self.mail_other["id"]}']))
        with self.assertRaisesRegex(SpacetimeError, 'outside this case'):
            complete_job(self.worker, lease, 'REPLAYED', _output('x',
                proposed_facts=[{**rate, 'documentId': str(self.ids['other_doc'])}]))
        done = complete_job(self.worker, lease, 'REPLAYED', _output('Contract rate extracted',
            proposed_facts=[rate], evidence_ids=[f'doc:{self.ids["contract"]}']))
        self.assertEqual(done['status'], 'SUCCEEDED')
        self.assertEqual(get_case(self.gateway, self.case_id)['state'], 'MATCHING')
        fact = next(f for f in list_facts(self.gateway, self.case_id) if f['field'] == 'rate.hourlyCents')
        self.assertEqual((fact['validation_status'], fact['source'], fact['model_run']),
                         ('PROPOSED', 'AGENT', 'REPLAYED'))

    def test_07_matching_stores_allocations_and_queues_investigation(self):
        lease = self.lease_for('MATCHING')
        evidence = AgentTools(self.worker, self.case_id).get_case_evidence()
        matches = [{'workItemId': work['id'], 'contractId': str(self.ids['contract']),
                    'invoiceLineIds': [evidence['invoiceLines'][0]['id']] if work['serviceDate'] == '2026-09-01' else [],
                    'ledgerEntryIds': [evidence['ledgerRecords'][0]['id']],
                    'evidenceIds': [f'fact:{work["factId"]}']} for work in evidence['workItems']]
        with self.assertRaisesRegex(SpacetimeError, 'not in this case revision'):
            complete_job(self.worker, lease, 'REPLAYED', _output('x',
                proposed_matches=[{**matches[0], 'workItemId': '999999'}]))
        complete_job(self.worker, lease, 'REPLAYED', _output('Matched 2 work days',
            proposed_matches=matches, unresolved_questions=[
                'Timesheet bills $110/h but the contract says $100/h. Is there an approved amendment?']))
        self.assertEqual(get_case(self.gateway, self.case_id)['state'], 'INVESTIGATING')
        allocations = AgentTools(self.worker, self.case_id).get_case_evidence()['allocations']
        self.assertEqual(len(allocations), 2)
        self.assertTrue(all(row['contractId'] == str(self.ids['contract']) for row in allocations))

    def test_08_agent_mailbox_tools_enforce_vendor_and_attachment_scope(self):
        tools = AgentTools(self.worker, self.case_id)
        hits = tools.search_emails('amendment hourly rate')
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]['emailId'], str(self.mail_amendment['id']))
        self.assertEqual(hits[0]['attachmentDocumentIds'], [str(self.ids['amendment'])])
        self.assertLessEqual(len(hits[0]['snippet']), 242)
        with self.assertRaisesRegex(ToolScopeError, "outside this job's scope"):
            tools.search_emails('rate', vendor=self.other_vendor)
        self.assertIn('Countersigned', tools.read_email_thread(f'{self.ref}:T1')[0]['body'])
        with self.assertRaisesRegex(ToolScopeError, "outside this job's scope"):
            tools.read_email_thread(f'{self.ref}:T2')
        attachment = tools.read_attachment(str(self.ids['amendment']))
        self.assertEqual(attachment['type'], 'AMENDMENT')
        self.assertIn('$110.00 per hour', attachment['text'])
        with self.assertRaisesRegex(ToolScopeError, "outside this job's scope"):
            tools.read_attachment(str(self.ids['other_doc']))

    def test_09_investigation_finishes_at_proposal_handoff(self):
        lease = self.lease_for('INVESTIGATION')
        complete_job(self.worker, lease, 'REPLAYED', _output(
            'Signed Amendment No. 1 sets $110/h from 2026-09-01',
            evidence_ids=[f'email:{self.mail_amendment["id"]}', f'doc:{self.ids["amendment"]}'],
            proposed_facts=[{'documentId': str(self.ids['amendment']), 'pageOrRow': 'line 2',
                'excerpt': 'The hourly rate changes from $100.00 to $110.00 per hour effective 2026-09-01.',
                'field': 'rate.hourlyCents', 'value': '11000'}]))
        self.assertTrue(is_awaiting_proposal(self.gateway, self.case_id))
        case = get_case(self.gateway, self.case_id)
        self.assertEqual((case['state'], case['blockers']), ('INVESTIGATING', []))
        self.assertEqual([(job['role'], job['status']) for job in list_jobs(self.gateway, self.case_id)],
            [('EXTRACTION', 'SUCCEEDED'), ('MATCHING', 'SUCCEEDED'), ('INVESTIGATION', 'SUCCEEDED')])

    def test_10_expired_leases_requeue_and_retry_exhaustion_surfaces(self):
        restore_policy = [int(os.getenv('JOB_LEASE_SECONDS', '30')), int(os.getenv('JOB_MAX_ATTEMPTS', '3'))]
        with SpacetimeClient(self.config.uri, self.config.database, token=owner_token()) as owner:
            try:
                owner.call_reducer('configure_job_policy', [1, 2])
                case = finalize_import(self.gateway, **{**self.import_input,
                    'idempotency_key': f'{self.ref}:lease', 'source_entry_id': f'ACR-{self.ref}-L'})
                start_review(self.gateway, case['id'], 1)
                job = list_jobs(self.gateway, case['id'])[0]
                first = claim_job(self.worker, job['id'], case['id'], 1)
                requeued = _wait_for_sweep(lambda: next((row for row in list_jobs(self.gateway, case['id'])
                    if row['status'] == 'QUEUED' and row['attempts'] == 1), None), 'lease requeue')
                self.assertEqual(requeued['last_error'], 'Lease expired')
                with self.assertRaisesRegex(SpacetimeError, 'Stale or unknown lease'):
                    complete_job(self.worker, first, 'REPLAYED', _output('late'))
                second = claim_job(self.worker, job['id'], case['id'], 1)
                self.assertEqual(second.attempts, 2)
                self.assertNotEqual(second.lease_token, first.lease_token)
                failed = _wait_for_sweep(lambda: next((row for row in list_jobs(self.gateway, case['id'])
                    if row['status'] == 'FAILED'), None), 'job failure after max attempts')
                self.assertEqual(failed['attempts'], 2)
                failed_case = get_case(self.gateway, case['id'])
                self.assertEqual(failed_case['state'], 'RETRYABLE_ERROR')
                self.assertTrue(any(blocker.startswith('JOB_FAILED') for blocker in failed_case['blockers']))
            finally:
                owner.call_reducer('configure_job_policy', restore_policy)


def run() -> bool:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PipelineSmokeTests)
    return unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful()
