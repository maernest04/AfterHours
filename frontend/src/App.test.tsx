// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import App from "./App";
import { MockReviewAdapter } from "./data/mockReviewAdapter";
class ResizeObserverMock {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [
        {
          target,
          contentRect: target.getBoundingClientRect(),
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 100, height: 20 }),
  });
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      m11 = 1;
      m22 = 1;
    },
  );
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 195;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return 79;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 1200;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return 565;
    },
  });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("workspace interactions", () => {
  it("keeps pipeline and correction in sidebar tabs without covering the graph", () => {
    const { container } = render(<App providedAdapter={new MockReviewAdapter()} />);
    const pipeline = screen.getByRole("tab", { name: "Live pipeline" });
    const correction = screen.getByRole("tab", { name: "Proposed correction" });
    expect(pipeline.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".graph-body .live-progress")).toBe(null);
    expect(container.querySelector(".workspace-sidebar .live-progress")).toBeTruthy();
    fireEvent.click(correction);
    expect(screen.getByRole("tabpanel", { name: "Proposed correction" })).toBeTruthy();
    expect(screen.queryByRole("tabpanel", { name: "Live pipeline" })).toBe(null);
    fireEvent.keyDown(correction, { key: "ArrowLeft" });
    expect(screen.getByRole("tabpanel", { name: "Live pipeline" })).toBeTruthy();
    expect(document.activeElement).toBe(pipeline);
  });
  it("lights a box only after the travelling dot reaches it", async () => {
    const a = new MockReviewAdapter("amendment", 1000);
    render(<App providedAdapter={a} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Start review/ }));
    });
    expect(a.snapshot.nodeStates.read).toBe("running");
    expect(screen.getByRole("button", { name: "Read the evidence, dormant" })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(screen.getByRole("button", { name: "Read the evidence, running" })).toBeTruthy();
  });
  it("marks traversed edges as done once the run passes them", async () => {
    const a = new MockReviewAdapter("amendment", 10);
    const { container } = render(<App providedAdapter={a} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Start review/ }));
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    const done = [
      ...container.querySelectorAll<SVGPathElement>(".react-flow__edge-path"),
    ].filter((p) => p.style.strokeDasharray === "");
    expect(done.length).toBeGreaterThan(10);
  });
  it("renders all 25 branch states, inspects dormant evidence and closes with Escape", async () => {
    const a = new MockReviewAdapter("amendment", 10);
    render(<App providedAdapter={a} />);
    expect(screen.getAllByRole("button", { name: /, dormant$/ })).toHaveLength(
      25,
    );
    const invoice = screen.getByRole("button", {
      name: "Invoice coverage, dormant",
    });
    fireEvent.keyDown(invoice, { key: "Enter" });
    expect(
      screen.getByRole("complementary", { name: "Step inspector" }),
    ).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByText("Received invoice · unposted")),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/Posting status: UNPOSTED/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBe(null);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Step inspector" })).toBe(null);
  });
  it("preserves selection during updates when follow is off and supports expand/reset/overview", async () => {
    const a = new MockReviewAdapter("amendment", 10);
    render(<App providedAdapter={a} />);
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Evidence missing, dormant" }),
      { key: "Enter" },
    );
    fireEvent.click(screen.getByText("Start review"));
    await act(() => vi.runAllTimersAsync());
    expect(
      screen.getByRole("heading", { name: "Evidence missing" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Expand graph"));
    expect(screen.getByLabelText("Collapse graph")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByLabelText("Expand graph")).toBeTruthy();
    fireEvent.click(screen.getByText("Overview"));
    expect(screen.getByText("Open review")).toBeTruthy();
    fireEvent.click(screen.getByText("Open review"));
    fireEvent.click(screen.getByText("Reset"));
    expect(a.snapshot.status).toBe("ready");
    expect(a.snapshot.events).toHaveLength(0);
  });
});
