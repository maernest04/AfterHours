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
import { steps, links, edgeId } from "./data/topology";
import { routeAll } from "./data/layout";
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
  it("collapses sidebar and activity independently without losing their state", async () => {
    const adapter = new MockReviewAdapter("amendment", 10);
    const { container } = render(<App providedAdapter={adapter} />);
    fireEvent.click(screen.getByRole("tab", { name: "Proposed correction" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.queryByRole("tab", { name: "Proposed correction" })).toBe(null);
    expect(screen.getByRole("button", { name: "Expand sidebar" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Collapse activity" }));
    expect(container.querySelector<HTMLElement>("#activity-content")?.hidden).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Start review/ }));
    await act(async () => { await vi.runAllTimersAsync(); });
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByRole("tab", { name: /^Proposed correction/ }).getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector<HTMLElement>("#activity-content")?.hidden).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
    expect(container.querySelector<HTMLElement>("#activity-content")?.hidden).toBe(false);
    expect(container.querySelectorAll(".activity-list li")).toHaveLength(adapter.snapshot.events.length);
    expect(adapter.snapshot.events.length).toBeGreaterThan(0);
  });
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
  it("starts with four stages and keeps details closed during live progress", async () => {
    const a = new MockReviewAdapter("amendment", 10);
    const { container } = render(<App providedAdapter={a} />);
    for (const name of ["Normalize", "Match", "Investigate", "Recalculate"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${name}, dormant`) })).toBeTruthy();
    }
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "Read the evidence, dormant" })).toBe(null);
    fireEvent.click(screen.getByLabelText("Follow active step"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Start review/ })); });
    expect(screen.getByRole("button", { name: /^Normalize, running/ })).toBeTruthy();
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(screen.getByRole("button", { name: /^Normalize, complete/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Investigate, complete/ })).toBeTruthy();
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(4);
    expect(screen.queryByRole("complementary", { name: "Step inspector" })).toBe(null);
  });
  it("opens a stage's connected workflow and returns to the overview", async () => {
    const { container } = render(<App providedAdapter={new MockReviewAdapter()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Normalize, dormant/ }));
    expect(screen.getByRole("button", { name: "Read the evidence, dormant" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invoice coverage, dormant" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect the records, dormant" })).toBe(null);
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(9);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(container.querySelectorAll(".react-flow__edge-path")).toHaveLength(12);
    expect(container.querySelector('[data-testid="rf__edge-schema:match"]')).toBe(null);
    fireEvent.click(screen.getByRole("button", { name: "Back to stages" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(4);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Normalize, dormant/ }));
    fireEvent.keyDown(screen.getByRole("button", { name: /^Match, dormant/ }), { key: "Enter" });
    expect(screen.getByRole("button", { name: "Connect the records, dormant" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Invoice coverage, dormant" })).toBe(null);
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(container.querySelectorAll(".react-flow__edge-path")).toHaveLength(2);
    expect(screen.getByText("no difference")).toBeTruthy();
  });
  it("moves between adjacent stage flowcharts with previous and next controls", async () => {
    render(<App providedAdapter={new MockReviewAdapter()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Normalize, dormant/ }));
    expect((screen.getByRole("button", { name: "Previous stage" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Invoice coverage, dormant" }));
    fireEvent.click(screen.getByRole("button", { name: "Next stage: Match" }));
    expect(screen.getByRole("button", { name: "Connect the records, dormant" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Step inspector" })).toBe(null);
    fireEvent.click(screen.getByRole("button", { name: "Next stage: Investigate" }));
    expect(screen.getByRole("button", { name: "Search the mailbox, dormant" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next stage: Recalculate" }));
    expect((screen.getByRole("button", { name: "Next stage" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Previous stage: Investigate" }));
    expect(screen.getByRole("button", { name: "Search the mailbox, dormant" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to stages" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Investigate, dormant/ }));
  });
  it("follows execution across stages after opening a main card", async () => {
    const adapter = new MockReviewAdapter("amendment", 10);
    render(<App providedAdapter={adapter} />);
    fireEvent.click(screen.getByRole("button", { name: /^Normalize, dormant/ }));
    expect((screen.getByLabelText("Follow active step") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Start review/ }));
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(screen.getByRole("button", { name: "Your decision, waiting" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Read the evidence, complete" })).toBe(null);
  });
  it.each(["navigate", "zoom", "pane", "select", "back"])("stops following when the user chooses to %s", async action => {
    const adapter = new MockReviewAdapter("amendment", 10);
    const { container } = render(<App providedAdapter={adapter} />);
    fireEvent.click(screen.getByRole("button", { name: /^Normalize, dormant/ }));
    if (action === "navigate") fireEvent.click(screen.getByRole("button", { name: "Next stage: Match" }));
    if (action === "zoom") fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    if (action === "pane") fireEvent.click(container.querySelector(".react-flow__pane")!);
    if (action === "select") fireEvent.click(screen.getByRole("button", { name: "Invoice coverage, dormant" }));
    if (action === "back") fireEvent.click(screen.getByRole("button", { name: "Back to stages" }));
    expect((screen.getByLabelText("Follow active step") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Start review/ }));
    await act(async () => { await vi.runAllTimersAsync(); });
    if (action === "back") expect(screen.getByRole("button", { name: /^Recalculate,/ })).toBeTruthy();
    else expect(screen.getByRole("button", { name: action === "navigate" ? "Connect the records, complete" : "Read the evidence, complete" })).toBeTruthy();
  });
  it.each(["Normalize", "Match", "Investigate", "Recalculate"])("preserves the original %s layout and routed paths", async name => {
    const region = ["Normalize", "Match", "Investigate", "Recalculate"].indexOf(name);
    const { container } = render(<App providedAdapter={new MockReviewAdapter()} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}, dormant`) }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    const members = steps.filter(step => step.region === region);
    const ids = new Set(members.map(step => step.id));
    for (const step of members) {
      const node = container.querySelector<HTMLElement>(`[data-testid="rf__node-${step.id}"]`)!;
      expect(node.style.transform).toBe(`translate(${step.x}px,${step.y}px)`);
    }
    const routes = routeAll(steps, links.filter(link => ids.has(link.source) && ids.has(link.target)));
    expect(container.querySelectorAll(".react-flow__edge-path")).toHaveLength(routes.length);
    for (const route of routes) {
      const edge = container.querySelector(`[data-testid="rf__edge-${edgeId(route.link.source, route.link.target)}"] .react-flow__edge-path`);
      expect(edge?.getAttribute("d")).toBe(route.path);
      if (route.link.label) expect(screen.getByText(route.link.label)).toBeTruthy();
    }
  });
  it("selects steps without an inspector and keeps evidence available through Activity", async () => {
    const a = new MockReviewAdapter("amendment", 10);
    render(<App providedAdapter={a} />);
    fireEvent.click(screen.getByRole("button", { name: /^Normalize, dormant/ }));
    const invoice = screen.getByRole("button", {
      name: "Invoice coverage, dormant",
    });
    fireEvent.keyDown(invoice, { key: "Enter" });
    expect(screen.queryByRole("complementary", { name: "Step inspector" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Toggle step inspector" })).toBe(null);
    fireEvent.click(screen.getByRole("button", { name: /Start review/ }));
    await act(async () => { await vi.runAllTimersAsync(); });
    await act(async () =>
      fireEvent.click(screen.getAllByRole("button", { name: "invoice" })[0]),
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
    fireEvent.click(screen.getByRole("button", { name: /^Investigate, dormant/ }));
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Evidence missing, dormant" }),
      { key: "Enter" },
    );
    fireEvent.click(screen.getByText("Start review"));
    await act(() => vi.runAllTimersAsync());
    expect(screen.getByRole("button", { name: "Evidence missing, dormant" }).classList.contains("selected")).toBe(true);
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
