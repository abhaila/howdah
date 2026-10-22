/**
 * A draft-graph run's draft, as the card and the review page read it (HOW-65; HOW-56 T7,
 * D-2A, D-4A, D-6A, D-9A, D-10A) — and the two writes that turn it into a graph.
 *
 * Everything here is DERIVED, per the log-is-the-only-storage invariant. The draft is the
 * `graph.draft` value the run's drafting step published (`node-finished.writes`); its base is
 * the spec in the catalog that step READ, so the diff says what the drafter changed rather than
 * what changed since; and "saved" is never a fact stored on the run — it is whichever local
 * graph carries `drafted.run === <this run>`. A reload, a second tab or a second Save button
 * therefore cannot disagree about whether this draft is already a graph.
 *
 * PROVENANCE IS WRITTEN HERE AND NOWHERE ELSE. The card's Save builds `drafted` from the run
 * log; the builder's PUT never takes one from the client (`builderProvenance`): it derives it
 * from `fromRun`, keeps the one already in the file on an update, and otherwise strips it.
 * `draftHash` is the hash of the draft as PROPOSED — with copies still copies — so T10's
 * metrics can compare it; `edited` is set by any save that went through the canvas.
 *
 * HOW-66 adds the two other answers to a draft (D-5A, D-10A). DISCARD is a decision event,
 * `draft-discarded`, appended under the log lock — idempotent, refused once the draft is saved,
 * and after it neither Save nor a redraft is offered or accepted. ASK FOR CHANGES launches a NEW
 * draft-graph run with `--parent` this one (core/draft-launch.ts builds what it is told); the old
 * card's "Redrafted → run Y" is derived from each child's own `run-started.parent`, never stored
 * here.
 *
 * HOW-67 (T8, D-7A) adds the QUIET inbox tier: `readyDrafts` lists every finished draft that
 * is neither saved nor discarded, for the Needs you screen's "Ready for you" group. It is
 * derived on every request by the same rules the card reads (`savedAs`, `deriveDraftDiscarded`),
 * so a Save in another tab clears it on the next poll, and it is deliberately NOT an attention
 * record: a draft can wait, and amber, the chime and the favicon belong to a run that cannot
 * proceed without you. A twice-refused draft parks (`needs-input`, not `done`), so it never
 * lands here and still takes the amber path.
 *
 * Never throws on a run's content: the draft is model output, and a draft that does not parse
 * is the `refused` state with the parser's reason, not a 500.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { EventLog, readLog } from "../log/write";
import type { LoggedEvent } from "../log/events";
import { deriveDraftDiscarded, deriveStatus } from "./derive";
import { redraftLaunchRequest, requestsOf } from "../core/draft-launch";
import type { LaunchRequest } from "../core/launch-args";
import { asGraphsCatalog, DRAFT_GRAPH, GRAPH_DRAFT_KEY, GRAPHS_CATALOG_DEFAULT_CAP, GRAPHS_CATALOG_KEY } from "../core/catalog";
import {
  draftHashOf, draftRuleProblems, parseGraphSpec, renameDraft, resolveDraftBodies, specOf, specProblems,
  type DraftBody, type DraftedProvenance, type GraphSpec, type SpecProblem,
} from "../core/graph-spec";
import { diffDraft, type DraftDiff } from "../core/draft-diff";
import { materialiseBodies, saveBuilderGraph } from "../graphs/builder";
import { LOCAL_NAME } from "../graphs/local";
import type { Graph } from "../core/graph";

export interface ReadyDraft {
  state: "ready";
  run: string;
  draft: { spec: GraphSpec; prompts: Record<string, DraftBody>; based_on: string | null; notes: string };
  /** the base as the drafter saw it (the catalog it read), or null for a draft from nothing */
  base: GraphSpec | null;
  /** the draft's bodies as text, copies filled in — what the builder opens and Save writes */
  texts: Record<string, string>;
  diff: DraftDiff;
  /** "Worth a look": the advice tier, minus the permission callouts the diff already leads with */
  advice: SpecProblem[];
  grantsNewWrite: boolean;
  draftHash: string;
  /** D-10A: the local graph this run's draft was saved as, derived from its `drafted.run` */
  saved: { name: string; edited: boolean } | null;
  /** the base graph changed (or went) after the draft was made */
  baseChanged: { base: string; gone: boolean } | null;
  /** HOW-66 (D-10A): the operator discarded this draft, from its `draft-discarded` event */
  discarded: { at: string } | null;
  /** HOW-66 (D-5A): the draft-graph runs launched as changes to this one, oldest first */
  redrafts: Array<{ run: string; at: string }>;
}

export type RunDraft =
  | { state: "unknown"; reason: string }
  | { state: "drafting"; reason: string }
  | { state: "refused"; reason: string }
  | ReadyDraft;

/** the HTTP status each state is served with */
export const DRAFT_STATUS: Record<RunDraft["state"], number> = { unknown: 404, drafting: 409, refused: 409, ready: 200 };

/** The latest succeeded write of `key` by any step — null when none. */
function lastWrite(events: LoggedEvent[], key: string): { found: boolean; value: unknown } {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "node-finished" && e.status === "succeeded" && key in e.writes) return { found: true, value: e.writes[key] };
  }
  return { found: false, value: undefined };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** the local graph whose provenance names this run (D-10A); first by name, so it is stable */
export function savedAs(runId: string, locals: Readonly<Record<string, Graph<any>>>): { name: string; edited: boolean } | null {
  for (const name of Object.keys(locals).sort()) {
    const drafted = specOf(locals[name]!)?.drafted;
    if (drafted?.run === runId) return { name, edited: drafted.edited === true };
  }
  return null;
}

/** Each base prompt as the text a run would pin, by id — one at a time, so one gone prompt
 *  costs that step its diff and not the whole page. */
function baseTextsOf(home: string, root: string, base: GraphSpec | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of base?.nodes ?? []) {
    if (n.kind !== "agent" || n.prompt in out) continue;
    const m = materialiseBodies(home, root, { [n.prompt]: { copyOf: n.prompt } });
    if (m.ok) out[n.prompt] = m.texts[n.prompt]!;
  }
  return out;
}

/**
 * The run's draft in one of four states (D-4A). `graphs` is the live registry (today's base);
 * `locals` the operator's own graphs (who saved this draft).
 */
export function readRunDraft(opts: {
  runsDir: string;
  runId: string;
  home: string;
  root: string;
  graphs: Readonly<Record<string, Graph<any>>>;
  locals: Readonly<Record<string, Graph<any>>>;
}): RunDraft {
  const { runId, home, root } = opts;
  const path = join(opts.runsDir, runId, "run.jsonl");
  if (!existsSync(path)) return { state: "unknown", reason: `There is no run called \`${runId}\`.` };
  const events = readLog(path);
  const started = events.find((e) => e.type === "run-started");
  if (started?.type === "run-started" && started.graph !== DRAFT_GRAPH)
    return { state: "unknown", reason: `\`${runId}\` is a ${started.graph} run, not a draft — only a ${DRAFT_GRAPH} run has a draft to review.` };

  const { status, ask, failure } = deriveStatus(events);
  if (status === "needs-input" || status === "failed-terminal")
    return { state: "refused", reason: ask?.reason ?? failure?.reason ?? "The draft was refused, and the run stopped." };
  if (status !== "done") return { state: "drafting", reason: "Howdah is still drafting this graph." };

  const written = lastWrite(events, GRAPH_DRAFT_KEY);
  if (!written.found) return { state: "refused", reason: "The run finished without publishing a draft." };
  let raw = written.value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return { state: "refused", reason: "The published draft is not valid JSON." }; }
  }
  if (!isObj(raw)) return { state: "refused", reason: "The published draft is not an object." };
  const parsed = parseGraphSpec(raw.spec);
  if (!parsed.ok) return { state: "refused", reason: `The published draft is not a graph Howdah can read: ${parsed.error}` };
  const spec = parsed.spec;
  if (!isObj(raw.prompts)) return { state: "refused", reason: "The published draft has no instructions." };
  const resolved = resolveDraftBodies(raw.prompts, Object.values(raw.prompts).flatMap((b) => (isObj(b) && typeof b.copyOf === "string" ? [b.copyOf] : [])));
  if (!resolved.ok) return { state: "refused", reason: resolved.problems.map((p) => p.message).join("\n") };
  const bodies = resolved.bodies;
  const basedOn = typeof raw.based_on === "string" ? raw.based_on : null;
  const notes = typeof raw.notes === "string" ? raw.notes : "";

  const catalog = asGraphsCatalog(lastWrite(events, GRAPHS_CATALOG_KEY).value);
  const catalogBase = basedOn ? catalog?.graphs.find((g) => g.name === basedOn)?.spec : undefined;
  const parsedBase = catalogBase ? parseGraphSpec(catalogBase) : null;
  const todayGraph = basedOn ? opts.graphs[basedOn] : undefined;
  const today = todayGraph ? specOf(todayGraph) : null;
  // the drafter's base when the catalog carried it; today's when it did not (an older run)
  const base = parsedBase?.ok ? parsedBase.spec : today;

  // a body change underneath the draft cannot be seen — the catalog carries prompt ids, not
  // text — so this compares SPECS. draftHashOf ignores positions and provenance, as wanted here.
  const baseChanged = basedOn === null
    ? null
    : !today
      ? { base: basedOn, gone: true }
      : base && draftHashOf(base, {}) !== draftHashOf(today, {})
        ? { base: basedOn, gone: false }
        : null;

  const materialised = materialiseBodies(home, root, bodies);
  if (!materialised.ok) return { state: "refused", reason: materialised.error };
  const texts = materialised.texts;
  const diff = diffDraft({ spec, bodies, texts, base, baseTexts: baseTextsOf(home, root, base) });
  const advice = [
    ...draftRuleProblems(spec, base ?? undefined, { bodies }).filter((p) => p.severity === "advice" && p.kind !== "permission"),
    ...specProblems(spec, { bodies: texts }).filter((p) => p.severity === "advice"),
  ];

  return {
    state: "ready",
    run: runId,
    draft: { spec, prompts: bodies, based_on: basedOn, notes },
    base,
    texts,
    diff,
    advice,
    grantsNewWrite: diff.grantsNewWrite,
    draftHash: draftHashOf(spec, bodies),
    saved: savedAs(runId, opts.locals),
    baseChanged,
    discarded: deriveDraftDiscarded(events),
    redrafts: redraftsOf(opts.runsDir, runId),
  };
}

/**
 * A run log's FIRST event (its `run-started`), read a chunk at a time up to the first newline —
 * a redraft's intent carries a whole draft, so a fixed-size read could cut it. null when the
 * file is missing, empty or its first line is not JSON.
 */
export function firstEvent(path: string): LoggedEvent | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(64 * 1024);
    for (let pos = 0; pos < 4 * 1024 * 1024;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      const nl = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, nl === -1 ? n : nl)));
      if (nl !== -1) break;
      pos += n;
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as LoggedEvent;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Every draft-graph run whose `run-started.parent` is `runId`, oldest first (D-5A's receipt). */
export function redraftsOf(runsDir: string, runId: string): Array<{ run: string; at: string }> {
  let dirs: string[];
  try { dirs = readdirSync(runsDir); } catch { return []; }
  const out: Array<{ run: string; at: string }> = [];
  for (const d of dirs) {
    if (d === runId) continue;
    const e = firstEvent(join(runsDir, d, "run.jsonl"));
    if (e?.type === "run-started" && e.graph === DRAFT_GRAPH && e.parent === runId) out.push({ run: d, at: e.ts });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.run.localeCompare(b.run));
}

/** HOW-67: one row of the quiet "Ready for you" tier */
export interface ReadyItem {
  run: string;
  /** the operator's `--name` label, when the run was given one */
  name: string | null;
  /** the operator's own words — a redraft's intent minus the previous draft it carries */
  intent: string;
  finished_at: string;
  /** the review page, where Save and Discard are */
  href: string;
}

/**
 * HOW-67: every draft-graph run that finished with a draft nobody has saved or discarded yet,
 * newest first. A non-draft run costs one read of its first line (`firstEvent`); only drafts
 * are read whole. A log that cannot be read is skipped — this tier is advisory, and the amber
 * tier is the one that errs toward keeping.
 */
export function readyDrafts(opts: { runsDir: string; locals: Readonly<Record<string, Graph<any>>> }): ReadyItem[] {
  let dirs: string[];
  try { dirs = readdirSync(opts.runsDir); } catch { return []; }
  const out: ReadyItem[] = [];
  for (const run of dirs) {
    const path = join(opts.runsDir, run, "run.jsonl");
    const started = firstEvent(path);
    if (started?.type !== "run-started" || started.graph !== DRAFT_GRAPH) continue;
    let events: LoggedEvent[];
    try { events = readLog(path); } catch { continue; }
    if (deriveStatus(events).status !== "done") continue;
    // a run that finished without publishing a draft has nothing to Save or Discard — listing
    // it would be an entry no button can ever clear
    if (!lastWrite(events, GRAPH_DRAFT_KEY).found) continue;
    if (deriveDraftDiscarded(events) || savedAs(run, opts.locals)) continue;
    const finished = events.findLast((e) => e.type === "run-finished");
    const intent = started.inputs.intent;
    out.push({
      run,
      name: started.name ?? null,
      intent: typeof intent === "string" ? requestsOf(intent) : "",
      finished_at: finished?.ts ?? started.ts,
      href: `/runs/${encodeURIComponent(run)}/draft`,
    });
  }
  return out.sort((a, b) => b.finished_at.localeCompare(a.finished_at) || a.run.localeCompare(b.run));
}

/** the sentences a discarded draft is refused with — one copy each */
export const draftDiscarded = "This draft was discarded.";
export const discardSaved = (name: string) => `This draft is already saved as \`${name}\` — delete the graph instead.`;

export type DiscardResult = { ok: true; appended: boolean } | { ok: false; status: number; error: string };

/**
 * Discard (D-10A): one `draft-discarded`, decided and appended under the log lock, so a second
 * press — or a second tab — is idempotent rather than a second event. Refused for a draft that
 * is not ready, and for one already saved: a discard receipt beside a live graph would be a lie.
 *
 * "Saved" is derived from the local graphs, not the log, so it is checked just BEFORE the lock;
 * a Save landing between the two is a window this single-user tool accepts.
 */
export function discardRunDraft(opts: { runsDir: string; runId: string; draft: RunDraft }): DiscardResult {
  const { draft } = opts;
  if (draft.state !== "ready") return { ok: false, status: DRAFT_STATUS[draft.state], error: draft.reason };
  if (draft.saved) return { ok: false, status: 409, error: discardSaved(draft.saved.name) };
  let already = false;
  const appended = new EventLog(join(opts.runsDir, opts.runId, "run.jsonl")).appendIf((events) => {
    if (deriveDraftDiscarded(events)) { already = true; return null; }
    return { type: "draft-discarded", by: "operator" };
  });
  return { ok: true, appended: !already && appended !== null };
}

/**
 * The longest intent a redraft may launch with. The render (v2) elides a context value past its
 * cap around a stub, and an elided previous draft would be redrafted from nothing without saying
 * so — so the route refuses instead and points at the builder.
 */
export const REDRAFT_INTENT_CAP = GRAPHS_CATALOG_DEFAULT_CAP;

export type RedraftResult = { ok: true; request: LaunchRequest } | { ok: false; status: number; error: string };

/**
 * Ask for changes (D-5A): what the child draft-graph run is launched with — this run as its
 * parent, the operator's earlier requests plus the change, this draft as the base, and this
 * run's workspace (`workspaceFor` maps its recorded cwd back to a registered name, or none).
 * Pure apart from reading this run's own `run-started`; the caller spawns.
 */
export function redraftRunDraft(opts: {
  runsDir: string;
  runId: string;
  draft: RunDraft;
  change: unknown;
  workspaceFor: (cwd: string) => string | null;
}): RedraftResult {
  const { draft } = opts;
  const change = typeof opts.change === "string" ? opts.change.trim() : "";
  if (!change) return { ok: false, status: 400, error: "Say what should change." };
  if (draft.state !== "ready") return { ok: false, status: DRAFT_STATUS[draft.state], error: draft.reason };
  if (draft.discarded) return { ok: false, status: 409, error: draftDiscarded };
  const started = firstEvent(join(opts.runsDir, opts.runId, "run.jsonl"));
  const intent = started?.type === "run-started" ? started.inputs.intent : undefined;
  const parentIntent = typeof intent === "string" ? intent : "";
  const workspace = started?.type === "run-started" && started.cwd ? opts.workspaceFor(started.cwd) ?? undefined : undefined;
  const request = redraftLaunchRequest({ parent: opts.runId, parentIntent, change, draft: draft.draft, workspace });
  if ((request.inputs?.intent ?? "").length > REDRAFT_INTENT_CAP)
    return { ok: false, status: 422, error: "This draft is too large to redraft from here; open it in the builder and change it there." };
  return { ok: true, request };
}

export type DraftSaveResult = { ok: true; name: string } | { ok: false; status: number; error: string };

/** "already saved" in one sentence, for the card's Save and the builder's PUT alike */
export const alreadySaved = (name: string) => `This draft is already saved as \`${name}\`.`;

/**
 * The card's Save (D-9A): the draft as proposed, renamed to what the operator typed, with
 * provenance `{ run, draftHash }`, through the builder's own transactional save — so the same
 * verdict, the same refusal sentences and the same copy materialisation apply.
 */
export async function saveRunDraft(opts: {
  home: string;
  root: string;
  draft: RunDraft;
  name: unknown;
  builtins: readonly string[];
}): Promise<DraftSaveResult> {
  const { draft } = opts;
  if (draft.state !== "ready") return { ok: false, status: DRAFT_STATUS[draft.state], error: draft.reason };
  if (draft.saved) return { ok: false, status: 409, error: alreadySaved(draft.saved.name) };
  if (draft.discarded) return { ok: false, status: 409, error: draftDiscarded };
  const name = typeof opts.name === "string" ? opts.name.trim() : "";
  if (!LOCAL_NAME.test(name)) return { ok: false, status: 400, error: `graph name must be kebab-case: "${name}"` };
  if (opts.builtins.includes(name)) return { ok: false, status: 409, error: builtinTaken(name) };
  const renamed = renameDraft(draft.draft.spec, draft.draft.prompts, name);
  const spec: GraphSpec = { ...renamed.spec, drafted: { run: draft.run, draftHash: draft.draftHash } };
  const saved = await saveBuilderGraph({ home: opts.home, repoRoot: opts.root, spec, prompts: renamed.bodies, intent: "create" });
  if (saved.ok) return { ok: true, name };
  return { ok: false, status: saved.code === "exists" ? 409 : 422, error: saved.error };
}

/** the builder route's sentence for a built-in's name — one copy, used by both routes */
export const builtinTaken = (name: string) => `"${name}" is one of Howdah's own graphs — pick another name`;

/**
 * Decision 2: what `drafted` a builder save may write. The client's is IGNORED.
 *   - `fromRun`: derived from that run's ready draft, marked edited — refused if it has no
 *     ready draft, or is already saved under a different name;
 *   - an update of a file that carries `drafted`: kept, marked edited;
 *   - otherwise: none.
 */
export function builderProvenance(opts: {
  name: string;
  fromRun: RunDraft | null;
  existing: GraphSpec | null;
}): { ok: true; drafted: DraftedProvenance | undefined } | { ok: false; status: number; error: string } {
  const { fromRun } = opts;
  if (fromRun) {
    if (fromRun.state !== "ready") return { ok: false, status: DRAFT_STATUS[fromRun.state], error: fromRun.reason };
    if (fromRun.discarded) return { ok: false, status: 409, error: draftDiscarded };
    if (fromRun.saved && fromRun.saved.name !== opts.name) return { ok: false, status: 409, error: alreadySaved(fromRun.saved.name) };
    return { ok: true, drafted: { run: fromRun.run, draftHash: fromRun.draftHash, edited: true } };
  }
  const kept = opts.existing?.drafted;
  return { ok: true, drafted: kept ? { run: kept.run, draftHash: kept.draftHash, edited: true } : undefined };
}
