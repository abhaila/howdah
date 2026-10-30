/**
 * HOW-78: the run report — ONE self-contained HTML file an engineer opens to see what a run
 * changed, how it works and how it got there, and can hand to someone else.
 *
 * THE PAGE IS THE CHANGE, NOT THE RUN. The first version led with run bookkeeping and drew the
 * change as a static strip of boxes; the operator's verdict was that it had "none of the flow, and
 * how it is built". So the page is now laid out as a system map of the change:
 *
 *   - a header strip (repository / PR, ticket, diff, tests, criteria) with Play flow, Trace one
 *     step and Reset view;
 *   - left: the change in a few sentences, the numbered request path through it, the supporting
 *     systems it relies on, and the legend;
 *   - centre: the topology — one lane per service or layer on a drawn platform, a box per
 *     component coloured new / changed / reused / external, and a token that travels the request
 *     path one hop at a time;
 *   - right: the selected component, in two tabs — WHAT IT DOES (responsibility, its part in the
 *     flow) and HOW IT'S BUILT (where and how it changed, file by file) — and the active trace;
 *   - beneath, as supporting material: a worked example, and "how the run got here" — the run's
 *     own history, folded so a poll is one row, not eighteen;
 *   - last and collapsed: the evidence (criteria, tests, screens, review) and the plan.
 *
 * Why Howdah renders it rather than the agent. A codex or cursor turn has no artifact channel, and
 * a page an agent hand-writes is HTML nobody validated. So the AGENT contributes the one thing only
 * it can know — what the change IS — as data, the `change_map` output of `implementation.report`
 * (prompts/implementation.report.md); everything else is a FACT the log already holds. Nothing is
 * stored: web/report.ts gathers the model, `GET /api/runs/:id/report` and `howdah report` render it.
 *
 * Node-free and dependency-free: the page must open from a file:// URL or an email attachment, so
 * it links nothing — its CSS, its one script and its screenshots (as data: URIs) are inside it. It
 * carries its own palette for the same reason; it cannot reach tokens.css. Every status is a WORD
 * as well as a colour. Without script the map, the first component's panel and every section
 * still read.
 *
 * `change_map` is untrusted model output: `asChangeMap` returns null rather than throwing, drops
 * malformed rows, and a link or flow step naming a component that does not exist is skipped,
 * never drawn. Every string reaches the page through `esc`, and the data the script reads is
 * embedded as JSON with `<` escaped, so no value can close the script element.
 */

export const CHANGE_MAP_KEY = "change_map";

export const COMPONENT_STATUSES = ["new", "changed", "reused", "external"] as const;
export type ComponentStatus = (typeof COMPONENT_STATUSES)[number];

export interface ChangeComponent {
  id: string;
  label: string;
  /** a short tag drawn on the box, e.g. "API" */
  tag?: string;
  /** the lane the box sits in — a service, module or layer */
  group?: string;
  status: ComponentStatus;
  /** what kind of thing it is, under its name: "INVOICE UPDATE webhook", "Durable Object + SQLite" */
  kind?: string;
  /** WHAT IT DOES: its responsibility, in one to three sentences */
  what?: string;
  /** WHAT IT DOES: its part in the request path */
  in_flow?: string;
  /** HOW IT'S BUILT: where and how it changed — file paths and the specific change */
  how?: string[];
}

export interface ChangeLink {
  from: string;
  to: string;
  label?: string;
  /** an indirect or asynchronous dependency */
  dashed?: boolean;
}

export interface ChangeExample {
  title: string;
  body?: string;
  /** the inputs, in order, e.g. "Xero: 300.00 applied to invoice A" */
  steps: string[];
  /** what the system does with them */
  outcome?: { label?: string; body: string };
}

export interface ChangeMap {
  title: string;
  summary: string;
  /** what one pass along `flow` is called: "One invoice update" */
  flow_name?: string;
  components: ChangeComponent[];
  links: ChangeLink[];
  /** the path one request or event takes through the change, in order */
  flow: Array<{ component?: string; text: string }>;
  /** what a reviewer should look hardest at */
  risks: string[];
  example?: ChangeExample;
  diff?: { files?: number; additions?: number; deletions?: number };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s): s is string => s !== undefined) : []);
const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);

/** The change map a context value holds, or null when it is not one at all. */
export function asChangeMap(v: unknown): ChangeMap | null {
  let raw = v;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!isObj(raw)) return null;
  const components: ChangeComponent[] = [];
  const seen = new Set<string>();
  for (const c of Array.isArray(raw.components) ? raw.components : []) {
    if (!isObj(c)) continue;
    const id = str(c.id);
    const label = str(c.label) ?? id;
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    const status = (COMPONENT_STATUSES as readonly string[]).includes(c.status as string) ? (c.status as ComponentStatus) : "changed";
    const opt = (k: "tag" | "group" | "kind" | "what" | "in_flow") => { const s = str(c[k]); return s ? { [k]: s } : {}; };
    components.push({ id, label, status, ...opt("tag"), ...opt("group"), ...opt("kind"), ...opt("what"), ...opt("in_flow"), how: strs(c.how) });
  }
  const links: ChangeLink[] = [];
  for (const l of Array.isArray(raw.links) ? raw.links : []) {
    if (!isObj(l)) continue;
    const from = str(l.from);
    const to = str(l.to);
    // a link to a box that does not exist is skipped, never dereferenced
    if (!from || !to || !seen.has(from) || !seen.has(to) || from === to) continue;
    const label = str(l.label);
    links.push({ from, to, ...(label ? { label } : {}), ...(l.dashed === true ? { dashed: true } : {}) });
  }
  const flow: ChangeMap["flow"] = [];
  for (const f of Array.isArray(raw.flow) ? raw.flow : []) {
    const text = isObj(f) ? str(f.text) : str(f);
    if (!text) continue;
    const component = isObj(f) ? str(f.component) : undefined;
    flow.push({ text, ...(component && seen.has(component) ? { component } : {}) });
  }
  let example: ChangeExample | undefined;
  if (isObj(raw.example) && str(raw.example.title)) {
    const e = raw.example;
    const body = str(e.body);
    const outcome = isObj(e.outcome) && str(e.outcome.body)
      ? { body: str(e.outcome.body)!, ...(str(e.outcome.label) ? { label: str(e.outcome.label)! } : {}) }
      : undefined;
    example = { title: str(e.title)!, steps: strs(e.steps), ...(body ? { body } : {}), ...(outcome ? { outcome } : {}) };
  }
  let diff: ChangeMap["diff"];
  if (isObj(raw.diff)) {
    const files = count(raw.diff.files), additions = count(raw.diff.additions), deletions = count(raw.diff.deletions);
    if (files !== undefined || additions !== undefined || deletions !== undefined)
      diff = { ...(files !== undefined ? { files } : {}), ...(additions !== undefined ? { additions } : {}), ...(deletions !== undefined ? { deletions } : {}) };
  }
  const title = str(raw.title);
  const summary = str(raw.summary);
  if (!title && !summary && components.length === 0) return null;
  const flowName = str(raw.flow_name);
  return {
    title: title ?? "The change", summary: summary ?? "", components, links, flow, risks: strs(raw.risks),
    ...(flowName ? { flow_name: flowName } : {}), ...(example ? { example } : {}), ...(diff ? { diff } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// the model web/report.ts gathers from the log

export interface ReportCriterion {
  id: string;
  text: string;
  /** passes · fails · waived · superseded */
  state: "pass" | "fail" | "waived" | "superseded";
  /** how the evidence reads, in one line, or the waiver's reason */
  note?: string;
}

export interface ReportShot {
  path: string;
  /** a data: URI when it was small enough to embed, else null (the report says so) */
  src: string | null;
  console_errors: number;
}

export interface ReportStep {
  at: string;
  /** "Plan", "Implement · 19 min", "Your jump · implementation.plan" */
  title: string;
  detail?: string;
  kind: "step" | "failed" | "operator" | "finished";
}

export interface RunReportModel {
  run_id: string;
  name?: string;
  graph: string;
  status: string;
  /** the first line of the goal/ticket input */
  ticket?: string;
  work?: string;
  generated_at: string;
  change: ChangeMap | null;
  plan?: string;
  implementation_summary?: string;
  criteria: ReportCriterion[];
  tests: { outcome: string; command?: string; commit?: string | null; reason?: string; tail?: string } | null;
  screens: { outcome: string; reason?: string; shots: ReportShot[] } | null;
  review: { verdict?: string; findings?: unknown } | null;
  pull_requests: Array<{ url: string; state: string }>;
  steps: ReportStep[];
  usage?: { cost_usd: number | null; partial: boolean } | null;
}

// ---------------------------------------------------------------------------------------------
// rendering

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const STATUS_WORD: Record<ComponentStatus, string> = { new: "NEW", changed: "CHANGED", reused: "REUSED AS IS", external: "EXTERNAL" };
const LEGEND_WORD: Record<ComponentStatus, string> = { new: "NEW IN THIS CHANGE", changed: "CHANGED", reused: "REUSED AS IS", external: "EXTERNAL" };

/** box geometry for the map — one lane (column) per group, in first-appearance order */
const BOX_W = 176;
const BOX_H = 92;
/** the drawn depth of a box: its top and right faces */
const DEPTH = 14;
const GAP_X = 96;
const GAP_Y = 64;
const PAD = 56;
const LANE_HEAD = 40;

export interface PlacedBox { c: ChangeComponent; x: number; y: number }

/**
 * Layered placement: a lane per group, boxes stacked in the order the agent listed them (the
 * prompt asks for request order within a lane). Components the flow never visits sink to the
 * bottom of their lane, under the path — the example's "supporting" row.
 */
export function placeComponents(components: readonly ChangeComponent[], onPath: ReadonlySet<string> = new Set()): { boxes: PlacedBox[]; lanes: Array<{ name: string; x: number }>; width: number; height: number } {
  const order: string[] = [];
  const byLane = new Map<string, ChangeComponent[]>();
  for (const c of components) {
    const lane = c.group ?? "";
    if (!byLane.has(lane)) { byLane.set(lane, []); order.push(lane); }
    byLane.get(lane)!.push(c);
  }
  const boxes: PlacedBox[] = [];
  const lanes: Array<{ name: string; x: number }> = [];
  let tallest = 0;
  order.forEach((lane, li) => {
    const x = PAD + li * (BOX_W + GAP_X);
    lanes.push({ name: lane, x });
    const members = byLane.get(lane) ?? [];
    const sorted = onPath.size ? [...members.filter((c) => onPath.has(c.id)), ...members.filter((c) => !onPath.has(c.id))] : members;
    sorted.forEach((c, i) => boxes.push({ c, x, y: PAD + LANE_HEAD + DEPTH + i * (BOX_H + GAP_Y) }));
    tallest = Math.max(tallest, members.length);
  });
  const width = PAD * 2 + Math.max(1, order.length) * BOX_W + Math.max(0, order.length - 1) * GAP_X + DEPTH;
  const height = PAD * 2 + LANE_HEAD + DEPTH + Math.max(1, tallest) * BOX_H + Math.max(0, tallest - 1) * GAP_Y;
  return { boxes, lanes, width, height };
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** characters of the 15px mono label that fit inside a box */
const LABEL_CHARS = 17;

/** Word-wrap into at most `lines` lines of `width`; the last line is clipped with an ellipsis. */
export function wrap(s: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of s.split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  const kept = out.slice(0, lines).map((l) => clip(l, width));
  if (out.length > lines) kept[lines - 1] = clip(`${kept[lines - 1]} ${out.slice(lines).join(" ")}`, width);
  return kept;
}

/** a wire between two placed boxes, as an SVG path from `a` to `b` */
function wirePath(a: PlacedBox, b: PlacedBox): string {
  const ay = a.y + BOX_H / 2;
  const by = b.y + BOX_H / 2;
  if (a.x !== b.x) {
    const ax = a.x < b.x ? a.x + BOX_W : a.x;
    const bx = a.x < b.x ? b.x : b.x + BOX_W;
    return `M${ax},${ay} H${(ax + bx) / 2} V${by} H${bx}`;
  }
  // same lane: adjacent boxes join edge to edge; farther ones go round the left-hand side rather
  // than straight through the boxes between them (the right-hand side carries the depth faces)
  if (Math.abs(a.y - b.y) <= BOX_H + GAP_Y) {
    const down = a.y < b.y;
    return `M${a.x + BOX_W / 2},${a.y + (down ? BOX_H : 0)} V${b.y + (down ? 0 : BOX_H)}`;
  }
  return `M${a.x},${ay} h${-GAP_X / 3} V${by} H${b.x}`;
}

function mapSvg(map: ChangeMap): string {
  const onPath = new Set(map.flow.flatMap((f) => (f.component ? [f.component] : [])));
  const { boxes, lanes, width, height } = placeComponents(map.components, onPath);
  const at = new Map(boxes.map((b) => [b.c.id, b]));
  // the platform the lanes stand on: a gently skewed slab with a ruled grid, for depth
  const skew = 40;
  const slab = `M${PAD / 2},${PAD / 2 + skew} L${width / 2},${PAD / 4} L${width - PAD / 2},${PAD / 2 + skew} L${width - PAD / 2},${height - PAD / 2 - skew} L${width / 2},${height - PAD / 4} L${PAD / 2},${height - PAD / 2 - skew} Z`;
  const grid: string[] = [];
  for (let x = PAD / 2 + 32; x < width - PAD / 2; x += 32) grid.push(`M${x},${PAD / 4} V${height - PAD / 4}`);
  for (let y = PAD / 4 + 32; y < height - PAD / 4; y += 32) grid.push(`M${PAD / 2},${y} H${width - PAD / 2}`);
  const wires = map.links.map((l) => {
    const a = at.get(l.from);
    const b = at.get(l.to);
    if (!a || !b) return "";
    const title = `${l.from} → ${l.to}${l.label ? ` · ${l.label}` : ""}`;
    return `<path class="wire${l.dashed ? " dashed" : ""}" data-from="${esc(l.from)}" data-to="${esc(l.to)}" d="${wirePath(a, b)}"><title>${esc(title)}</title></path>`;
  }).join("");
  // the hops the token travels: along a wire when one joins the two steps, else straight across
  const hops: string[] = [];
  const steps = map.flow.flatMap((f) => (f.component ? [f.component] : []));
  for (let i = 1; i < steps.length; i++) {
    const a = at.get(steps[i - 1]!);
    const b = at.get(steps[i]!);
    if (!a || !b || a === b) { hops.push(`<path class="hop" data-hop="${i}" d="M0,0"/>`); continue; }
    const linked = map.links.some((l) => (l.from === a.c.id && l.to === b.c.id) || (l.from === b.c.id && l.to === a.c.id));
    const d = linked ? wirePath(a, b) : `M${a.x + BOX_W / 2},${a.y + BOX_H / 2} L${b.x + BOX_W / 2},${b.y + BOX_H / 2}`;
    hops.push(`<path class="hop" data-hop="${i}" d="${d}"/>`);
  }
  const laneHeads = lanes.filter((l) => l.name).map((l) => `<text class="lane" x="${l.x}" y="${PAD + 14}">${esc(clip(l.name.toUpperCase(), 30))}</text>`).join("");
  const nodes = boxes.map(({ c, x, y }) => {
    const top = `M0,0 L${DEPTH},${-DEPTH} L${BOX_W + DEPTH},${-DEPTH} L${BOX_W},0 Z`;
    const side = `M${BOX_W},0 L${BOX_W + DEPTH},${-DEPTH} L${BOX_W + DEPTH},${BOX_H - DEPTH} L${BOX_W},${BOX_H} Z`;
    return `
    <g class="box s-${c.status}${onPath.has(c.id) ? "" : " off-path"}" data-id="${esc(c.id)}" tabindex="0" role="button" aria-label="${esc(`${c.label} — ${STATUS_WORD[c.status]}`)}" transform="translate(${x},${y})">
      <path class="face top" d="${top}"/><path class="shade top" d="${top}"/>
      <path class="face side" d="${side}"/><path class="shade side" d="${side}"/>
      <rect class="face" width="${BOX_W}" height="${BOX_H}"/>
      <line x1="0" y1="26" x2="${BOX_W}" y2="26"/>
      <text class="tag" x="10" y="18">${esc(clip((c.tag ?? c.id).toUpperCase(), 16))}</text>
      <circle class="pip" cx="${BOX_W - 14}" cy="13" r="4"/>
      ${wrap(c.label, LABEL_CHARS, 2).map((line, i) => `<text class="label" x="10" y="${50 + i * 19}">${esc(line)}</text>`).join("")}
      ${c.status === "new" ? `<text class="badge" x="${BOX_W - 10}" y="${BOX_H - 9}" text-anchor="end">NEW</text>` : ""}
    </g>`;
  }).join("");
  return `<svg class="map" viewBox="0 0 ${width} ${height}" data-w="${width}" data-h="${height}" role="img" aria-label="${esc(`topology of the change: ${map.components.length} components`)}">
    <path class="slab" d="${slab}"/><path class="grid" d="${grid.join(" ")}"/>
    ${laneHeads}${wires}<g class="hops">${hops.join("")}</g>${nodes}
    <circle class="token" r="7" cx="-20" cy="-20"/>
  </svg>`;
}

function pre(text: string, cls = "doc"): string {
  return `<div class="${cls}">${esc(text)}</div>`;
}

const STATE_WORD: Record<ReportCriterion["state"], string> = { pass: "PASS", fail: "UNMET", waived: "WAIVED", superseded: "SUPERSEDED" };

function hhmm(iso: string, prevDay: string | null): { label: string; day: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { label: "", day: prevDay ?? "" };
  const day = String(d.getUTCDate()).padStart(2, "0");
  const t = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return { label: day !== prevDay ? `${day} · ${t}` : t, day };
}

function findingsText(f: unknown): string | null {
  if (f === undefined || f === null || f === "") return null;
  if (typeof f === "string") return f;
  if (Array.isArray(f) && f.length === 0) return null;
  return JSON.stringify(f, null, 2);
}

/** "SequenceHQ/sequence-web/pull/92" → "sequence-web / #92" */
export function prLabel(url: string): string {
  const m = url.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]} / #${m[2]}` : url.replace(/^https?:\/\//, "");
}

function diffLabel(d: ChangeMap["diff"]): string | null {
  if (!d) return null;
  const parts = [d.files !== undefined ? `${d.files} files` : null, d.additions !== undefined || d.deletions !== undefined ? `+${d.additions ?? 0} −${d.deletions ?? 0}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** the right-hand panel for one component: two tabs, rendered for every component, one shown */
function componentPanel(c: ChangeComponent, map: ChangeMap, shown: boolean): string {
  const steps = map.flow.map((f, i) => ({ ...f, n: i + 1 })).filter((f) => f.component === c.id);
  const inFlow = c.in_flow ?? (steps.length ? steps.map((s) => `Step ${s.n}: ${s.text}`).join(" ") : null);
  return `
  <section class="panel" data-panel="${esc(c.id)}"${shown ? "" : " hidden"}>
    <div class="eyebrow">Selected / ${esc((c.tag ?? c.id).toUpperCase())}</div>
    <h3>${esc(c.label)}</h3>
    ${c.kind ? `<div class="kind">${esc(c.kind)}</div>` : ""}
    <div class="status-row"><span class="eyebrow">Status</span><span class="st s-${c.status}"><i></i>${STATUS_WORD[c.status]}</span></div>
    <div class="tab-body" data-tab="does">
      <div class="eyebrow ruled">Responsibility</div>
      <p>${c.what ? esc(c.what) : '<span class="muted">Not described.</span>'}</p>
      <div class="eyebrow ruled">In the flow</div>
      <p>${inFlow ? esc(inFlow) : '<span class="muted">Not on the request path — the change relies on it.</span>'}</p>
    </div>
    <div class="tab-body" data-tab="built" hidden>
      <div class="eyebrow ruled">Where and how</div>
      ${c.how && c.how.length ? `<ul>${c.how.map((h) => `<li>${codeSpans(h)}</li>`).join("")}</ul>` : `<p class="muted">${c.status === "reused" || c.status === "external" ? "Unchanged by this change." : "Not described."}</p>`}
    </div>
  </section>`;
}

/** `backticked` spans become <code>; everything else is escaped text */
function codeSpans(s: string): string {
  return s.split(/(`[^`]+`)/).map((part) => (part.startsWith("`") && part.endsWith("`") && part.length > 2 ? `<code>${esc(part.slice(1, -1))}</code>` : esc(part))).join("");
}

export function renderRunReport(m: RunReportModel): string {
  const passed = m.criteria.filter((c) => c.state === "pass" || c.state === "waived").length;
  const live = m.criteria.filter((c) => c.state !== "superseded").length;
  const pr = m.pull_requests.at(-1);
  const map = m.change;
  const title = map?.title ?? m.name ?? m.ticket ?? m.run_id;
  const hasFlow = !!map && map.flow.some((f) => f.component);
  const head = [
    { k: pr ? "Pull request" : "Run", v: pr ? `${prLabel(pr.url)} · ${pr.state}` : `${m.graph} · ${m.run_id}`, href: pr?.url },
    { k: "Ticket", v: m.ticket ?? m.name ?? "—" },
    { k: "Diff", v: diffLabel(map?.diff) ?? "—" },
    { k: "Tests", v: m.tests ? `${m.tests.outcome}${m.tests.commit ? ` @ ${m.tests.commit.slice(0, 8)}` : ""}` : "not run" },
    { k: "Criteria", v: live ? `${passed}/${live} met` : "none written" },
  ];
  const controls = hasFlow
    ? `<div class="controls"><button type="button" data-act="play">▶ Play flow</button><button type="button" data-act="step">Trace one step</button><button type="button" data-act="reset">Reset view</button></div>`
    : "";
  const strip = `<header class="strip">${head.map((h) => `<div class="cell"><div class="eyebrow">${esc(h.k)}</div>${h.href ? `<a href="${esc(h.href)}">${esc(clip(h.v, 60))}</a>` : `<span>${esc(clip(h.v, 60))}</span>`}</div>`).join("")}${controls}</header>`;

  let stage: string;
  if (map && map.components.length) {
    const onPath = new Set(map.flow.flatMap((f) => (f.component ? [f.component] : [])));
    const byId = new Map(map.components.map((c) => [c.id, c]));
    const pathList = map.flow.map((f, i) => {
      const c = f.component ? byId.get(f.component) : undefined;
      return `<li data-step="${i}"${c ? ` data-for="${esc(c.id)}"` : ""}><span class="n">${i + 1}</span><span class="t">${esc(c ? c.label : f.text)}</span>${c ? `<span class="tg">${esc(clip((c.tag ?? c.id).toUpperCase(), 6))}</span>` : ""}</li>`;
    }).join("");
    const support = map.components.filter((c) => !onPath.has(c.id))
      .map((c) => `<li data-for="${esc(c.id)}"><span class="n">+</span><span class="t">${esc(c.label)}</span><span class="tg">${esc(clip((c.tag ?? c.id).toUpperCase(), 6))}</span></li>`).join("");
    const legend = COMPONENT_STATUSES.filter((s) => map.components.some((c) => c.status === s))
      .map((s) => `<li class="key s-${s}"><i></i>${LEGEND_WORD[s]}</li>`).join("");
    const first = map.flow.find((f) => f.component)?.component ?? map.components[0]!.id;
    const trace = map.flow.map((f, i) => `<li data-step="${i}"><span class="n">${i + 1}</span>${esc(f.text)}</li>`).join("");
    const flowName = map.flow_name ?? (hasFlow ? "The request path" : "");
    stage = `
    <div class="stage">
      <aside class="left">
        <div class="eyebrow">The change</div>
        <h1>${esc(map.title)}</h1>
        ${map.summary ? `<p class="lede">${esc(map.summary)}</p>` : ""}
        ${pathList ? `<div class="eyebrow">${esc(flowName)}</div><ol class="path">${pathList}</ol>` : ""}
        ${support ? `<div class="eyebrow">Supporting systems</div><ol class="path support">${support}</ol>` : ""}
        <ul class="legend">${legend}</ul>
      </aside>
      <div class="centre">
        <div class="topbar"><span class="eyebrow">Live topology${flowName ? ` / ${esc(flowName)}` : ""}</span><span class="state" data-state>${hasFlow ? "PAUSED" : ""}</span>
          <span class="zoom"><button type="button" data-act="in" aria-label="zoom in">+</button><button type="button" data-act="out" aria-label="zoom out">−</button></span></div>
        <div class="canvas">${mapSvg(map)}</div>
      </div>
      <aside class="right">
        <div class="tabs" role="tablist"><button type="button" role="tab" data-tab="does" aria-selected="true">What it does</button><button type="button" role="tab" data-tab="built" aria-selected="false">How it's built</button></div>
        ${map.components.map((c) => componentPanel(c, map, c.id === first)).join("")}
        ${trace ? `<div class="trace"><div class="eyebrow">Active trace</div><ol>${trace}</ol></div>` : ""}
        ${map.risks.length ? `<div class="risks"><div class="eyebrow">Look hardest at</div><ul>${map.risks.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>` : ""}
      </aside>
    </div>`;
  } else {
    stage = `
    <div class="stage empty">
      <aside class="left">
        <div class="eyebrow">The change</div>
        <h1>${esc(title)}</h1>
        ${map?.summary ? `<p class="lede">${esc(map.summary)}</p>` : ""}
      </aside>
      <div class="centre">
        <div class="nomap">
          <div class="eyebrow">No change map yet</div>
          <p>The map — the components this change touches, how a request flows through them, and how each one is built — is written by the <code>implementation.report</code> step once the build passes review. This run has not run it${m.implementation_summary ? "; the implementer's own summary follows" : ""}. In the viewer, <b>Map this change</b> sends the run to that step.</p>
          ${m.implementation_summary ? pre(m.implementation_summary) : ""}
        </div>
      </div>
    </div>`;
  }

  // supporting: the worked example and the run's own account of itself
  const supporting: string[] = [];
  const ex = map?.example;
  if (ex) {
    supporting.push(`<div class="col"><div class="eyebrow">Worked example</div><h3>${esc(ex.title)}</h3>${ex.body ? `<p class="muted">${esc(ex.body)}</p>` : ""}
      ${ex.steps.length ? `<ol class="example">${ex.steps.map((s, i) => `<li><span class="n">${i + 1}</span>${esc(s)}</li>`).join("")}</ol>` : ""}
      ${ex.outcome ? `<div class="outcome">${ex.outcome.label ? `<span class="chip">${esc(ex.outcome.label)}</span>` : ""}<p>${esc(ex.outcome.body)}</p></div>` : ""}</div>`);
  }
  if (m.steps.length) {
    let day: string | null = null;
    const rows = m.steps.map((s) => {
      const t = hhmm(s.at, day);
      day = t.day;
      return `<li class="k-${s.kind}"><time datetime="${esc(s.at)}">${esc(t.label)}</time><span class="dot"></span><div><b>${esc(s.title)}</b>${s.detail ? `<p>${esc(s.detail)}</p>` : ""}</div></li>`;
    }).join("");
    supporting.push(`<div class="col"><div class="eyebrow">${esc(m.run_id)}</div><h3>How the run got here</h3><p class="muted">Times are UTC, from the run log.</p><ol class="steps">${rows}</ol></div>`);
  }

  // evidence and plan: the receipts, collapsed below the change
  const evidence: string[] = [];
  if (m.criteria.length) {
    evidence.push(`<div class="eyebrow">Acceptance criteria</div><table class="criteria"><tbody>${m.criteria.map((c) => `
      <tr class="c-${c.state}"><td class="state">${STATE_WORD[c.state]}</td><td><span class="cid">${esc(c.id)}</span> ${esc(c.text)}${c.note ? `<div class="note">${esc(c.note)}</div>` : ""}</td></tr>`).join("")}</tbody></table>`);
  }
  if (m.tests) {
    evidence.push(`<div class="eyebrow">Tests</div><div class="kv"><b>${esc(m.tests.outcome.toUpperCase())}</b>${m.tests.command ? ` <code>${esc(m.tests.command)}</code>` : ""}${m.tests.reason ? ` — ${esc(m.tests.reason)}` : ""}</div>${m.tests.tail ? `<details><summary>Output tail</summary>${pre(m.tests.tail, "code")}</details>` : ""}`);
  }
  if (m.screens) {
    const shots = m.screens.shots.map((s) => `<figure>${s.src ? `<img src="${esc(s.src)}" alt="${esc(`screenshot of ${s.path}`)}" loading="lazy">` : `<div class="noimg">not embedded — too large; it is in the run's evidence folder</div>`}<figcaption><code>${esc(s.path)}</code>${s.console_errors ? ` · ${s.console_errors} console error${s.console_errors === 1 ? "" : "s"}` : ""}</figcaption></figure>`).join("");
    evidence.push(`<div class="eyebrow">Screens</div><div class="kv"><b>${esc(m.screens.outcome.toUpperCase())}</b>${m.screens.reason ? ` — ${esc(m.screens.reason)}` : ""}</div>${shots ? `<div class="shots">${shots}</div>` : ""}`);
  }
  if (m.review?.verdict) {
    const f = findingsText(m.review.findings);
    evidence.push(`<div class="eyebrow">Last review</div><div class="kv"><b>${esc(m.review.verdict.toUpperCase())}</b></div>${f ? pre(f, "code") : ""}`);
  }

  const cost = m.usage && m.usage.cost_usd !== null ? `$${m.usage.cost_usd.toFixed(2)}${m.usage.partial ? " (partial)" : ""}` : null;
  const data = JSON.stringify({ flow: map?.flow.map((f) => f.component ?? null) ?? [] }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="howdah run report">
<title>${esc(clip(title, 80))}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
${strip}
${stage}
${supporting.length ? `<section class="supporting"><div class="divider"><span>Supporting</span></div><div class="cols">${supporting.join("")}</div></section>` : ""}
${evidence.length ? `<details class="block"><summary><span class="eyebrow">Evidence</span> ${esc(live ? `${passed}/${live} criteria met` : "")}${m.tests ? ` · tests ${esc(m.tests.outcome)}` : ""}</summary>${evidence.join("")}</details>` : ""}
${m.plan ? `<details class="block"><summary><span class="eyebrow">The plan</span> ${m.plan.split(/\s+/).filter(Boolean).length.toLocaleString("en")} words</summary>${pre(m.plan)}</details>` : ""}
<footer>Generated by Howdah from the run log at ${esc(m.generated_at)}${cost ? ` · ${esc(cost)}` : ""}. Nothing on this page is stored separately; reopen it for the current state.</footer>
<script type="application/json" id="report-data">${data}</script>
<script>${REPORT_JS}</script>
</body>
</html>
`;
}

/**
 * The page's behaviour. Selecting a box (click, Enter) or a row of the path shows that
 * component's panel. Play walks the request path, moving a token along each hop and selecting
 * the component it arrives at; Trace one step advances one hop; Reset returns to the first step.
 * The two tabs switch every panel at once, so the reader stays on "how it's built" while stepping.
 */
const REPORT_JS = `(function(){
  var data={flow:[]}; try{ data=JSON.parse(document.getElementById('report-data').textContent); }catch(e){}
  var flow=data.flow||[], svg=document.querySelector('svg.map'), token=document.querySelector('svg.map .token');
  var stateEl=document.querySelector('[data-state]'), step=-1, timer=null, tab='does', zoom=1, anim=null;
  function all(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function select(id){
    if(!id) return;
    all('[data-id]').forEach(function(n){ n.classList.toggle('on', n.getAttribute('data-id')===id); });
    all('.path [data-for]').forEach(function(n){ n.classList.toggle('on', n.getAttribute('data-for')===id); });
    all('.panel').forEach(function(p){ p.hidden = p.getAttribute('data-panel')!==id; });
  }
  function mark(i){
    all('[data-step]').forEach(function(n){ n.classList.toggle('now', Number(n.getAttribute('data-step'))===i); n.classList.toggle('done', Number(n.getAttribute('data-step'))<i); });
  }
  function centre(id){
    var g=svg&&svg.querySelector('g.box[data-id="'+(window.CSS&&CSS.escape?CSS.escape(id):id)+'"]'); if(!g) return null;
    // rest on the box's left edge, where a wire arrives, never over its label
    var m=g.transform.baseVal.consolidate(), r=g.querySelector('rect'); return {x:(m?m.matrix.e:0), y:(m?m.matrix.f:0)+(r?r.height.baseVal.value/2:0)};
  }
  function place(p){ if(token&&p){ token.setAttribute('cx',p.x); token.setAttribute('cy',p.y); token.classList.add('live'); } }
  function go(i){
    if(!flow.length) return;
    var prev=step; step=i; mark(i); select(flow[i]);
    var hop=svg&&svg.querySelector('path.hop[data-hop="'+i+'"]');
    if(anim) cancelAnimationFrame(anim);
    if(i>prev && prev>=0 && hop && hop.getTotalLength && hop.getTotalLength()>0){
      var len=hop.getTotalLength(), from=centre(flow[prev]), start=hop.getPointAtLength(0), rev=from&&start&&Math.hypot(start.x-from.x,start.y-from.y)>Math.hypot(hop.getPointAtLength(len).x-from.x,hop.getPointAtLength(len).y-from.y);
      var t0=null; var run=function(ts){ if(t0===null) t0=ts; var k=Math.min(1,(ts-t0)/700); place(hop.getPointAtLength(rev?len*(1-k):len*k)); if(k<1) anim=requestAnimationFrame(run); else place(centre(flow[i])); };
      anim=requestAnimationFrame(run);
    } else place(centre(flow[i]));
  }
  function next(){ var i=step+1; while(i<flow.length && !flow[i]) i++; if(i>=flow.length){ stop(); return false; } go(i); return true; }
  function stop(){ if(timer){ clearInterval(timer); timer=null; } if(stateEl) stateEl.textContent='PAUSED'; var b=document.querySelector('[data-act="play"]'); if(b) b.textContent='\\u25B6 Play flow'; }
  function play(){ if(timer){ stop(); return; } if(step>=flow.length-1) step=-1; if(stateEl) stateEl.textContent='FLOWING'; var b=document.querySelector('[data-act="play"]'); if(b) b.textContent='\\u23F8 Pause flow'; next(); timer=setInterval(function(){ if(!next()) stop(); },1600); }
  function setZoom(z){ zoom=Math.max(0.5,Math.min(2,z)); if(svg) svg.style.width=(Number(svg.getAttribute('data-w'))*zoom)+'px'; }
  all('[data-act]').forEach(function(b){ b.addEventListener('click',function(){ var a=b.getAttribute('data-act');
    if(a==='play') play(); else if(a==='step'){ stop(); if(!next()){ step=-1; next(); } } else if(a==='reset'){ stop(); step=-1; mark(-1); if(token) token.classList.remove('live'); select(flow.filter(Boolean)[0]); setZoom(1); }
    else if(a==='in') setZoom(zoom*1.2); else if(a==='out') setZoom(zoom/1.2); }); });
  all('g.box').forEach(function(g){
    g.addEventListener('click',function(){ stop(); select(g.getAttribute('data-id')); });
    g.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); stop(); select(g.getAttribute('data-id')); } });
  });
  all('.path li[data-for]').forEach(function(li){ li.addEventListener('click',function(){ stop(); var s=li.getAttribute('data-step'); if(s!==null){ step=Number(s)-1; next(); } else select(li.getAttribute('data-for')); }); });
  all('.tabs [data-tab]').forEach(function(b){ b.addEventListener('click',function(){ tab=b.getAttribute('data-tab');
    all('.tabs [data-tab]').forEach(function(x){ x.setAttribute('aria-selected', String(x===b)); });
    all('.tab-body').forEach(function(t){ t.hidden = t.getAttribute('data-tab')!==tab; }); }); });
  setZoom(1);
})();`;

const REPORT_CSS = `
:root{--paper:#d9d4a8;--panel:#d2cc9c;--deep:#cbc595;--ink:#1d1c16;--muted:#5d5a45;--rule:#8f8a68;--faint:#b5af86;
  --new:#c4d45e;--changed:#9db0e0;--reused:#d6cfa6;--external:#d48c62;--fail:#b4442c;--op:#c26a2c;--on:#1d1c16;--on-ink:#e9e5c8;
  --mono:ui-monospace,SFMono-Regular,"JetBrains Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--paper:#1f1e18;--panel:#29281f;--deep:#24231b;--ink:#e9e5c8;--muted:#a7a386;--rule:#5b5843;--faint:#3a3829;
  --new:#7d8a2e;--changed:#4f6299;--reused:#56523b;--external:#94552f;--fail:#e0765c;--op:#e08a4a;--on:#e9e5c8;--on-ink:#1f1e18}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--paper);color:var(--ink);font:13px/1.55 var(--mono)}
a{color:inherit}
code{background:var(--panel);padding:0 3px;font-size:12px}
button{font:inherit;color:inherit;background:transparent;border:1px solid var(--ink);padding:5px 10px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;cursor:pointer}
button:hover,button:focus-visible{background:var(--on);color:var(--on-ink)}
.eyebrow{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin:18px 0 8px}
.eyebrow.ruled{border-bottom:1px solid var(--rule);padding-bottom:5px;margin-top:20px}
.muted{color:var(--muted)}
.strip{display:flex;flex-wrap:wrap;border-bottom:1px solid var(--rule);align-items:stretch}
.strip .cell{flex:1 1 170px;padding:9px 16px 10px;border-right:1px solid var(--rule);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.strip .cell .eyebrow{margin:0 0 3px}
.controls{display:flex;gap:6px;align-items:center;padding:8px 14px}
.stage{display:grid;grid-template-columns:250px minmax(0,1fr) 300px;min-height:min(86vh,900px);border-bottom:1px solid var(--rule)}
.stage.empty{grid-template-columns:250px minmax(0,1fr)}
.left,.right{padding:4px 16px 20px;overflow:auto;max-height:min(86vh,900px)}
.left{border-right:1px solid var(--rule)}
.right{border-left:1px solid var(--rule);padding-top:0}
.left h1{font-size:17px;line-height:1.35;margin:0 0 10px;font-weight:600}
.lede{color:var(--muted);margin:0 0 6px;white-space:pre-wrap}
ol.path{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
ol.path li{display:grid;grid-template-columns:18px 1fr auto;gap:8px;align-items:center;border:1px solid var(--ink);padding:7px 9px;font-size:12px;cursor:pointer;line-height:1.3}
ol.path li .n,ol.path li .tg{font-size:10px;color:var(--muted);letter-spacing:.08em}
ol.path li.on,ol.path li.now{background:var(--on);color:var(--on-ink)}
ol.path li.on .n,ol.path li.on .tg,ol.path li.now .n,ol.path li.now .tg{color:var(--on-ink)}
ol.path.support li{border-color:var(--rule)}
.legend{list-style:none;padding:12px 0 0;margin:16px 0 0;border-top:1px solid var(--rule);display:flex;flex-direction:column;gap:6px;font-size:10px;letter-spacing:.12em;color:var(--muted)}
.legend i,.st i{display:inline-block;width:10px;height:10px;border:1px solid var(--ink);margin-right:8px;vertical-align:-1px}
.s-new i{background:var(--new)}.s-changed i{background:var(--changed)}.s-reused i{background:var(--reused)}.s-external i{background:var(--external)}
.centre{display:flex;flex-direction:column;min-width:0;background:var(--deep)}
.topbar{display:flex;align-items:center;gap:12px;padding:6px 14px}
.topbar .eyebrow{margin:0}
.topbar .state{font-size:10px;letter-spacing:.16em;color:var(--op);font-weight:700}
.zoom{margin-left:auto;display:flex;flex-direction:column;gap:4px}
.zoom button{width:26px;height:26px;padding:0;font-size:14px;letter-spacing:0}
.canvas{flex:1;overflow:auto;display:flex;align-items:center;justify-content:center;padding:8px}
svg.map{display:block;max-width:none;height:auto;overflow:visible}
svg.map .slab{fill:var(--panel);stroke:var(--rule);stroke-width:1}
svg.map .grid{stroke:var(--faint);stroke-width:.6;fill:none;opacity:.7}
svg.map .lane{font:11px var(--mono);letter-spacing:.18em;fill:var(--muted)}
svg.map .wire{fill:none;stroke:var(--ink);stroke-width:1.4}
svg.map .wire.dashed{stroke-dasharray:6 5}
svg.map .hop{fill:none;stroke:none}
svg.map .box{cursor:pointer;outline:none}
svg.map .box .face{stroke:var(--ink);stroke-width:1.6;stroke-linejoin:round}
svg.map .box .shade{stroke:none;pointer-events:none}
svg.map .box .shade.top{fill:#fff;opacity:.28}
svg.map .box .shade.side{fill:#000;opacity:.22}
svg.map .box line{stroke:var(--ink);stroke-width:1}
svg.map .box.on .face,svg.map .box:focus-visible .face{stroke-width:3.6}
svg.map .box.off-path{opacity:.92}
svg.map .s-new .face{fill:var(--new)}svg.map .s-changed .face{fill:var(--changed)}svg.map .s-reused .face{fill:var(--reused)}svg.map .s-external .face{fill:var(--external)}
svg.map text{fill:var(--ink);font-family:var(--mono)}
svg.map .tag{font-size:11px;letter-spacing:.16em}
svg.map .label{font-size:15px}
svg.map .badge{font-size:10px;font-weight:700;letter-spacing:.16em}
svg.map .pip{fill:var(--ink)}
svg.map .token{fill:var(--new);stroke:var(--ink);stroke-width:1.5;opacity:0;transition:opacity .2s}
svg.map .token.live{opacity:1}
.tabs{display:grid;grid-template-columns:1fr 1fr;margin:0 -16px 0;border-bottom:1px solid var(--ink)}
.tabs button{border:0;border-right:1px solid var(--rule);padding:10px 6px}
.tabs button[aria-selected="true"]{background:var(--on);color:var(--on-ink)}
.panel h3{font-size:20px;margin:0;font-weight:600}
.panel .kind{color:var(--muted);font-size:11px;margin-top:2px}
.status-row{display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);margin-top:14px;padding:6px 0}
.status-row .eyebrow{margin:0}
.st{font-size:10px;font-weight:700;letter-spacing:.14em}
.st i{border-radius:50%;width:8px;height:8px;margin-right:6px}
.panel p{margin:6px 0}
.panel ul{margin:6px 0;padding-left:16px}
.panel li{margin:4px 0}
.trace{border:1px solid var(--ink);padding:4px 12px 10px;margin-top:22px}
.trace .eyebrow{margin-top:8px}
.trace ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px;font-size:12px}
.trace li{display:grid;grid-template-columns:18px 1fr;gap:6px;color:var(--muted)}
.trace li .n{font-size:10px;text-align:center;border:1px solid transparent;height:16px;line-height:14px}
.trace li.now{color:var(--ink);font-weight:700}
.trace li.now .n{background:var(--on);color:var(--on-ink)}
.trace li.done{color:var(--ink)}
.risks ul{margin:0;padding-left:16px}
.nomap{max-width:640px;margin:48px auto;padding:0 20px}
.nomap p{line-height:1.6}
.doc,.code{white-space:pre-wrap;word-break:break-word;background:var(--panel);border:1px solid var(--rule);padding:10px 12px;max-height:60vh;overflow:auto}
.code{font-size:12px}
.supporting{border-bottom:1px solid var(--rule)}
.divider{text-align:center;border-bottom:1px solid var(--rule);height:0;margin:0}
.divider span{position:relative;top:-9px;background:var(--paper);padding:0 14px;font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:var(--muted)}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr))}
.cols .col{padding:10px 20px 24px;border-right:1px solid var(--rule)}
.cols .col:last-child{border-right:0}
.cols h3{font-size:14px;margin:0 0 4px}
ol.example{list-style:none;padding:0;margin:10px 0;display:flex;flex-direction:column;gap:6px}
ol.example li{border:1px solid var(--ink);padding:6px 10px;display:flex;gap:12px}
ol.example li .n{color:var(--muted)}
.outcome{border:1px solid var(--ink);padding:10px 12px;margin-top:10px}
.chip{display:inline-block;border:1px solid var(--ink);font-size:10px;letter-spacing:.12em;padding:1px 6px;margin-bottom:4px}
.outcome p{margin:4px 0 0}
ol.steps{list-style:none;margin:8px 0 0;padding:0}
ol.steps li{display:grid;grid-template-columns:72px 14px 1fr;gap:8px;padding:4px 0}
ol.steps time{color:var(--muted);font-size:11px;padding-top:2px}
ol.steps .dot{width:10px;height:10px;border:1.4px solid var(--ink);margin-top:5px}
ol.steps .k-operator .dot{background:var(--op)}
ol.steps .k-failed .dot{background:var(--fail)}
ol.steps .k-finished .dot{background:var(--new)}
ol.steps p{margin:0;color:var(--muted)}
details.block{border-bottom:1px solid var(--rule);padding:4px 20px 12px}
details.block>summary{cursor:pointer;padding:8px 0;color:var(--muted)}
details.block>summary .eyebrow{display:inline;margin:0 8px 0 0;color:var(--ink)}
details summary{cursor:pointer;color:var(--muted)}
table.criteria{border-collapse:collapse;width:100%}
table.criteria td{border-top:1px solid var(--rule);padding:6px 8px;vertical-align:top}
table.criteria td.state{width:110px;font-size:10px;font-weight:700;letter-spacing:.12em}
tr.c-fail td.state{color:var(--fail)}
tr.c-superseded{color:var(--muted);text-decoration:line-through}
.cid{color:var(--muted)}
.note{color:var(--muted);font-size:12px;margin-top:2px;word-break:break-word}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;margin-top:8px}
.shots figure{margin:0;border:1px solid var(--rule);background:var(--panel)}
.shots img{display:block;width:100%;height:auto}
.shots figcaption{padding:4px 8px;font-size:12px}
.noimg{padding:24px 8px;color:var(--muted)}
footer{padding:12px 20px 32px;color:var(--muted);font-size:11px}
@media (max-width:1100px){.stage{grid-template-columns:230px minmax(0,1fr)}.stage .right{grid-column:1 / -1;border-left:0;border-top:1px solid var(--rule);max-height:none}}
@media (max-width:760px){.stage,.stage.empty{grid-template-columns:1fr}.left{border-right:0;max-height:none}.canvas{min-height:360px}}
@media print{.controls,.zoom{display:none}.doc,.code{max-height:none}details.block{display:block}}
`;
