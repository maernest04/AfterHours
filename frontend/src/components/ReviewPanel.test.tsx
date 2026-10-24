// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { ReviewPanel } from "./ReviewPanel";
import { MockReviewAdapter } from "../data/mockReviewAdapter";
import { CASE_ID } from "../data/fixtures";
function Harness({ adapter }: { adapter: MockReviewAdapter }) {
  const [s, setS] = useState(adapter.snapshot);
  useEffect(() => adapter.subscribeCase(CASE_ID, setS), [adapter]);
  return <ReviewPanel snapshot={s} adapter={adapter} onEvidence={() => {}} />;
}
describe("review controls", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  async function setup() {
    const adapter = new MockReviewAdapter("amendment", 10);
    await adapter.startReview(CASE_ID);
    await vi.runAllTimersAsync();
    render(<Harness adapter={adapter} />);
    return adapter;
  }
  it("shows fixture amounts, locks export and approves only after the question response", async () => {
    const a = await setup();
    expect(screen.getByText("$7,000")).toBeTruthy();
    expect(screen.getByText("$7,700")).toBeTruthy();
    expect(screen.getByText("+$700")).toBeTruthy();
    expect(
      (screen.getByText("Download CSV") as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByText("Ask why"));
    fireEvent.click(screen.getByText("Simulate question email"));
    expect((screen.getByText("Approve") as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(() => vi.runAllTimersAsync());
    expect(screen.getByText("Answer · replayed investigation")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByText("Approve")));
    expect(a.snapshot.approvedVersion).toBe(1);
    expect(
      (screen.getByText("Download CSV") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  it("requires a rejection reason and retains it after acknowledgement", async () => {
    const a = await setup();
    fireEvent.click(screen.getByText("Reject"));
    expect(
      (screen.getByText("Simulate rejection email") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason for rejection"), {
      target: { value: "Please confirm the dates" },
    });
    await act(async () =>
      fireEvent.click(screen.getByText("Simulate rejection email")),
    );
    expect(screen.getByText("Please confirm the dates")).toBeTruthy();
    expect(a.snapshot.status).toBe("rejected");
    expect(
      (screen.getByText("Download CSV") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("offers manual TSV copy when clipboard permission fails", async () => {
    const a = await setup();
    await act(() => a.approve(CASE_ID, 1));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    await act(async () => fireEvent.click(screen.getByText("Copy table")));
    const fallback = screen.getByLabelText(
      "Manual spreadsheet copy",
    ) as HTMLTextAreaElement;
    expect(fallback.value).toContain("6100\tContractor Expense\t700.00\t0.00");
  });
});
