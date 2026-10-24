"""Resume must establish identity before any pipeline side effects."""
import unittest
from unittest.mock import MagicMock, patch

from test_review_scenarios_live import run_scenario


class ScenarioResumeTests(unittest.TestCase):
    def test_wrong_case_or_database_cannot_start_pipeline(self):
        for actual_key, saved_database in [('different-key', 'test-db'), ('saved-key', 'other-db')]:
            with self.subTest(actual_key=actual_key, saved_database=saved_database):
                record = {'case_id': 1, 'idempotency_key': 'saved-key',
                          'database': saved_database, 'setup_complete': True}
                db = MagicMock()
                db.config.database = 'test-db'
                with patch('afterhours_db.AfterHoursDB.connect') as connect, \
                     patch('afterhours_db.cases.get_case', return_value={'idempotency_key': actual_key}), \
                     patch('afterhours_orchestrator.pipeline.run_cycle') as cycle, \
                     patch('httpx.Client') as client:
                    connect.return_value.__enter__.return_value = db
                    with self.assertRaisesRegex(AssertionError, 'database'):
                        run_scenario('baseline', record, lambda: None)
                    cycle.assert_not_called()
                    db.upload_document.assert_not_called()
                    client.return_value.__enter__.return_value.post.assert_not_called()


if __name__ == '__main__':
    unittest.main()
