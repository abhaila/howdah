/**
 * The read-only picture, checked as GEOMETRY over every built-in graph (HOW-68 final pass).
 *
 * `graph-dag.test.tsx` pins the rules on small shapes. The operator's complaint was about the
 * big ones — implement-ticket's publish/review region, the bundle of wires above
 * implement-stacked's Finish row — and "looks neat" is not a thing a test can say, but its
 * failures are: two cards on each other, a caption on a card or on another caption, a wire
 * through a card that is not its own, and two unrelated wires sharing a line so that nobody can
 * tell which goes where. Those four are counted here for all of them, on the same `dagFlow` the
 * picture draws from.
 */
import { describe, expect, test } from "bun:test";
import { GRAPHS } from "../../graphs/index";
import { dagFlow, type GraphShapeDto } from "./graph-dag";
import { dagLayout, wirePath } from "./lib/dag-layout";

type P = { x: number; y: number };
type B = { x: number; y: number; width: number; height: number };

/** points along an SVG path made of M, L, Q and C commands */
function samplePath(d: string): P[] {
  const out: P[] = [];
  const re = /([MLCQ])([^MLCQ]*)/g;
  let cur: P = { x: 0, y: 0 };
  for (let m = re.exec(d); m; m = re.exec(d)) {
    const n = (m[2] ?? "").trim().split(/[ ,]+/).filter(Boolean).map(Number);
    const at = (i: number) => n[i] ?? 0;
    if (m[1] === "M") { cur = { x: at(0), y: at(1) }; out.push(cur); continue; }
    const pts: P[] = [];
    for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: at(i), y: at(i + 1) });
    const to = pts.at(-1);
    if (!to) continue;
    const steps = m[1] === "L" ? Math.max(2, Math.ceil(Math.hypot(to.x - cur.x, to.y - cur.y) / 6)) : 12;
    for (let i = 1; i <= steps; i++) {
      const u = i / steps, v = 1 - u;
      if (m[1] === "L") out.push({ x: cur.x + (to.x - cur.x) * u, y: cur.y + (to.y - cur.y) * u });
      else if (m[1] === "Q") out.push({ x: v * v * cur.x + 2 * v * u * pts[0]!.x + u * u * to.x, y: v * v * cur.y + 2 * v * u * pts[0]!.y + u * u * to.y });
      else out.push({ x: v * v * v * cur.x + 3 * v * v * u * pts[0]!.x + 3 * v * u * u * pts[1]!.x + u * u * u * to.x, y: v * v * v * cur.y + 3 * v * v * u * pts[0]!.y + 3 * v * u * u * pts[1]!.y + u * u * u * to.y });
    }
    cur = to;
  }
  return out;
}
const inside = (p: P, b: B, pad: number) => p.x > b.x + pad && p.x < b.x + b.width - pad && p.y > b.y + pad && p.y < b.y + b.height - pad;
const hit = (a: B, b: B) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

function problems(shape: GraphShapeDto): string[] {
  const { cards, wires } = dagFlow(shape);
  const found: string[] = [];
  const caption = (w: (typeof wires)[number]): B | null => (w.caption ? { x: w.caption.x - w.caption.width / 2, y: w.caption.y - 11, width: w.caption.width, height: 22 } : null);
  cards.forEach((a, i) => cards.slice(i + 1).forEach((b) => { if (hit(a.box, b.box)) found.push(`cards overlap: ${a.node.id} / ${b.node.id}`); }));
  for (const w of wires) {
    const c = caption(w);
    if (c) for (const k of cards) if (hit(c, k.box)) found.push(`caption on a card: "${w.caption!.text}" on ${k.node.id}`);
  }
  wires.forEach((a, i) => wires.slice(i + 1).forEach((b) => {
    const ca = caption(a), cb = caption(b);
    if (ca && cb && hit(ca, cb)) found.push(`captions overlap: "${a.caption!.text}" / "${b.caption!.text}"`);
  }));
  const sampled = wires.map((w) => samplePath(w.path));
  wires.forEach((w, i) => {
    for (const k of cards) {
      if (k.node.id === w.from || k.node.id === w.to) continue;
      if (sampled[i]!.some((p) => inside(p, k.box, -3))) found.push(`wire through a card: ${w.from} → ${w.to} through ${k.node.id}`);
    }
  });
  // an ambiguous merge: two wires with different sources AND different targets within 3px of
  // each other for 30px or more (a fan out of one card, or into one, shares its trunk on purpose)
  wires.forEach((a, i) => wires.forEach((b, j) => {
    if (j <= i || a.from === b.from || a.to === b.to) return;
    let run = 0, best = 0, last: P | null = null;
    for (const p of sampled[i]!) {
      const near = sampled[j]!.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 3);
      run = near && last ? run + Math.hypot(p.x - last.x, p.y - last.y) : 0;
      best = Math.max(best, run);
      last = p;
    }
    if (best >= 30) found.push(`two wires share ${Math.round(best)}px: ${a.from} → ${a.to} with ${b.from} → ${b.to}`);
  }));
  return found;
}

/** the shape the server sends for a registered graph (web/server.ts), as far as the layout reads it */
function shapeOf(name: string): GraphShapeDto {
  const g = GRAPHS[name]!;
  return {
    name, description: "", entry: g.def.entry,
    nodes: Object.entries(g.def.nodes).map(([id, n]) => ({
      id, kind: n.kind,
      ...(n.kind === "command" ? { run: n.run } : {}),
      ...(n.kind === "terminal" ? { outcome: n.outcome } : {}),
      ...(n.kind === "wait" ? { duration: n.duration } : {}),
      ...(n.kind === "parallel" ? { branches: [...n.branches], join: n.join } : {}),
    })),
    edges: g.flowEdges().map((e) => ({ from: e.from, to: e.to, label: e.edge?.condition?.label, ...(e.kind ? { kind: e.kind } : {}) })),
  };
}

describe("every built-in graph is laid out with nothing on anything else", () => {
  const names = Object.keys(GRAPHS);
  test("the registry is the ten built-ins (so this covers them)", () => {
    expect(names.length).toBeGreaterThanOrEqual(10);
  });
  for (const name of names) {
    test(name, () => {
      expect(problems(shapeOf(name))).toEqual([]);
    });
  }
});

describe("lanes: every sideways run in a gap has its own height", () => {
  const card = (id: string) => ({ id, width: 200, height: 50 });
  // one step fanning out to five, all of which lead to one — two busy gaps
  const nodes = ["a", "b1", "b2", "b3", "b4", "b5", "z"].map(card);
  const edges = [...["b1", "b2", "b3", "b4", "b5"].flatMap((b) => [{ from: "a", to: b }, { from: b, to: "z" }])];

  test("no two bends in one gap share a lane, and a crowded gap is opened rather than shared", () => {
    const laid = dagLayout("a", nodes, edges);
    const lanes = laid.edges.flatMap((e) => e?.lanes ?? []);
    expect(lanes.length).toBeGreaterThanOrEqual(8); // four of the five bend, twice
    expect(new Set(lanes.map((y) => Math.round(y * 10))).size).toBe(lanes.length);
    const sorted = [...lanes].sort((p, q) => p - q);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(9.9);
    // the cards moved down with the gap: nothing overlaps and the layout's height covers them
    const boxes = [...laid.nodes.values()];
    for (const b of boxes) expect(b.y + b.height).toBeLessThanOrEqual(laid.height);
    boxes.forEach((p, i) => boxes.slice(i + 1).forEach((q) => expect(hit(p, q)).toBe(false)));
  });

  test("a wire still starts on its source's edge and ends on its target's after a gap opens", () => {
    const laid = dagLayout("a", nodes, edges);
    edges.forEach((e, i) => {
      const w = laid.edges[i]!;
      const from = laid.nodes.get(e.from)!, to = laid.nodes.get(e.to)!;
      expect(Math.abs(w.points[0]!.y - (from.y + from.height))).toBeLessThanOrEqual(1);
      expect(Math.abs(w.points.at(-1)!.y - to.y)).toBeLessThanOrEqual(1);
    });
  });

  test("a bend is drawn square with rounded corners at its lane; a 2px jog is a straight line", () => {
    const d = wirePath({ points: [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 100, y: 50 }, { x: 100, y: 60 }], self: false, back: false, lanes: [30] });
    expect(d).toBe("M0,0L0,10L0,22Q0,30 8,30L92,30Q100,30 100,38L100,50L100,60");
    expect(wirePath({ points: [{ x: 0, y: 0 }, { x: 2, y: 40 }], self: false, back: false })).toBe("M0,0L2,40");
    // with no lane given, the middle of the gap
    expect(wirePath({ points: [{ x: 0, y: 0 }, { x: 50, y: 40 }], self: false, back: false })).toContain("Q0,20 8,20");
  });
});
