from copy import deepcopy
import json
import threading
import unittest

from support import evidence_fixture, valid_output


class MatchingTests(unittest.TestCase):
    def validate(self, output, context=None):
        from afterhours_agents.matching import validate_output
        return validate_output(output, context or evidence_fixture())

    def test_valid_match_preserves_exact_ids(self):
        result = self.validate(valid_output())
        self.assertEqual(result['proposedMatches'][0]['workItemId'], '30')

    def test_rejects_invalid_ids_duplicate_work_missing_citations_and_extra_fields(self):
        for mutation in ('invented', 'duplicate', 'uncited', 'extra', 'fact', 'blank_summary', 'blank_question'):
            output = valid_output()
            match = output['proposedMatches'][0]
            if mutation == 'invented': match['invoiceLineIds'] = ['9999']
            if mutation == 'duplicate': output['proposedMatches'].append(deepcopy(match))
            if mutation == 'uncited': match['evidenceIds'] = ['doc:10']
            if mutation == 'extra': output['approve'] = True
            if mutation == 'fact': output['proposedFacts'] = [{'documentId': '10', 'pageOrRow': '1',
                'excerpt': 'x', 'field': 'approval', 'value': 'yes'}]
            if mutation == 'blank_summary': output['explanation']['summary'] = ' '
            if mutation == 'blank_question': output['unresolvedQuestions'] = [' ']
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.validate(output)

    def test_rejects_semantically_unrelated_invoice_and_ledger(self):
        for field, value, collection in [('contractor', 'Other', 'invoiceLines'),
            ('serviceStart', '2026-10-01', 'invoiceLines'), ('minutes', 60, 'invoiceLines'),
            ('vendorId', 'Other', 'ledgerRecords'), ('period', '2026-08', 'ledgerRecords')]:
            context = evidence_fixture()
            context[collection][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.validate(valid_output(), context)

    def test_missing_work_must_surface_a_question(self):
        output = valid_output()
        output['proposedMatches'] = []
        with self.assertRaises(ValueError):
            self.validate(output)
        output['unresolvedQuestions'] = ['Which agreement applies to work item 30?']
        self.validate(output)

    def test_competing_invoices_cannot_be_silently_resolved(self):
        context = evidence_fixture()
        context['invoiceLines'].append({**context['invoiceLines'][0], 'id': '41'})
        with self.assertRaises(ValueError):
            self.validate(valid_output(), context)

    def test_unknown_or_unseen_evidence_rejected(self):
        context = evidence_fixture()
        context['allowedEvidenceIds'].append('email:99')
        output = valid_output()
        output['explanation']['evidenceIds'].append('email:99')
        with self.assertRaises(ValueError):
            self.validate(output, context)

    def test_prompt_contains_schema_evidence_and_untrusted_boundary(self):
        from afterhours_agents.matching import build_prompt
        from afterhours_db.jobs import AGENT_OUTPUT_SCHEMA
        prompt = build_prompt(evidence_fixture(), AGENT_OUTPUT_SCHEMA)
        self.assertIn('UNTRUSTED_EVIDENCE_JSON', prompt)
        self.assertIn('V-ACME', prompt)
        self.assertIn('unresolvedQuestions', prompt)

    def test_conflicting_extracted_rates_need_question_even_without_claimed_rate(self):
        context = evidence_fixture()
        context['workItems'][0]['claimedRateCents'] = None
        context['facts'] += [{'id': str(id), 'documentId': '10', 'validationStatus': 'PROPOSED',
                             'field': 'rate.hourlyCents', 'value': rate}
                            for id, rate in [(23, '10000'), (24, '13000')]]
        with self.assertRaises(ValueError):
            self.validate(valid_output(), context)


if __name__ == '__main__':
    unittest.main()
