/**
 * HOW-78: the run report — ONE self-contained HTML file an engineer opens to see what a run
 * changed and how it got there, and can hand to someone else.
 *
 * Why Howdah renders it rather than the agent. The ticket asks for an artifact "like" a hosted
 * Claude page, but compatible with every harness: a codex or cursor turn has no artifact
 * channel, and a page an agent hand-writes is HTML nobody validated. So the work is split along
 * the line the rest of Howdah already draws:
 *
 *   - the AGENT contributes the one thing only it can know — what the change IS — as data, the
 *     `change_map` output of `implementation.report` (prompts/implementation.report.md). It is
 *     an ordinary context value, so it is in the log, survives a resume, and reads the same on
 *     every harness;
 *   - everything else — the plan, the criteria and their evidence, the test verdict, the
 *     screens, the PR, and "how the run got here" — is a FACT the log already holds, and is
 *     derived here, never asked of a model.
 *
 * Nothing is stored. The report is a pure function of the log (web/report.ts gathers the
 * model, `GET /api/runs/:id/report` and `howdah report` render it), so it is current whenever
 * it is opened and there is no sidecar to go stale (CLAUDE.md, "the log is the only storage").
 *
 * Node-free and dependency-free: the parser is shared with the viewer, and the page must open
 * from a file:// URL or an email attachment, so it links nothing — its CSS, its one small script
 * and its screenshots (as data: URIs) are all inside it. The page carries its own palette for
 * the same reason; it cannot reach tokens.css. Every status is a WORD as well as a colour.
 *
 * `change_map` is untrusted model output: `asChangeMap` returns null rather than throwing, drops
 * malformed rows, and a link naming a component that does not exist is skipped, never drawn.
 * Every string reaches the page through `esc`.
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
  /** what it does, in one or two sentences */
  what?: string;
  /** where and how it changed — file paths and the specific change */
  how?: string[];
}

export interface ChangeLink {
  from: string;
  to: string;
  label?: string;
  /** an indirect or asynchronous dependency */
  dashed?: boolean;
}

export interface ChangeMap {
  title: string;
  summary: string;
  components: ChangeComponent[];
  links: ChangeLink[];
  /** the path one request or event takes through the change, in order */
  flow: Array<{ component?: string; text: string }>;
  /** what a reviewer should look hardest at */
  risks: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s): s is string => s !== undefined) : []);

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
    const tag = str(c.tag);
    const group = str(c.group);
    const what = str(c.what);
    components.push({ id, label, status, ...(tag ? { tag } : {}), ...(group ? { group } : {}), ...(what ? { what } : {}), how: strs(c.how) });
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
  const title = str(raw.title);
  const summary = str(raw.summary);
  if (!title && !summary && components.length === 0) return null;
  return { title: title ?? "The change", summary: summary ?? "", components, links, flow, risks: strs(raw.risks) };
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

/** box geometry for the map — one lane (column) per group, in first-appearance order */
const BOX_W = 168;
const BOX_H = 72;
const GAP_X = 72;
const GAP_Y = 36;
const PAD = 28;
const LANE_HEAD = 26;

export interface PlacedBox { c: ChangeComponent; x: number; y: number }

/** Layered placement: a lane per group, boxes stacked in the order the agent listed them. */
export function placeComponents(components: readonly ChangeComponent[]): { boxes: PlacedBox[]; lanes: Array<{ name: string; x: number }>; width: number; height: number } {
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
    members.forEach((c, i) => boxes.push({ c, x, y: PAD + LANE_HEAD + i * (BOX_H + GAP_Y) }));
    tallest = Math.max(tallest, members.length);
  });
  const width = PAD * 2 + Math.max(1, order.length) * BOX_W + Math.max(0, order.length - 1) * GAP_X;
  const height = PAD * 2 + LANE_HEAD + Math.max(1, tallest) * BOX_H + Math.max(0, tallest - 1) * GAP_Y;
  return { boxes, lanes, width, height };
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** characters of the 13px mono label that fit inside a box */
const LABEL_CHARS = 18;

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

function mapSvg(map: ChangeMap): string {
  const { boxes, lanes, width, height } = placeComponents(map.components);
  const at = new Map(boxes.map((b) => [b.c.id, b]));
  const wires = map.links.map((l) => {
    const a = at.get(l.from);
    const b = at.get(l.to);
    if (!a || !b) return "";
    // leave from the facing side, travel orthogonally, arrive at the facing side
    const ax = a.x <= b.x ? a.x + BOX_W : a.x;
    const bx = a.x < b.x ? b.x : a.x > b.x ? b.x + BOX_W : b.x;
    const ay = a.y + BOX_H / 2;
    const by = b.y + BOX_H / 2;
    // same lane: adjacent boxes join edge to edge; farther ones go round the right-hand side
    // rather than straight through the boxes between them
    const path = a.x !== b.x
      ? `M${ax},${ay} H${(ax + bx) / 2} V${by} H${bx}`
      : Math.abs(a.y - b.y) <= BOX_H + GAP_Y
        ? `M${a.x + BOX_W / 2},${a.y + (a.y < b.y ? BOX_H : 0)} L${b.x + BOX_W / 2},${b.y + (a.y < b.y ? 0 : BOX_H)}`
        : `M${a.x + BOX_W},${ay} h${GAP_X / 4} V${by} H${b.x + BOX_W}`;
    const title = `${l.from} → ${l.to}${l.label ? ` · ${l.label}` : ""}`;
    return `<path class="wire${l.dashed ? " dashed" : ""}" d="${path}"><title>${esc(title)}</title></path>`;
  }).join("");
  const laneHeads = lanes.filter((l) => l.name).map((l) => `<text class="lane" x="${l.x}" y="${PAD + 12}">${esc(clip(l.name.toUpperCase(), 28))}</text>`).join("");
  const nodes = boxes.map(({ c, x, y }) => `
    <g class="box s-${c.status}" data-id="${esc(c.id)}" tabindex="0" role="button" aria-label="${esc(`${c.label} — ${STATUS_WORD[c.status]}`)}" transform="translate(${x},${y})">
      <rect width="${BOX_W}" height="${BOX_H}" rx="2"/>
      <line x1="0" y1="22" x2="${BOX_W}" y2="22"/>
      <text class="tag" x="8" y="15">${esc(clip((c.tag ?? c.id).toUpperCase(), 18))}</text>
      ${wrap(c.label, LABEL_CHARS, 2).map((line, i) => `<text class="label" x="8" y="${42 + i * 16}">${esc(line)}</text>`).join("")}
      ${c.status === "new" || c.status === "changed" ? `<text class="badge" x="${BOX_W - 8}" y="${BOX_H - 8}" text-anchor="end">${STATUS_WORD[c.status]}</text>` : ""}
    </g>`).join("");
  return `<svg class="map" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(`system map: ${map.components.length} components`)}">${laneHeads}${wires}${nodes}</svg>`;
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

export function renderRunReport(m: RunReportModel): string {
  const passed = m.criteria.filter((c) => c.state === "pass" || c.state === "waived").length;
  const live = m.criteria.filter((c) => c.state !== "superseded").length;
  const pr = m.pull_requests.at(-1);
  const title = m.change?.title ?? m.name ?? m.ticket ?? m.run_id;
  const head = [
    { k: "Run", v: `${m.graph} · ${m.run_id}` },
    { k: "Ticket", v: m.ticket ?? "—" },
    { k: "Pull request", v: pr ? `${pr.url.replace(/^https:\/\/github\.com\//, "")} · ${pr.state}` : "not published", href: pr?.url },
    { k: "Tests", v: m.tests ? `${m.tests.outcome}${m.tests.commit ? ` @ ${m.tests.commit.slice(0, 8)}` : ""}` : "not run" },
    { k: "Criteria", v: live ? `${passed}/${live} met` : "none written" },
    { k: "Status", v: m.status },
  ];
  const map = m.change;
  const sections: string[] = [];

  // the change: summary, map, per-component detail, the path through it
  if (map) {
    const flow = map.flow.length
      ? `<ol class="flow">${map.flow.map((f) => `<li${f.component ? ` data-for="${esc(f.component)}"` : ""}>${esc(f.text)}</li>`).join("")}</ol>`
      : "";
    const legend = COMPONENT_STATUSES.filter((s) => map.components.some((c) => c.status === s))
      .map((s) => `<span class="key s-${s}"><i></i>${STATUS_WORD[s]}</span>`).join("");
    const cards = map.components.map((c) => `
      <article class="comp s-${c.status}" id="c-${esc(c.id)}" data-id="${esc(c.id)}">
        <header><span class="tag">${esc((c.tag ?? c.id).toUpperCase())}</span><strong>${esc(c.label)}</strong><span class="state">${STATUS_WORD[c.status]}</span></header>
        ${c.what ? `<p>${esc(c.what)}</p>` : ""}
        ${c.how && c.how.length ? `<ul>${c.how.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
      </article>`).join("");
    sections.push(`
    <section class="change">
      <div class="eyebrow">The change</div>
      <h2>${esc(map.title)}</h2>
      ${map.summary ? pre(map.summary, "lede") : ""}
      ${map.components.length ? `<div class="legend">${legend}</div><div class="map-wrap">${mapSvg(map)}</div>` : ""}
      <div class="split">
        ${flow ? `<div><div class="eyebrow">The path through it</div>${flow}</div>` : ""}
        ${map.risks.length ? `<div><div class="eyebrow">Look hardest at</div><ul class="risks">${map.risks.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>` : ""}
      </div>
      ${cards ? `<div class="eyebrow">Where and how</div><div class="comps">${cards}</div>` : ""}
    </section>`);
  } else {
    sections.push(`
    <section class="change">
      <div class="eyebrow">The change</div>
      <h2>${esc(title)}</h2>
      <p class="muted">No change map was written for this run${m.implementation_summary ? " — the implementer's own summary follows" : ""}. A graph with an <code>implementation.report</code> step draws one once the build has passed review.</p>
      ${m.implementation_summary ? pre(m.implementation_summary) : ""}
    </section>`);
  }

  // evidence: criteria, tests, screens, review
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
  if (evidence.length) sections.push(`<section class="evidence"><h2>Evidence</h2>${evidence.join("")}</section>`);

  // the plan, and the run's own account of itself
  const lower: string[] = [];
  if (m.plan) lower.push(`<div><div class="eyebrow">The plan</div><details open><summary>${m.plan.split(/\s+/).filter(Boolean).length.toLocaleString("en")} words</summary>${pre(m.plan)}</details></div>`);
  if (m.steps.length) {
    let day: string | null = null;
    const rows = m.steps.map((s) => {
      const t = hhmm(s.at, day);
      day = t.day;
      return `<li class="k-${s.kind}"><time datetime="${esc(s.at)}">${esc(t.label)}</time><span class="dot"></span><div><b>${esc(s.title)}</b>${s.detail ? `<p>${esc(s.detail)}</p>` : ""}</div></li>`;
    }).join("");
    lower.push(`<div><div class="eyebrow">${esc(m.run_id)}</div><h3>How the run got here</h3><p class="muted">Times are UTC, from the run log.</p><ol class="steps">${rows}</ol></div>`);
  }
  if (lower.length) sections.push(`<section class="split lower">${lower.join("")}</section>`);

  const cost = m.usage && m.usage.cost_usd !== null ? `$${m.usage.cost_usd.toFixed(2)}${m.usage.partial ? " (partial)" : ""}` : null;
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
<header class="strip">${head.map((h) => `<div><div class="eyebrow">${esc(h.k)}</div>${h.href ? `<a href="${esc(h.href)}">${esc(h.v)}</a>` : `<span>${esc(clip(h.v, 90))}</span>`}</div>`).join("")}</header>
<main>
${sections.join("\n")}
</main>
<footer>Generated by Howdah from the run log at ${esc(m.generated_at)}${cost ? ` · ${esc(cost)}` : ""}. Nothing on this page is stored separately; reopen it for the current state.</footer>
<script>${REPORT_JS}</script>
</body>
</html>
`;
}

/**
 * The page's one behaviour: selecting a box on the map (click or Enter) highlights it and its
 * card and scrolls the card into view. Without script the map and the cards still read.
 */
const REPORT_JS = `(function(){
  function pick(id){
    document.querySelectorAll('[data-id]').forEach(function(n){ n.classList.toggle('on', n.getAttribute('data-id')===id); });
    document.querySelectorAll('[data-for]').forEach(function(n){ n.classList.toggle('on', n.getAttribute('data-for')===id); });
    var card=document.getElementById('c-'+id); if(card&&card.scrollIntoView) card.scrollIntoView({block:'nearest',behavior:'smooth'});
  }
  document.querySelectorAll('g.box').forEach(function(g){
    g.addEventListener('click',function(){ pick(g.getAttribute('data-id')); });
    g.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); pick(g.getAttribute('data-id')); } });
  });
})();`;

const REPORT_CSS = `
:root{--paper:#d9d4a8;--panel:#d2cc9c;--ink:#1d1c16;--muted:#5d5a45;--rule:#8f8a68;--new:#c4d45e;--changed:#9db0e0;--reused:#d6cfa6;--external:#d48c62;--fail:#b4442c;--op:#c26a2c;
  --mono:ui-monospace,SFMono-Regular,"JetBrains Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--paper:#1f1e18;--panel:#29281f;--ink:#e9e5c8;--muted:#a7a386;--rule:#5b5843;--new:#7d8a2e;--changed:#4f6299;--reused:#56523b;--external:#94552f;--fail:#e0765c;--op:#e08a4a}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:13px/1.55 var(--mono)}
a{color:inherit}
code{background:var(--panel);padding:0 3px}
.eyebrow{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:18px 0 6px}
.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));border-bottom:1px solid var(--rule)}
.strip>div{padding:8px 16px 10px;border-right:1px solid var(--rule);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.strip .eyebrow{margin:0 0 2px}
main{max-width:1280px;margin:0 auto;padding:8px 16px 32px}
section{border-bottom:1px solid var(--rule);padding:8px 0 24px}
h2{font-size:18px;margin:4px 0 8px}
h3{font-size:14px;margin:0 0 2px}
.lede{max-width:72ch;white-space:pre-wrap;color:var(--ink)}
.muted{color:var(--muted)}
.doc,.code{white-space:pre-wrap;word-break:break-word;background:var(--panel);border:1px solid var(--rule);padding:10px 12px;max-height:60vh;overflow:auto}
.code{font-size:12px}
.legend{display:flex;gap:16px;margin:12px 0 8px;font-size:10px;letter-spacing:.1em}
.legend i{display:inline-block;width:10px;height:10px;border:1px solid var(--ink);margin-right:6px;vertical-align:-1px}
.key.s-new i{background:var(--new)}.key.s-changed i{background:var(--changed)}.key.s-reused i{background:var(--reused)}.key.s-external i{background:var(--external)}
.map-wrap{overflow-x:auto;background:var(--panel);border:1px solid var(--rule)}
svg.map{display:block;max-width:none}
svg.map .lane{font:10px var(--mono);letter-spacing:.14em;fill:var(--muted)}
svg.map .wire{fill:none;stroke:var(--ink);stroke-width:1.2}
svg.map .wire.dashed{stroke-dasharray:5 4}
svg.map .box{cursor:pointer;outline:none}
svg.map .box rect{stroke:var(--ink);stroke-width:1.4}
svg.map .box line{stroke:var(--ink);stroke-width:1}
svg.map .box.on rect,svg.map .box:focus rect{stroke-width:3}
svg.map .s-new rect{fill:var(--new)}svg.map .s-changed rect{fill:var(--changed)}svg.map .s-reused rect{fill:var(--reused)}svg.map .s-external rect{fill:var(--external)}
svg.map text{fill:var(--ink);font-family:var(--mono)}
svg.map .tag{font-size:10px;letter-spacing:.12em}
svg.map .label{font-size:13px}
svg.map .badge{font-size:9px;font-weight:700;letter-spacing:.12em}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:24px}
.flow,.risks{margin:0;padding-left:22px}
.flow li.on{font-weight:700}
.comps{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
.comp{border:1px solid var(--rule);background:var(--panel);padding:8px 10px;border-left-width:6px}
.comp.on{outline:2px solid var(--ink)}
.comp.s-new{border-left-color:var(--new)}.comp.s-changed{border-left-color:var(--changed)}.comp.s-reused{border-left-color:var(--reused)}.comp.s-external{border-left-color:var(--external)}
.comp header{display:flex;gap:8px;align-items:baseline}
.comp .tag,.comp .state{font-size:10px;letter-spacing:.12em;color:var(--muted)}
.comp .state{margin-left:auto}
.comp p{margin:6px 0}.comp ul{margin:4px 0;padding-left:18px}
table.criteria{border-collapse:collapse;width:100%}
table.criteria td{border-top:1px solid var(--rule);padding:6px 8px;vertical-align:top}
table.criteria td.state{width:110px;font-size:10px;font-weight:700;letter-spacing:.12em}
tr.c-fail td.state{color:var(--fail)}
tr.c-superseded{color:var(--muted);text-decoration:line-through}
.cid{color:var(--muted)}
.note{color:var(--muted);font-size:12px;margin-top:2px}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;margin-top:8px}
.shots figure{margin:0;border:1px solid var(--rule);background:var(--panel)}
.shots img{display:block;width:100%;height:auto}
.shots figcaption{padding:4px 8px;font-size:12px}
.noimg{padding:24px 8px;color:var(--muted)}
ol.steps{list-style:none;margin:8px 0 0;padding:0}
ol.steps li{display:grid;grid-template-columns:72px 14px 1fr;gap:8px;padding:4px 0}
ol.steps time{color:var(--muted);font-size:11px;padding-top:2px}
ol.steps .dot{width:10px;height:10px;border:1.4px solid var(--ink);margin-top:5px}
ol.steps .k-operator .dot{background:var(--op)}
ol.steps .k-failed .dot{background:var(--fail)}
ol.steps .k-finished .dot{background:var(--new)}
ol.steps p{margin:0;color:var(--muted)}
details summary{cursor:pointer;color:var(--muted);margin-bottom:6px}
footer{max-width:1280px;margin:0 auto;padding:12px 16px 32px;color:var(--muted);font-size:11px}
@media print{.doc,.code{max-height:none}}
`;
