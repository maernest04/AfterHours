"""Deterministic API-to-SDK integration checks; no database, model or email calls."""

import threading
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock

import httpx

from backend.api.main import app
from backend.api.repository import RepositoryUnavailable, SDKReviewRepository
from backend.api.responses import ReviewSummary
from backend.api.service import InvalidCursor, ReviewService, get_review_service


def summary(review_id):
    return ReviewSummary(review_id=str(review_id), status="MATCHING",
                         created_at=datetime(2026, 10, 24, tzinfo=timezone.utc),
                         updated_at=datetime(2026, 10, 24, tzinfo=timezone.utc))


class ServiceTests(unittest.TestCase):
    def test_cursor_pages_are_numeric_ordered_and_bounded(self):
        repository = MagicMock()
        repository.list_reviews.return_value = [summary(i) for i in range(12, 0, -1)]
        service = ReviewService(repository)
        first = service.list_reviews()
        self.assertEqual([row.review_id for row in first.items], [str(i) for i in range(1, 11)])
        self.assertIsNotNone(first.next_cursor)
        second = service.list_reviews(cursor=first.next_cursor)
        self.assertEqual([row.review_id for row in second.items], ["11", "12"])
        self.assertIsNone(second.next_cursor)
        # Deleting the last item on the previous page does not break continuation.
        repository.list_reviews.return_value = [summary(11), summary(12), summary(13)]
        self.assertEqual([row.review_id for row in service.list_reviews(cursor=first.next_cursor).items], ["11", "12", "13"])

    def test_empty_and_exact_limit_have_no_cursor(self):
        repository = MagicMock()
        service = ReviewService(repository)
        repository.list_reviews.return_value = []
        self.assertEqual(service.list_reviews().model_dump(), {"items": [], "next_cursor": None})
        repository.list_reviews.return_value = [summary(1)]
        self.assertIsNone(service.list_reviews(limit=1).next_cursor)

    def test_invalid_cursors_fail_before_database_access(self):
        repository = MagicMock()
        service = ReviewService(repository)
        for cursor in ("page-2", "!!!", "x" * 129, "cmV2aWV3czp2Mjox", "cmV2aWV3czp2MTotMQ"):
            with self.subTest(cursor=cursor), self.assertRaises(InvalidCursor):
                service.list_reviews(cursor=cursor)
        repository.list_reviews.assert_not_called()


class RepositoryTests(unittest.TestCase):
    def database(self):
        db = MagicMock()
        db.__enter__.return_value = db
        return db

    def test_sdk_query_maps_exact_id_state_and_microsecond_timestamps(self):
        db = self.database()
        db.client.query.return_value = [{
            "id": 9007199254740993, "state": "INVESTIGATING",
            "created_at": {"__timestamp_micros_since_unix_epoch__": 1000001},
            "updated_at": 2000002,
        }]
        result = SDKReviewRepository(lambda: db).list_reviews()
        self.assertEqual(result[0].review_id, "9007199254740993")
        self.assertEqual(result[0].status, "INVESTIGATING")
        self.assertEqual(result[0].created_at.isoformat(), "1970-01-01T00:00:01.000001+00:00")
        self.assertEqual(result[0].updated_at.isoformat(), "1970-01-01T00:00:02.000002+00:00")
        db.client.query.assert_called_once_with("SELECT * FROM cases_view")
        db.__exit__.assert_called_once()

    def test_transport_failure_closes_connection_and_hides_details(self):
        db = self.database()
        db.client.query.side_effect = httpx.ConnectError("sensitive backend detail")
        with self.assertRaisesRegex(RepositoryUnavailable, "^Review storage is unavailable.$"):
            SDKReviewRepository(lambda: db).list_reviews()
        db.__exit__.assert_called_once()

    def test_unknown_state_is_not_fabricated_as_a_successful_review(self):
        db = self.database()
        db.client.query.return_value = [{"id": 1, "state": "UNRECOGNIZED", "created_at": 1, "updated_at": 1}]
        with self.assertRaises(RepositoryUnavailable):
            SDKReviewRepository(lambda: db).list_reviews()


class RouteIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.repository = MagicMock()
        self.repository.list_reviews.return_value = [summary(1), summary(2)]
        app.dependency_overrides[get_review_service] = lambda: ReviewService(self.repository)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def asyncTearDown(self):
        app.dependency_overrides.pop(get_review_service, None)
        await self.client.aclose()

    async def test_route_returns_real_summaries_and_runs_sync_reads_off_event_loop(self):
        main_thread = threading.get_ident()
        def read():
            self.assertNotEqual(threading.get_ident(), main_thread)
            return [summary(1), summary(2)]
        self.repository.list_reviews.side_effect = read
        first = await self.client.get("/list-review", params={"limit": 1})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["items"][0]["status"], "MATCHING")
        second = await self.client.get("/list-review", params={"cursor": first.json()["next_cursor"]})
        self.assertEqual([item["review_id"] for item in second.json()["items"]], ["2"])
        self.assertIsNone(second.json()["next_cursor"])

    async def test_unavailable_database_is_503_never_empty_success(self):
        self.repository.list_reviews.side_effect = RepositoryUnavailable("Review storage is unavailable.")
        response = await self.client.get("/list-review")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"]["code"], "STORAGE_UNAVAILABLE")

    async def test_pending_operations_do_not_touch_database(self):
        for path, params in [("/get-review", {"review_id": "1"}),
                             ("/get-review", {"review_id": "1", "live": True, "after_sequence": "5"}),
                             ("/export-review", {"review_id": "1"})]:
            response = await self.client.get(path, params=params)
            self.assertEqual(response.status_code, 501)
            self.assertEqual(response.headers["content-type"], "application/json")
        response = await self.client.post("/create-review", files={"files": ("accrual.csv", b"amount\n7000", "text/csv")})
        self.assertEqual(response.status_code, 501)
        self.repository.list_reviews.assert_not_called()


if __name__ == "__main__":
    unittest.main()
