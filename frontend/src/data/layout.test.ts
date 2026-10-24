import { describe, expect, it } from "vitest";
import { LABEL_H, labelWidth, NODE_H, NODE_W, routeAll } from "./layout";
import { links, steps } from "./topology";

const PAD = 6;
const inside = (p: { x: number; y: number }, s: { x: number; y: number }, pad = PAD) =>
  p.x > s.x - pad && p.x < s.x + NODE_W + pad && p.y > s.y - pad && p.y < s.y + NODE_H + pad;

describe("state machine layout", () => {
  const routed = routeAll(steps, links);

  it("never overlaps nodes", () => {
    for (const a of steps)
      for (const b of steps)
        if (a !== b)
          expect(
            a.x + NODE_W + 20 <= b.x || b.x + NODE_W + 20 <= a.x || a.y + NODE_H + 20 <= b.y || b.y + NODE_H + 20 <= a.y,
            `${a.id} overlaps ${b.id}`,
          ).toBe(true);
  });

  it("routes every edge around nodes it does not connect", () => {
    for (const r of routed) {
      const others = steps.filter((s) => s.id !== r.link.source && s.id !== r.link.target);
      for (const p of r.samples)
        for (const s of others)
          expect(inside(p, s), `${r.link.source}->${r.link.target} crosses ${s.id} at ${Math.round(p.x)},${Math.round(p.y)}`).toBe(false);
    }
  });

  it("keeps edge labels off every node", () => {
    for (const r of routed.filter((r) => r.link.label)) {
      const half = labelWidth(r.link.label!) / 2;
      for (const s of steps)
        for (const dx of [-half, 0, half])
          for (const dy of [-9, 0, 9])
            expect(inside({ x: r.label.x + dx, y: r.label.y + dy }, s, 2), `label "${r.link.label}" sits on ${s.id}`).toBe(false);
    }
  });

  it("keeps every edge (including its own) clear of every label", () => {
    for (const r of routed.filter((r) => r.link.label)) {
      const w = labelWidth(r.link.label!) + 6;
      const h = LABEL_H + 6;
      for (const other of routed) {
        for (const p of other.samples)
          expect(
            Math.abs(p.x - r.label.x) * 2 < w && Math.abs(p.y - r.label.y) * 2 < h,
            `${other.link.source}->${other.link.target} runs under label "${r.link.label}" (${r.link.source}->${r.link.target})`,
          ).toBe(false);
      }
    }
  });

  it("keeps labels from overlapping each other", () => {
    const boxes = routed
      .filter((r) => r.link.label)
      .map((r) => ({ id: r.link.label!, x: r.label.x, y: r.label.y, w: labelWidth(r.link.label!), h: LABEL_H }));
    for (const a of boxes)
      for (const b of boxes)
        if (a !== b)
          expect(Math.abs(a.x - b.x) * 2 >= a.w + b.w || Math.abs(a.y - b.y) * 2 >= a.h + b.h, `labels "${a.id}" and "${b.id}" overlap`).toBe(true);
  });
});
