/**
 * What a draft changes against the graph it started from (HOW-65; HOW-56 A, C, D-2A, D-6A).
 *
 * The draft card and the review page read the SAME list: what can change your code, what
 * changed, what did not. This module is that list, and it is pure and node-free on purpose: the
 * server computes it (web/draft.ts) and the browser only renders it, but a later slice that
 * recomputes it in the browser (the canvas diff, Phase 2) must not grow a second copy.
 *
 * STEPS ARE MATCHED BY ID, EXACTLY — the same rule `draftRuleProblems` uses for its `permission`
 * advice. A cleverer match (strip each graph's name off the front, say) reads better on a
 * renamed copy, but it would let this list call a step "unchanged" while the advice beside it
 * calls the same step "new", and the one question the operator must be able to answer from the
 * card — does this draft give anything a power it did not have — would get two answers.
 * So `grantsNewWrite` is computed by that rule and covers every `permission` advice by
 * construction, plus a kept step that LOST `readOnly` (which the advice does not see).
 *
 * Bodies are compared as the text a run would pin (`texts` / `baseTexts`, materialised by the
 * caller), with a small LCS line diff — the repo has no TypeScript line diff, and `reviser/`
 * shells out to git, which the browser cannot.
 */
import { predicateLabel, stepTitle, type DraftBody, type EdgeSpec, type GraphSpec, type NodeSpec } from "./graph-spec";

export type LineOp = { op: "eq" | "del" | "ins"; text: string };

/** a body diff past this many lines is collapsed behind "show all N lines" (D-2A) */
export const BODY_COLLAPSE_LINES = 20;

export interface BodyChange {
  /** the copied prompt, when the body is a `{ copyOf }` that equals what the base step had */
  unchangedFrom?: string;
  /** the copied prompt, when the body is a copy that is NOT the base step's text */
  copyOf?: string;
  lines: LineOp[];
  added: number;
  removed: number;
}

export type StepChange = "added" | "removed" | "changed" | "unchanged";

export interface StepRow {
  id: string;
  title: string;
  kind: NodeSpec["kind"];
  change: StepChange;
  /** what differs, each in words ("instructions", "now read-only", …); empty unless changed */
  changes: string[];
  /** the knock-on effects, named: routes a removal drops, reads that came and went */
  cascades: string[];
  /** the instructions, against the base step's; absent for a step with none */
  body?: BodyChange;
}

export interface PermissionRow {
  id: string;
  title: string;
  /** true = the base had no writable step by this id: this draft GRANTS the power */
  isNew: boolean;
  /** the base step by this id was read-only and this one is not */
  lostReadOnly: boolean;
}

export interface DraftDiff {
  /** the base graph's name, or null for a draft from nothing */
  base: string | null;
  /** graph-level differences in words (description, launch inputs, fields) */
  graph: string[];
  added: StepRow[];
  removed: StepRow[];
  changed: StepRow[];
  unchanged: StepRow[];
  /** every agent step in the draft that can change files — risk first (D-2A) */
  permission: PermissionRow[];
  /** D-6A: the draft gives a step a write power its base did not have, so Save is not offered directly */
  grantsNewWrite: boolean;
}

type Agent = Extract<NodeSpec, { kind: "agent" }>;
const isAgent = (n: NodeSpec | undefined): n is Agent => n?.kind === "agent";

/**
 * A line diff by longest common subsequence. Deterministic: on a tie a deletion is emitted
 * before an insertion, so a replaced line reads `- old` then `+ new`. Past ~4M cells it gives
 * up on alignment and reports the whole of `a` deleted and the whole of `b` inserted — still
 * true, just less helpful, and never a stall on a pathological body.
 */
export function lineDiff(a: string, b: string): LineOp[] {
  const x = a === "" ? [] : a.replace(/\n$/, "").split("\n");
  const y = b === "" ? [] : b.replace(/\n$/, "").split("\n");
  const n = x.length;
  const m = y.length;
  if (n * m > 4_000_000)
    return [...x.map((text) => ({ op: "del" as const, text })), ...y.map((text) => ({ op: "ins" as const, text }))];
  // lcs[i][j] = LCS length of x[i..] and y[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: "eq", text: x[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: "del", text: x[i++]! });
    else out.push({ op: "ins", text: y[j++]! });
  }
  while (i < n) out.push({ op: "del", text: x[i++]! });
  while (j < m) out.push({ op: "ins", text: y[j++]! });
  return out;
}

function bodyChange(text: string, baseText: string, body: DraftBody | undefined): BodyChange {
  const copied = typeof body === "object" ? body.copyOf : undefined;
  const lines = lineDiff(baseText, text);
  const added = lines.filter((l) => l.op === "ins").length;
  const removed = lines.filter((l) => l.op === "del").length;
  if (copied !== undefined && added === 0 && removed === 0) return { unchangedFrom: copied, lines: [], added: 0, removed: 0 };
  return { ...(copied !== undefined ? { copyOf: copied } : {}), lines, added, removed };
}

const routeLabel = (e: EdgeSpec, spec: GraphSpec) =>
  `${stepTitle(spec, e.from)} → ${stepTitle(spec, e.to)}${e.when ? ` (when ${predicateLabel(e.when)})` : ""}`;
const edgeKey = (e: EdgeSpec) => JSON.stringify([e.from, e.to, e.when ?? null]);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const listed = (keys: string[]) => keys.map((k) => `\`${k}\``).join(", ");

/** What differs between a kept step and its base, in words, excluding its body and routes. */
function propertyChanges(n: NodeSpec, b: NodeSpec): string[] {
  if (n.kind !== b.kind) return [`was a ${b.kind} step, now a ${n.kind} step`];
  const out: string[] = [];
  if ((n.title ?? "") !== (b.title ?? "")) out.push(`renamed from "${b.title ?? b.id}"`);
  if (n.kind === "agent" && b.kind === "agent") {
    if (n.readOnly && !b.readOnly) out.push("now read-only");
    if (!n.readOnly && b.readOnly) out.push("no longer read-only — it can change files");
    if (n.prompt !== b.prompt) out.push(`instructions filed as \`${n.prompt}\` (was \`${b.prompt}\`)`);
    if (!same(n.maxVisits, b.maxVisits)) out.push(`visit limit ${n.maxVisits ?? "default"} (was ${b.maxVisits ?? "default"})`);
    if (!same(n.requires, b.requires)) out.push(n.requires ? `waits for approval at \`${n.requires}\`` : "no longer waits for an approval");
    if (!same(n.requiresAcceptance, b.requiresAcceptance)) out.push(n.requiresAcceptance ? "now held until its acceptance criteria pass" : "no longer held on acceptance criteria");
    if (!same(n.reviewsWorkOf, b.reviewsWorkOf)) out.push(`reviews the work of ${listed(n.reviewsWorkOf ?? []) || "nothing"}`);
  }
  if (n.kind === "command" && b.kind === "command" && n.run !== b.run) out.push(`runs \`${n.run}\` (was \`${b.run}\`)`);
  if (n.kind === "worktree" && b.kind === "worktree" && n.action !== b.action) out.push(`${n.action} (was ${b.action})`);
  if (n.kind === "wait" && b.kind === "wait" && n.duration !== b.duration) out.push(`waits ${n.duration} (was ${b.duration})`);
  if (n.kind === "terminal" && b.kind === "terminal" && n.outcome !== b.outcome) out.push(`finishes as ${n.outcome} (was ${b.outcome})`);
  const writes = (x: NodeSpec) => ("writes" in x ? x.writes : []);
  const plus = writes(n).filter((k) => !writes(b).includes(k));
  const minus = writes(b).filter((k) => !writes(n).includes(k));
  if (plus.length) out.push(`now publishes ${listed(plus)}`);
  if (minus.length) out.push(`no longer publishes ${listed(minus)}`);
  return out;
}

const readsOf = (n: NodeSpec): string[] => ("reads" in n && n.reads ? n.reads : []);

/**
 * The draft against its base. `texts` are the draft's bodies as text (copies filled in), keyed
 * by the draft's prompt ids; `baseTexts` the base's, keyed by ITS prompt ids. `bodies` are the
 * draft's bodies as proposed, so a copy can be told from text that happens to match.
 * Every list is in the order its graph declares its steps.
 */
export function diffDraft(opts: {
  spec: GraphSpec;
  bodies: Readonly<Record<string, DraftBody>>;
  texts: Readonly<Record<string, string>>;
  base: GraphSpec | null;
  baseTexts: Readonly<Record<string, string>>;
}): DraftDiff {
  const { spec, bodies, texts, base, baseTexts } = opts;
  const baseNodes = base?.nodes ?? [];
  const baseById = new Map(baseNodes.map((n) => [n.id, n]));
  const draftIds = new Set(spec.nodes.map((n) => n.id));
  const baseEdges = base?.edges ?? [];
  const baseEdgeKeys = new Set(baseEdges.map(edgeKey));
  const draftEdgeKeys = new Set(spec.edges.map(edgeKey));

  const graph: string[] = [];
  if (base) {
    if (spec.description !== base.description) graph.push(`description: "${spec.description}"`);
    if (!same(spec.inputs, base.inputs)) graph.push(`asks for ${listed(spec.inputs) || "nothing"} at launch (was ${listed(base.inputs) || "nothing"})`);
    const fieldKeys = (g: GraphSpec) => g.fields.map((f) => f.key);
    const newFields = fieldKeys(spec).filter((k) => !fieldKeys(base).includes(k));
    const goneFields = fieldKeys(base).filter((k) => !fieldKeys(spec).includes(k));
    if (newFields.length) graph.push(`new fields ${listed(newFields)}`);
    if (goneFields.length) graph.push(`fields removed: ${listed(goneFields)}`);
    if (spec.entry !== base.entry) graph.push(`starts at ${stepTitle(spec, spec.entry)} (was ${stepTitle(base, base.entry)})`);
  }

  const row = (n: NodeSpec, g: GraphSpec, change: StepChange): StepRow => ({
    id: n.id, title: stepTitle(g, n.id), kind: n.kind, change, changes: [], cascades: [],
  });

  const added: StepRow[] = [];
  const changed: StepRow[] = [];
  const unchanged: StepRow[] = [];
  for (const n of spec.nodes) {
    const b = baseById.get(n.id);
    if (!b) {
      const r = row(n, spec, "added");
      if (isAgent(n)) {
        // a new step whose instructions are a copy IS the copied prompt, word for word
        const body = bodies[n.prompt];
        r.body = typeof body === "object"
          ? { unchangedFrom: body.copyOf, lines: [], added: 0, removed: 0 }
          : bodyChange(texts[n.prompt] ?? "", "", body);
      }
      for (const e of spec.edges) if (e.from === n.id || e.to === n.id) r.cascades.push(`adds the route ${routeLabel(e, spec)}`);
      added.push(r);
      continue;
    }
    const r = row(n, spec, "unchanged");
    r.changes.push(...propertyChanges(n, b));
    if (isAgent(n) && isAgent(b)) {
      const body = bodyChange(texts[n.prompt] ?? "", baseTexts[b.prompt] ?? "", bodies[n.prompt]);
      r.body = body;
      if (body.added || body.removed) r.changes.push("instructions");
    }
    const nowReads = readsOf(n).filter((k) => !readsOf(b).includes(k));
    const noLonger = readsOf(b).filter((k) => !readsOf(n).includes(k));
    for (const k of nowReads) r.cascades.push(`${r.title} now reads \`context.${k}\``);
    for (const k of noLonger) r.cascades.push(`${r.title} no longer reads \`context.${k}\``);
    // a route belongs to the step it leaves; one that enters from a REMOVED step is named on that removal
    for (const e of spec.edges) if (e.from === n.id && !baseEdgeKeys.has(edgeKey(e))) r.cascades.push(`new route ${routeLabel(e, spec)}`);
    for (const e of baseEdges) if (e.from === n.id && !draftEdgeKeys.has(edgeKey(e))) r.cascades.push(`drops the route ${routeLabel(e, base!)}`);
    if (r.changes.length || r.cascades.length) {
      r.change = "changed";
      changed.push(r);
    } else unchanged.push(r);
  }

  const removed: StepRow[] = [];
  for (const b of baseNodes) {
    if (draftIds.has(b.id)) continue;
    const r = row(b, base!, "removed");
    if (isAgent(b)) r.body = bodyChange("", baseTexts[b.prompt] ?? "", undefined);
    for (const e of baseEdges)
      if (e.from === b.id || e.to === b.id) r.cascades.push(`removing ${r.title} also drops the route ${routeLabel(e, base!)}`);
    removed.push(r);
  }

  const permission: PermissionRow[] = [];
  for (const n of spec.nodes) {
    if (!isAgent(n) || n.readOnly) continue;
    const b = baseById.get(n.id);
    const lostReadOnly = isAgent(b) && !!b.readOnly;
    permission.push({ id: n.id, title: stepTitle(spec, n.id), isNew: !isAgent(b) || lostReadOnly, lostReadOnly });
  }

  return {
    base: base?.name ?? null,
    graph,
    added,
    removed,
    changed,
    unchanged,
    permission,
    grantsNewWrite: permission.some((p) => p.isNew),
  };
}
