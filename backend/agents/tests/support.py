"""Hand-authored provider replay oracle, used only in tests."""
from copy import deepcopy


def evidence_fixture():
    return {
        'case': {'id': '1', 'inputRevision': 1, 'vendorId': 'V-ACME',
                 'servicePeriod': {'from': '2026-09-01', 'to': '2026-09-30'},
                 'postingPeriod': '2026-09', 'sourceEntryId': 'ACR-1'},
        'documents': [{'documentId': '10', 'type': 'CONTRACT', 'evidenceId': 'doc:10'}],
        'facts': [{'id': '20', 'documentId': '11', 'validationStatus': 'ACCEPTED'},
                  {'id': '21', 'documentId': '12', 'validationStatus': 'ACCEPTED'},
                  {'id': '22', 'documentId': '13', 'validationStatus': 'ACCEPTED'}],
        'workItems': [{'id': '30', 'factId': '20', 'contractor': 'Alex Rivera',
            'serviceDate': '2026-09-10', 'approvedMinutes': 420, 'claimedRateCents': '10000'}],
        'invoiceLines': [{'id': '40', 'factId': '21', 'contractor': 'Alex Rivera',
            'serviceStart': '2026-09-10', 'serviceEnd': '2026-09-10', 'minutes': 420,
            'amountCents': '70000', 'postingStatus': 'POSTED'}],
        'ledgerRecords': [{'id': '50', 'factId': '22', 'entryId': 'ACR-1', 'vendorId': 'V-ACME',
            'period': '2026-09', 'kind': 'ACCRUAL', 'status': 'POSTED'}],
        'allowedEvidenceIds': ['doc:10', 'fact:20', 'fact:21', 'fact:22'],
        'allocations': [], 'jobs': [], 'jobResults': [],
    }


def valid_output():
    evidence = ['doc:10', 'fact:20', 'fact:21', 'fact:22']
    return {'proposedFacts': [], 'proposedMatches': [{'workItemId': '30', 'contractId': '10',
        'invoiceLineIds': ['40'], 'ledgerEntryIds': ['50'], 'evidenceIds': evidence}],
        'evidenceIds': evidence, 'unresolvedQuestions': [],
        'explanation': {'summary': 'Approved work matches the governing agreement and invoice.',
                        'evidenceIds': evidence}}


class ReplayProvider:
    """Uses a scenario selected by the test, never inferred by production code."""
    model_run = 'REPLAYED'

    def __init__(self, scenario):
        self.scenario = scenario

    def generate(self, context, schema, *, cancel):
        if cancel.is_set():
            raise RuntimeError('cancelled')
        documents = context['documents']
        contract = next(d['documentId'] for d in documents if d['filename'] == 'contract.txt')
        ledger = next(r for r in context['ledgerRecords']
                      if r['entryId'] == context['case']['sourceEntryId'])
        questions = {
            'missing_amendment': ['Which signed amendment supports the September 20 rate change?'],
            'ambiguous_invoice': ['Which of the two September 20 invoices is authoritative?'],
            'conflicting_contract': ['Which overlapping agreement governs these services?'],
        }.get(self.scenario, [])
        matches = []
        for work in context['workItems']:
            if self.scenario == 'conflicting_contract':
                continue
            chosen_contract = contract
            if self.scenario == 'amendment' and work['serviceDate'] == '2026-09-20':
                chosen_contract = next(d['documentId'] for d in documents if d['type'] == 'AMENDMENT')
            invoices = [r for r in context['invoiceLines'] if
                r['contractor'] == work['contractor'] and
                r['serviceStart'] <= work['serviceDate'] <= r['serviceEnd']]
            if self.scenario == 'ambiguous_invoice' and work['serviceDate'] == '2026-09-20':
                invoices = []
            evidence = [f'doc:{chosen_contract}', f'fact:{work["factId"]}', f'fact:{ledger["factId"]}']
            evidence += [f'fact:{r["factId"]}' for r in invoices]
            matches.append({'workItemId': work['id'], 'contractId': chosen_contract,
                'invoiceLineIds': [r['id'] for r in invoices], 'ledgerEntryIds': [ledger['id']],
                'evidenceIds': evidence})
        evidence = sorted({e for m in matches for e in m['evidenceIds']} | {f'doc:{contract}'})
        return {'proposedFacts': [], 'proposedMatches': matches, 'evidenceIds': evidence,
            'unresolvedQuestions': questions, 'explanation': {
                'summary': f'Synthetic matching replay: {self.scenario}.', 'evidenceIds': evidence}}
