import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiReviewAdapter } from "./apiReviewAdapter";
import type { ApiReview } from "../services/reviewApi";
const review = (overrides: Partial<ApiReview> = {}): ApiReview => ({
  review_id: "1",
  status: "READY_FOR_REVIEW",
  created_at: "2026-10-01T09:00:00Z",
  updated_at: "2026-10-01T09:10:00Z",
  sequence: "12",
  input_revision: 1,
  currency: "USD",
  original_status: "POSTED",
  original_amount_cents: "75500",
  corrected_target_cents: "80000",
  difference_cents: "4500",
  export_amount_cents: "4500",
  proposal_id: "9",
  proposal_hash: "deadbeef",
  journal_lines: [
    {
      entry_date: "2026-09-30",
      reference_id: "QBO-36",
      account_code: "6000",
      account_name: "Expense",
      debit_cents: "4500",
      credit_cents: "0",
      currency: "USD",
      description: "Adjustment",
    },
  ],
  evidence: [],
  history: [],
  blockers: [],
  ...overrides,
});
class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  close() {}
}
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("api review adapter", () => {
  it("approve posts the current proposal hash", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(review())))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            review_id: "1",
            proposal_hash: "deadbeef",
            posted: true,
            already_posted: false,
            qbo_id: "146",
          }),
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("EventSource", FakeEventSource);
    const adapter = new ApiReviewAdapter("1", "/api");
    adapter.subscribeCase("1", () => {});
    await vi.waitFor(() => {
      expect(adapter.snapshot.proposal?.hash).toBe("deadbeef");
    });
    expect(adapter.snapshot.status).toBe("review");
    await adapter.approve("1", 99);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      review_id: "1",
      proposal_hash: "deadbeef",
    });
    expect(adapter.snapshot.status).toBe("approved");
    expect(adapter.snapshot.connection).not.toBe("demo");
  });
});
