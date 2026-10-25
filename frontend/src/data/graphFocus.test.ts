import { expect, it } from "vitest";
import { graphFocusStep } from "./graphFocus";
import { MockReviewAdapter } from "./mockReviewAdapter";
import { nodesFor } from "./apiReviewAdapter";
import type { CaseSnapshot } from "./reviewAdapter";

it("follows active API stages and lands on review even when no node is running", () => {
  const base = new MockReviewAdapter().snapshot;
  for (const [api, status, expected] of [
    ["IMPORTED", "ready", "import"],
    ["EXTRACTING", "running", "read"],
    ["MATCHING", "running", "match"],
    ["INVESTIGATING", "running", "mailbox"],
    ["WAITING_FOR_INPUT", "waiting", "missing"],
    ["READY_FOR_REVIEW", "review", "review"],
    ["APPROVED", "approved", "approved"],
    ["EXPORTED", "exported", "export"],
  ] as const) {
    expect(graphFocusStep({ ...base, status, nodeStates: nodesFor(api) })).toBe(expected);
  }
});

it("focuses the failing proposal rather than a previously completed step", () => {
  const snapshot: CaseSnapshot = { ...new MockReviewAdapter().snapshot, status: "blocked",
    nodeStates: nodesFor("RETRYABLE_ERROR", ["PROPOSAL_FAILED: validation failed"]) };
  expect(graphFocusStep(snapshot)).toBe("proposal");
});
