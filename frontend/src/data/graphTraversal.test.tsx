// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { MockReviewAdapter } from "./mockReviewAdapter";
import { nodesFor } from "./apiReviewAdapter";
import { traversalFrames } from "./graphTraversal";
import { CHECKPOINT_DWELL_MS, useGraphTraversal } from "../components/useGraphTraversal";
import type { CaseSnapshot } from "./reviewAdapter";

function snapshot(api: string, status: CaseSnapshot["status"]): CaseSnapshot {
  return { ...new MockReviewAdapter().snapshot, runId: "live-test", inputRevision: 1,
    connection: "connected", status, blocker: null, nodeStates: nodesFor(api) };
}
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("shows combined amendment and proposal checks without changing the real case status", () => {
  const frames = traversalFrames(snapshot("MATCHING", "running"), snapshot("READY_FOR_REVIEW", "review"));
  expect(frames.map(f => f.presentationStep)).toEqual(["agrees", "amendment", "calculate", "review"]);
  expect(frames.every(f => f.status === "review")).toBe(true);
  expect(frames[2].nodeStates.calculate).toBe("complete");
  expect(frames[2].nodeStates.review).toBe("queued");
  expect(frames.every(f => !Object.values(f.nodeStates).includes("running"))).toBe(true);
});

it("keeps pending checkpoints when a newer API snapshot arrives", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(({ live }) => useGraphTraversal(live, false),
    { initialProps: { live: snapshot("EXTRACTING", "running") } });
  rerender({ live: snapshot("MATCHING", "running") });
  expect(result.current.presentationStep).toBe("contract");
  rerender({ live: snapshot("READY_FOR_REVIEW", "review") });
  expect(result.current.presentationStep).toBe("contract");
  const visited: string[] = [];
  for (let i = 0; i < 12; i++) {
    if (result.current.presentationStep) visited.push(result.current.presentationStep);
    act(() => vi.advanceTimersByTime(CHECKPOINT_DWELL_MS));
  }
  expect(visited).toEqual(["contract", "work", "invoice", "ledger", "schema", "agrees", "amendment", "calculate", "review"]);
  expect(result.current.presentationStep).toBeUndefined();
  expect(result.current.status).toBe("review");
});

it("interrupts playback immediately when the server reports a blocker", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(({ live }) => useGraphTraversal(live, false),
    { initialProps: { live: snapshot("EXTRACTING", "running") } });
  rerender({ live: snapshot("MATCHING", "running") });
  const blocked = { ...snapshot("RETRYABLE_ERROR", "blocked"), blocker: "Proposal failed" };
  rerender({ live: blocked });
  act(() => vi.runAllTimers());
  expect(result.current).toBe(blocked);
});
