from collections import deque
import argparse
import json
from pathlib import Path

from afterhours_db import AfterHoursDB
from afterhours_db.tools import AgentTools
from dotenv import load_dotenv

from .handler import FIELDS, validate_output


def _coverage(evidence):
    work = {row['id']: row for row in evidence['workItems']}
    matches = {}
    for match in evidence['allocations']:
        if match['workItemId'] in matches:
            raise ValueError('Duplicate or ambiguous work matches')
        matches[match['workItemId']] = match
    if set(matches) != set(work):
        raise ValueError('Every work item requires exactly one validated match')
    cutoff = evidence['case']['servicePeriod']['to']
    invoices = [row for row in evidence['invoiceLines'] if row['postingStatus'] == 'POSTED'
                and row['postedDate'] <= cutoff and any(
                    item['contractor'] == row['contractor'] and row['serviceStart'] <= item['serviceDate'] <= row['serviceEnd']
                    for item in work.values())]
    graph, original = {}, {}

    def edge(source, target, capacity):
        graph.setdefault(source, {})[target] = capacity
        graph.setdefault(target, {})[source] = 0
        original[source, target] = capacity

    for invoice in invoices:
        edge('source', 'i:' + invoice['id'], invoice['minutes'])
        for work_id, item in work.items():
            if (invoice['id'] in matches[work_id]['invoiceLineIds'] and item['contractor'] == invoice['contractor']
                    and invoice['serviceStart'] <= item['serviceDate'] <= invoice['serviceEnd']):
                edge('i:' + invoice['id'], 'w:' + work_id, min(invoice['minutes'], item['approvedMinutes']))
    for work_id, item in work.items():
        edge('w:' + work_id, 'sink', item['approvedMinutes'])
    flow = 0
    while True:
        previous, queue = {'source': None}, deque(['source'])
        while queue and 'sink' not in previous:
            node = queue.popleft()
            for target, capacity in graph.get(node, {}).items():
                if capacity > 0 and target not in previous:
                    previous[target] = node
                    queue.append(target)
        if 'sink' not in previous:
            break
        amount, node = sum(row['minutes'] for row in invoices), 'sink'
        while previous[node] is not None:
            amount = min(amount, graph[previous[node]][node])
            node = previous[node]
        node = 'sink'
        while previous[node] is not None:
            source = previous[node]
            graph[source][node] -= amount
            graph[node][source] += amount
            node = source
        flow += amount
    if flow != sum(row['minutes'] for row in invoices):
        raise ValueError('Invoice coverage is missing, ambiguous, or double counts work')
    return [[int(source[2:]), int(target[2:]), capacity - graph[source][target]]
            for (source, target), capacity in original.items()
            if source.startswith('i:') and target.startswith('w:') and capacity > graph[source][target]]


def build_proposal(db, case_id, expected_revision, *, entry_date):
    tools = AgentTools(db, case_id)
    evidence = tools.get_case_evidence()
    if evidence['case']['inputRevision'] != expected_revision:
        raise ValueError('Stale calculator revision')
    groups = {}
    for fact in evidence['facts']:
        if fact['field'] not in FIELDS or fact['validationStatus'] == 'REJECTED':
            continue
        group = groups.setdefault(fact['documentId'], {})
        if fact['field'] in group and group[fact['field']]['value'] != fact['value']:
            raise ValueError('Conflicting extracted values need resolution')
        group[fact['field']] = fact
    required = {'rate.hourlyCents', 'rate.effectiveFrom', 'rate.approvedBy', 'rate.signedDate'}
    complete = {doc_id: group for doc_id, group in groups.items() if required <= group.keys()}
    documents = {doc_id: tools.read_attachment(doc_id) for doc_id in complete}
    for document in evidence['documents']:
        if document['type'] == 'CONTRACT' and document['documentId'] not in documents:
            documents[document['documentId']] = tools.read_attachment(document['documentId'])
    for doc_id, group in groups.items():
        if doc_id not in complete and tools.read_attachment(doc_id)['type'] == 'AMENDMENT':
            raise ValueError('Incomplete amendment facts need investigation')
    facts = [{key: fact[key] for key in ('documentId', 'pageOrRow', 'excerpt', 'field', 'value')}
             for group in complete.values() for fact in group.values()]
    validate_output({'proposedFacts': facts, 'proposedMatches': [], 'evidenceIds': evidence['allowedEvidenceIds'],
                     'unresolvedQuestions': [], 'explanation': {
                         'summary': 'Source-validated rate facts for deterministic calculation.',
                         'evidenceIds': [f'doc:{doc_id}' for doc_id in complete]}}, evidence, documents)
    rates = []
    for item in evidence['workItems']:
        applicable = [(doc_id, group) for doc_id, group in complete.items()
                      if group['rate.effectiveFrom']['value'] <= item['serviceDate']
                      <= group.get('rate.effectiveTo', {'value': '9999-12-31'})['value']]
        amendments = [(doc_id, group) for doc_id, group in applicable if documents[doc_id]['type'] == 'AMENDMENT']
        candidates = amendments or applicable
        if len(candidates) != 1:
            raise ValueError('Work has no unique applicable, approved contractual rate')
        _, group = candidates[0]
        rates.append([int(item['id']), int(group['rate.hourlyCents']['id'])])
    coverage = _coverage(evidence)
    permitted_contracts = {doc_id for doc_id, doc in documents.items() if doc['type'] == 'CONTRACT'} | set(complete)
    if any(match['contractId'] not in permitted_contracts for match in evidence['allocations']):
        raise ValueError('Work match does not identify a verified contract or amendment')
    settings = db.settings()
    db.client.call_reducer('build_proposal', [case_id, expected_revision, settings['policy_version'],
                                            entry_date, rates, coverage, evidence['allowedEvidenceIds']])
    case = tools.get_case_evidence()['case']
    proposal = next((row for row in db.client.query('SELECT * FROM proposals_view')
                     if row['id'] == int(case['currentProposalId'])), None)
    if proposal is None:
        raise RuntimeError('Proposal committed but is not visible')
    return proposal


def main():
    parser = argparse.ArgumentParser(description='Build an unapproved, source-validated accrual proposal')
    parser.add_argument('--case-id', type=int, required=True)
    parser.add_argument('--revision', type=int, required=True)
    parser.add_argument('--entry-date', required=True)
    args = parser.parse_args()
    load_dotenv(Path.cwd() / '.env')
    with AfterHoursDB.connect('gateway') as db:
        proposal = build_proposal(db, args.case_id, args.revision, entry_date=args.entry_date)
        print(json.dumps({key: proposal[key] for key in ('id', 'corrected_target_cents',
                         'adjustment_cents', 'export_amount_cents', 'hash')}))


if __name__ == '__main__':
    main()
