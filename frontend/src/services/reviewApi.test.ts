import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewApi, type ApiReview } from "./reviewApi";
const snapshot = (sequence = "12", input_revision = 1): ApiReview => ({
  review_id: "review-1",
  status: "READY_FOR_REVIEW",
  created_at: "2026-10-01T09:00:00Z",
  updated_at: "2026-10-01T09:10:00Z",
  sequence,
  input_revision,
  currency: "USD",
  original_status: "POSTED",
  original_amount_cents: "700000",
  corrected_target_cents: "770000",
  difference_cents: "70000",
  export_amount_cents: "70000",
  proposal_id: "proposal-1",
  proposal_hash: "hash",
  journal_lines: [],
  evidence: [],
  history: [],
  blockers: [],
});
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  handlers: Record<string, (e: { data: string }) => void> = {};
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.handlers[type] = fn;
  }
  close() {
    this.closed = true;
  }
  emit(data: ApiReview) {
    this.handlers["review.updated"]({ data: JSON.stringify(data) });
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeEventSource.instances = [];
});
describe("real Python route transport (not activated in demo)", () => {
  it("reports 501 explicitly and never treats it as completion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 501 })),
    );
    await expect(new ReviewApi("/api").get("review-1")).rejects.toThrow(
      "not implemented",
    );
  });
  it("uses only documented request fields and enforces list cap", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ items: [], next_cursor: null })),
      );
    vi.stubGlobal("fetch", fetcher);
    const api = new ReviewApi("/api");
    await expect(api.list(11)).rejects.toThrow("1–10");
    await api.list(10, "cursor-value");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/list-review?limit=10&cursor=cursor-value",
      undefined,
    );
  });
  it("posts hash-bound approval to the gateway", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          review_id: "1",
          proposal_hash: "abc",
          posted: true,
          already_posted: false,
          qbo_id: "146",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    await new ReviewApi("/api").approve("1", "abc");
    expect(fetcher).toHaveBeenCalledWith("/api/approve-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ review_id: "1", proposal_hash: "abc" }),
    });
  });
  it("rehydrates after disconnect, deduplicates snapshots and uses the same get route", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify(snapshot()))),
        ),
    );
    const updates = vi.fn(),
      connection = vi.fn();
    const unsubscribe = new ReviewApi("/api").subscribe(
      "review-1",
      updates,
      connection,
    );
    await vi.advanceTimersByTimeAsync(0);
    const first = FakeEventSource.instances[0];
    expect(first.url).toBe(
      "/api/get-review?review_id=review-1&live=true&after_sequence=12",
    );
    first.onopen?.();
    first.emit(snapshot());
    expect(updates).toHaveBeenCalledTimes(1);
    first.emit(snapshot("13"));
    expect(updates).toHaveBeenCalledTimes(2);
    first.emit(snapshot("stale", 0));
    expect(updates).toHaveBeenCalledTimes(2);
    first.onerror?.();
    expect(connection).toHaveBeenCalledWith("disconnected");
    await vi.advanceTimersByTimeAsync(2000);
    expect(updates).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances[1].url).toContain("after_sequence=13");
    unsubscribe();
    expect(FakeEventSource.instances[1].closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
