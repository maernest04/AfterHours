// Deterministic layout + smooth edge routing for the review state machine.
// Top-to-bottom flowchart: the main path runs down the centre column (every arrow
// points down), branches sit in side columns, and loop-backs use side corridors.
// Positions are static, so every edge path is precomputed here and unit-tested: no
// edge may pass through a node it does not connect, and labels never collide.
import type { Link, Step } from "./topology";

export const NODE_W = 240;
export const NODE_H = 116;
export const COL = 310; // column pitch
export const X0 = 150;
export const ROW_H = 180; // row pitch leaves room for readable labels
export const BAND_GAP = 84; // extra space between stages for the stage header
export const TOP = 60;
export const SPINE = 1.5; // the main path is centred between columns 1 and 2
export const col = (k: number) => X0 + k * COL;
export const rowY = (band: number, row: number) => TOP + row * ROW_H + band * BAND_GAP;
export const at = (band: number, k: number, row: number) => ({ x: col(k), y: rowY(band, row) });
export const CORRIDOR = {
  left: X0 - 55,
  left2: X0 - 95,
  right: col(3) + NODE_W + 55,
} as const;

export type Side = "top" | "bottom" | "left" | "right";
export interface Point {
  x: number;
  y: number;
}
export interface Route {
  from?: Side;
  to?: Side;
  fromAt?: number; // 0..1 along the side (default 0.5)
  toAt?: number;
  /** Orthogonal waypoints between the two anchors; corners are rounded. */
  via?: Point[];
  labelAt?: number; // 0..1 along the path for the label (default 0.5)
}
export interface RoutedEdge {
  path: string;
  label: Point;
  samples: Point[];
  points: Point[]; // polyline vertices (empty for curves)
}

const R = 26; // corner radius

export function anchor(s: Step, side: Side, at = 0.5): Point {
  switch (side) {
    case "top":
      return { x: s.x + NODE_W * at, y: s.y };
    case "bottom":
      return { x: s.x + NODE_W * at, y: s.y + NODE_H };
    case "left":
      return { x: s.x, y: s.y + NODE_H * at };
    case "right":
      return { x: s.x + NODE_W, y: s.y + NODE_H * at };
  }
}

const normal: Record<Side, Point> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

function defaultSides(a: Step, b: Step): [Side, Side] {
  if (b.y >= a.y + NODE_H) return ["bottom", "top"]; // flow runs downward
  if (b.y + NODE_H <= a.y) return ["top", "bottom"];
  return b.x > a.x ? ["right", "left"] : ["left", "right"];
}

const cubic = (p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point => {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
};

function polyline(points: Point[], labelAt: number): Omit<RoutedEdge, "points"> & { dir: Point } {
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [p, c, n] = [points[i - 1], points[i], points[i + 1]];
    const lin = Math.hypot(c.x - p.x, c.y - p.y);
    const lout = Math.hypot(n.x - c.x, n.y - c.y);
    const r = Math.min(R, lin / 2, lout / 2);
    const a = { x: c.x - ((c.x - p.x) / lin) * r, y: c.y - ((c.y - p.y) / lin) * r };
    const b = { x: c.x + ((n.x - c.x) / lout) * r, y: c.y + ((n.y - c.y) / lout) * r };
    path += ` L ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`;
  }
  const last = points[points.length - 1];
  path += ` L ${last.x} ${last.y}`;
  const lengths = points.slice(1).map((q, i) => Math.hypot(q.x - points[i].x, q.y - points[i].y));
  const total = lengths.reduce((a, b) => a + b, 0);
  const samples: Point[] = [];
  points.slice(1).forEach((q, i) => {
    const p = points[i];
    const n = Math.max(2, Math.ceil(lengths[i] / 8));
    for (let j = 0; j <= n; j++) samples.push({ x: p.x + ((q.x - p.x) * j) / n, y: p.y + ((q.y - p.y) * j) / n });
  });
  let want = total * labelAt;
  let label = points[0];
  let dir = { x: points[1].x - points[0].x, y: points[1].y - points[0].y };
  for (let i = 0; i < lengths.length; i++) {
    if (want <= lengths[i]) {
      const p = points[i], q = points[i + 1], f = lengths[i] ? want / lengths[i] : 0;
      label = { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f };
      dir = { x: q.x - p.x, y: q.y - p.y };
      break;
    }
    want -= lengths[i];
  }
  return { path, label, samples, dir };
}

/** Approximate rendered width of an edge label pill. */
export const labelWidth = (text: string) => text.length * 6.2 + 14;
export const LABEL_H = 18;

/** Put the label beside its line (right of vertical runs, above horizontal ones) so no arrow covers it. */
function besideLine(at: Point, dir: Point, text?: string): Point {
  if (!text) return at;
  return Math.abs(dir.y) > Math.abs(dir.x)
    ? { x: at.x + labelWidth(text) / 2 + 7, y: at.y }
    : { x: at.x, y: at.y - LABEL_H / 2 - 6 };
}

/** Smooth path between two steps: a cubic bezier, or a rounded orthogonal route through waypoints. */
export function routeEdge(a: Step, b: Step, route: Route = {}, text?: string): RoutedEdge {
  const [df, dt] = defaultSides(a, b);
  const from = route.from ?? df;
  const to = route.to ?? dt;
  const s = anchor(a, from, route.fromAt);
  const t = anchor(b, to, route.toAt);

  if (route.via) {
    const points = [s, ...route.via, t];
    const { dir, label, ...rest } = polyline(points, route.labelAt ?? 0.5);
    return { ...rest, label: besideLine(label, dir, text), points };
  }

  const dist = Math.hypot(t.x - s.x, t.y - s.y);
  const d = Math.max(36, Math.min(140, dist * 0.45));
  const c1 = { x: s.x + normal[from].x * d, y: s.y + normal[from].y * d };
  const c2 = { x: t.x + normal[to].x * d, y: t.y + normal[to].y * d };
  const path = `M ${s.x} ${s.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${t.x} ${t.y}`;
  const samples = Array.from({ length: 81 }, (_, i) => cubic(s, c1, c2, t, i / 80));
  const f = route.labelAt ?? 0.5;
  const p0 = cubic(s, c1, c2, t, Math.max(0, f - 0.02));
  const p1 = cubic(s, c1, c2, t, Math.min(1, f + 0.02));
  const label = besideLine(cubic(s, c1, c2, t, f), { x: p1.x - p0.x, y: p1.y - p0.y }, text);
  return { path, label, samples, points: [] };
}

export function routeAll(steps: Step[], links: Link[]) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  return links.map((l) => ({
    link: l,
    ...routeEdge(byId.get(l.source)!, byId.get(l.target)!, l.route, l.label),
  }));
}
