import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { MockReviewAdapter } from "./mockReviewAdapter";
import { CASE_ID, proposal } from "./fixtures";
import { acceptSnapshot, canExport, journalText, money } from "./reviewAdapter";
import { steps, links } from "./topology";
describe("deterministic review, version gates and generic CSV", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  async function ready(
    variant: ConstructorParameters<typeof MockReviewAdapter>[0] = "amendment",
  ) {
    const a = new MockReviewAdapter(variant, 10);
    await a.startReview(CASE_ID);
    await vi.runAllTimersAsync();
    return a;
  }
  it("has exactly 25 visible states with branches and cycles", () => {
    expect(steps).toHaveLength(25);
    expect(new Set(steps.map((s) => s.id)).size).toBe(25);
    expect(links.filter((l) => l.source === "read")).toHaveLength(4);
    expect(links).toContainEqual({
      source: "rejected",
      target: "read",
      label: "new revision",
    });
  });
  it("waits for all four independent checks before the join", async () => {
    const a = new MockReviewAdapter("amendment", 10);
    await a.startReview(CASE_ID);
    await vi.advanceTimersByTimeAsync(20);
    expect(a.snapshot.nodeStates.contract).toBe("complete");
    expect(a.snapshot.nodeStates.invoice).toBe("running");
    expect(a.snapshot.nodeStates.schema).toBe("queued");
    expect(a.snapshot.nodeStates.match).toBe("dormant");
    await vi.runAllTimersAsync();
    expect(a.snapshot.status).toBe("review");
  });
  it("proposes only $700 and exports balanced current-version lines after approval", async () => {
    const a = await ready();
    expect(a.snapshot.original).toBe("700000");
    expect(a.snapshot.proposal?.target).toBe("770000");
    expect(a.snapshot.proposal?.difference).toBe("70000");
    await expect(a.exportJournal(CASE_ID, 1)).rejects.toThrow("approval");
    await a.approve(CASE_ID, 1);
    const blob = await a.exportJournal(CASE_ID, 1);
    const csv = await blob.text();
    expect(csv).toContain(
      "2026-09-30,ACC-SEP-042-V1,6100,Contractor Expense,700.00,0.00,USD",
    );
    expect(csv).toContain("2100,Accrued Contractor Liabilities,0.00,700.00");
    expect(csv).not.toContain("7700.00");
    expect(a.snapshot.status).toBe("exported");
  });
  it("locks approval while a question is pending, then returns cited pending review", async () => {
    const a = await ready();
    const question = a.askQuestion(CASE_ID, 1, "Why $700?");
    expect(a.snapshot.pendingQuestion).toBe(true);
    await expect(a.approve(CASE_ID, 1)).rejects.toThrow("not available");
    await vi.runAllTimersAsync();
    await question;
    expect(a.snapshot.status).toBe("review");
    expect(a.snapshot.approvedVersion).toBe(null);
    expect(a.snapshot.answer).toContain("amendment page 1");
    expect(canExport(a.snapshot)).toBe(false);
  });
  it("retains rejection reason, revises inputs and demands fresh approval", async () => {
    const a = await ready("rejection-revision");
    await expect(a.reject(CASE_ID, 1, " ")).rejects.toThrow("reason");
    await a.reject(CASE_ID, 1, "Confirm the effective date");
    expect(a.snapshot.rejectionReason).toBe("Confirm the effective date");
    expect(canExport(a.snapshot)).toBe(false);
    a.revise();
    expect(a.snapshot.proposal?.version).toBe(1);
    expect(a.snapshot.inputRevision).toBe(2);
    await vi.runAllTimersAsync();
    expect(a.snapshot.proposal?.version).toBe(2);
    expect(a.snapshot.approvedVersion).toBe(null);
    expect(a.snapshot.rejectionReason).toBe("Confirm the effective date");
    await expect(a.approve(CASE_ID, 1)).rejects.toThrow("Version conflict");
    await a.approve(CASE_ID, 2);
    expect(await (await a.exportJournal(CASE_ID, 2)).text()).toContain(
      "ACC-SEP-042-V2",
    );
  });
  it("invalidates an existing approval immediately on material change", async () => {
    const a = await ready();
    await a.approve(CASE_ID, 1);
    expect(canExport(a.snapshot)).toBe(true);
    a.revise();
    expect(canExport(a.snapshot)).toBe(false);
    await expect(a.exportJournal(CASE_ID, 1)).rejects.toThrow();
    await vi.runAllTimersAsync();
    expect(a.snapshot.status).toBe("review");
    expect(canExport(a.snapshot)).toBe(false);
  });
  it.each([
    "no-change",
    "missing",
    "provider-failure",
    "invalid-source",
    "conflicting-authority",
    "invalid-period",
  ] as const)(
    "%s cannot produce an approved correction export",
    async (variant) => {
      const a = await ready(variant);
      expect(canExport(a.snapshot)).toBe(false);
      expect(a.snapshot.status).not.toBe("review");
      await expect(a.exportJournal(CASE_ID, 1)).rejects.toThrow();
      if (variant === "provider-failure") {
        expect(
          a.snapshot.events.filter(
            (e) => e.action === "Retrying mailbox search",
          ),
        ).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
      }
    },
  );
  it("reset cancels old playback and pending questions; subscribers can unsubscribe", async () => {
    const a = await ready();
    const listener = vi.fn();
    const unsubscribe = a.subscribeCase(CASE_ID, listener);
    const task = a.askQuestion(CASE_ID, 1, "Why?");
    const oldRun = a.snapshot.runId;
    a.reset("missing");
    unsubscribe();
    const count = listener.mock.calls.length;
    await a.startReview(CASE_ID);
    await vi.runAllTimersAsync();
    await task;
    expect(a.snapshot.runId).not.toBe(oldRun);
    expect(a.snapshot.answer).toBe(null);
    expect(
      a.snapshot.events.some((e) => e.action === "Question answered"),
    ).toBe(false);
    expect(listener).toHaveBeenCalledTimes(count);
    expect(a.snapshot.status).toBe("waiting");
  });
  it("pause freezes fixture pacing until resumed", async () => {
    const a = new MockReviewAdapter("amendment", 10);
    await a.startReview(CASE_ID);
    a.pause();
    const rev = a.snapshot.revision;
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.snapshot.revision).toBe(rev);
    a.pause();
    await vi.runAllTimersAsync();
    expect(a.snapshot.status).toBe("review");
  });
  it("escapes CSV, guards formula injection and copies valid TSV rows", () => {
    const lines = proposal().lines;
    lines[0].description = '=HYPERLINK("untrusted")';
    lines[0].accountName = 'Contractor, "Expense"';
    const csv = journalText(lines);
    expect(csv).toContain('"Contractor, ""Expense"""');
    expect(csv).toContain("\"'=HYPERLINK");
    const tsv = journalText(lines, "\t");
    expect(tsv.split("\r\n")[1].split("\t")).toHaveLength(8);
    expect(tsv).toContain("700.00\t0.00");
    expect(money("900719925474099101")).toBe("$9,007,199,254,740,991.01");
  });
  it("rejects unbalanced, invalid and stale proposals at the export boundary", async () => {
    const a = await ready();
    await a.approve(CASE_ID, 1);
    a.snapshot.proposal!.lines[0].debit = "70001";
    expect(canExport(a.snapshot)).toBe(false);
    await expect(a.exportJournal(CASE_ID, 1)).rejects.toThrow();
  });
  it("deduplicates authoritative events and ignores stale revisions", async () => {
    const a = await ready();
    const s = structuredClone(a.snapshot);
    const current = acceptSnapshot(null, {
      ...s,
      events: [...s.events, s.events[0]],
    });
    expect(current.events.length).toBe(s.events.length);
    expect(acceptSnapshot(current, { ...s, revision: s.revision - 1 })).toBe(
      current,
    );
  });
});
