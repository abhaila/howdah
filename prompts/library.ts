/**
 * Prompt library read model (T21) — R1's "every prompt is an addressable object with its
 * own history", made visible.
 *
 * Everything here is DERIVED. Four sources, no fifth store:
 *
 *   prompts/<id>.md          the prompt itself + its front-matter provenance
 *   git log                  its version history (A1.1: git IS the version history)
 *   feedback/<id>.jsonl      what you said about it, per run+visit (A2.1)
 *   runs/<id>/run.jsonl      where it ran and what happened after (A5.3 attribution)
 *
 * The outcome join is the interesting one: `prompt-rendered` carries the id, version and
 * rendered_hash; `prompt-outcome` events land on that hash — sometimes days later. So
 * "how has this prompt actually been doing" is a scan of the run logs, never a tally
 * someone has to remember to increment.
 *
 * reconstructRender() answers the question the log deliberately does not store: what did
 * the agent ACTUALLY read? The rendered text is recomputed from the pinned template plus
 * the recorded context, then PROVEN by re-hashing to the recorded rendered_hash. An
 * unverified reconstruction is reported as unverified rather than shown as fact. Since
 * system-map 0.1 the hash covers the prompt as SENT (skill hint + outputs contract), and
 * reconstruction rebuilds those from the logged suffix inputs with versioned builders.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import type { Graph } from "../core/graph";
import {
  assemblePrompt,
  expandIncludes,
  frontMatterField,
  operatorInstructionSuffix,
  renderTemplate,
  renderedHash,
  splitFrontMatter,
  suffixBuilders,
} from "../core/template";
import type { LoggedEvent } from "../log/events";
import { rendersReply } from "../engine/replay";
import { deriveHandoff } from "../engine/handoff";
import { outcomesByHash } from "../log/coalesce";
import { readLog } from "../log/write";
import { PromptStore, PromptStoreError } from "./store";

// ---- shape ---------------------------------------------------------------------

export interface Consumer {
  graph: string;
  node: string;
  /**
   * system-map 1c review: set when the node's prompt does not name this prompt but includes it
   * (`{{> id }}`, transitively) — the includer's id. Accepting a revision of this prompt changes
   * what that node runs, too.
   */
  via?: string;
}

export type Verdict = "accept" | "reject";

/** One line of feedback/<id>.jsonl — the reviser's input format (A2.1). */
export interface FeedbackEntry {
  run: string;
  node: string;
  visit: number;
  at: string;
  note: string;
  verdict: Verdict;
  rendered_hash: string;
}

/** One render of this prompt, with whatever outcome has since joined onto its hash. */
export interface OutcomeRow {
  run: string;
  node: string;
  visit: number;
  prompt_version: number;
  /**
   * system-map 1c review: the version of the TEXT that ran — the rendered prompt's version plus
   * every included prompt's ("slice.fix_ci v1 · delivery.fix_ci v2 · slice._design v1"). Group
   * by this, not prompt_version: an included prompt can move while the includer's does not.
   */
  version_key: string;
  /** set on an INDIRECT row: this prompt was included by the rendered prompt `via` */
  via?: string;
  rendered_hash: string;
  at: string;
  verdict_downstream?: string;
  terminal_outcome?: "success" | "failed" | "aborted";
  error?: string;
}

export interface PromptSummary {
  id: string;
  version: number;
  tags: string[];
  /** direct consumers, then indirect ones (`via` an includer) */
  consumers: Consumer[];
  /** direct feedback; `indirect` = feedback on includers' renders that carried this prompt */
  feedback: { count: number; rejects: number; last_at: string | null; indirect: number };
  /** every render that carried this prompt's text; `indirect` of them via an includer */
  outcomes: { renders: number; success: number; failed: number; aborted: number; pending: number; indirect: number };
  proposals: { pending: number; total: number };
}

export interface PromptDetail extends PromptSummary {
  body: string;
  accepted_at: string | null;
  provenance: string | null;
  /** commits touching prompts/<id>.md, newest first — [] outside a git repo */
  history: Array<{ sha: string; at: string; subject: string }>;
  /** this prompt's own feedback, each joined to the version of the text it judged */
  feedback_entries: Array<FeedbackEntry & { version_key?: string }>;
  /** feedback filed on includers' renders that carried this prompt — labelled with `via` */
  indirect_feedback: Array<FeedbackEntry & { via: string; version_key?: string }>;
  /** direct and indirect (`via`) rows */
  outcome_rows: OutcomeRow[];
  /** outcome tallies per version_key — the text that ran, not just the includer's version */
  by_version: Record<string, PromptSummary["outcomes"]>;
}

export interface LibraryPaths {
  /** repo root: git history, and the default for the dirs below */
  root: string;
  promptsDir?: string;
  feedbackDir?: string;
  proposalsDir?: string;
  /** $HOWDAH_HOME/runs — scanned for renders and outcomes */
  runsDir: string;
}

interface Dirs {
  root: string;
  prompts: string;
  feedback: string;
  proposals: string;
  runs: string;
}

function dirs(p: LibraryPaths): Dirs {
  return {
    root: p.root,
    prompts: p.promptsDir ?? join(p.root, "prompts"),
    feedback: p.feedbackDir ?? join(p.root, "feedback"),
    proposals: p.proposalsDir ?? join(p.root, "reviser", "proposals"),
    runs: p.runsDir,
  };
}

// ---- feedback ------------------------------------------------------------------

export function feedbackPath(feedbackDir: string, id: string): string {
  return join(feedbackDir, `${id}.jsonl`);
}

/** Read feedback for one prompt. Unparseable lines are skipped, not fatal. */
export function readFeedback(feedbackDir: string, id: string): FeedbackEntry[] {
  const p = feedbackPath(feedbackDir, id);
  if (!existsSync(p)) return [];
  const out: FeedbackEntry[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as FeedbackEntry);
    } catch {
      /* a hand-edited line should not blind the screen to the rest */
    }
  }
  return out;
}

export interface FeedbackInput {
  run: string;
  node: string;
  visit: number;
  note: string;
  verdict: Verdict;
  rendered_hash: string;
  at?: string;
}

/**
 * Append one feedback entry (A2.2: always attached to a run+node@visit and the rendered
 * instance, so the reviser reflects on evidence rather than on a vague complaint).
 * Validates rather than writing junk the reviser will later choke on.
 */
export function appendFeedback(feedbackDir: string, id: string, input: FeedbackInput): FeedbackEntry {
  const note = input.note?.trim() ?? "";
  if (!note) throw new PromptStoreError("feedback note is empty — there is nothing for the reviser to reflect on");
  if (input.verdict !== "accept" && input.verdict !== "reject")
    throw new PromptStoreError(`bad verdict "${input.verdict}" — want "accept" or "reject"`);
  if (!input.run || !input.node) throw new PromptStoreError("feedback needs the run and node it came from");
  if (!Number.isInteger(input.visit) || input.visit < 1) throw new PromptStoreError(`bad visit: ${input.visit}`);
  if (!input.rendered_hash) throw new PromptStoreError("feedback needs the rendered_hash of the turn it refers to");

  const entry: FeedbackEntry = {
    run: input.run,
    node: input.node,
    visit: input.visit,
    at: input.at ?? new Date().toISOString(),
    note,
    verdict: input.verdict,
    rendered_hash: input.rendered_hash,
  };
  mkdirSync(feedbackDir, { recursive: true });
  appendFileSync(feedbackPath(feedbackDir, id), JSON.stringify(entry) + "\n");
  return entry;
}

// ---- run scanning (the attribution join) ----------------------------------------

export interface RunScan {
  run: string;
  events: LoggedEvent[];
}

/** Every run log under runsDir, read once per request. */
export function scanRuns(runsDir: string): RunScan[] {
  if (!existsSync(runsDir)) return [];
  const out: RunScan[] = [];
  for (const run of readdirSync(runsDir)) {
    const path = join(runsDir, run, "run.jsonl");
    if (!existsSync(path)) continue;
    try {
      out.push({ run, events: readLog(path) });
    } catch {
      /* a corrupt log must not take the library down */
    }
  }
  return out;
}

/** "slice.fix_ci v1 · delivery.fix_ci v2 · slice._design v1" — the version of the text that ran. */
export function versionKey(prompt: string, version: number, includes?: Record<string, number>): string {
  return [`${prompt} v${version}`, ...Object.entries(includes ?? {}).map(([id, v]) => `${id} v${v}`)].join(" · ");
}

type Render = Extract<LoggedEvent, { type: "prompt-rendered" }>;

/**
 * Outcome rows for one prompt id, across every run, oldest render first: renders OF it
 * (direct) and renders of prompts that included it (indirect, `via` the includer).
 */
export function outcomeRows(scans: RunScan[], id: string): OutcomeRow[] {
  const rows: OutcomeRow[] = [];
  for (const { run, events } of scans) {
    const joined = outcomesByHash(events);
    for (const e of events) {
      if (e.type !== "prompt-rendered") continue;
      const direct = e.prompt === id;
      if (!direct && !(e.includes && id in e.includes)) continue;
      const o = joined.get(e.rendered_hash);
      rows.push({
        run,
        node: e.node,
        visit: e.visit,
        prompt_version: e.prompt_version,
        version_key: versionKey(e.prompt, e.prompt_version, e.includes),
        ...(direct ? {} : { via: e.prompt }),
        rendered_hash: e.rendered_hash,
        at: e.ts,
        verdict_downstream: o?.verdict_downstream,
        terminal_outcome: o?.terminal_outcome,
        error: o?.error,
      });
    }
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

function tally(rows: OutcomeRow[]): PromptSummary["outcomes"] {
  const t = { renders: rows.length, success: 0, failed: 0, aborted: 0, pending: 0, indirect: 0 };
  for (const r of rows) {
    if (r.via !== undefined) t.indirect++;
    if (r.terminal_outcome === "success") t.success++;
    else if (r.terminal_outcome === "failed") t.failed++;
    else if (r.terminal_outcome === "aborted") t.aborted++;
    else t.pending++; // the run has not ended, so no terminal outcome has joined yet
  }
  return t;
}

function tallyByVersion(rows: OutcomeRow[]): Record<string, PromptSummary["outcomes"]> {
  const groups = new Map<string, OutcomeRow[]>();
  for (const r of rows) groups.set(r.version_key, [...(groups.get(r.version_key) ?? []), r]);
  return Object.fromEntries([...groups].map(([k, rs]) => [k, tally(rs)]));
}

/**
 * What one library request reads once and every prompt's summary shares: the run scans, every
 * render by rendered_hash (feedback joins on the hash) and every prompt's feedback file.
 * Building it per prompt would re-read every run and every feedback file prompts × times.
 */
export interface LibraryIndex {
  scans: RunScan[];
  renders: Map<string, Render>;
  feedback: Map<string, FeedbackEntry[]>;
}

export function libraryIndex(scans: RunScan[], feedbackDir: string, promptIds: string[]): LibraryIndex {
  const renders = new Map<string, Render>();
  for (const { events } of scans) for (const e of events) if (e.type === "prompt-rendered") renders.set(e.rendered_hash, e);
  return { scans, renders, feedback: new Map(promptIds.map((id) => [id, readFeedback(feedbackDir, id)])) };
}

/**
 * Feedback filed on OTHER prompts' renders that carried `id` through an include — the evidence
 * an included prompt (a partial especially, which never renders on its own) has.
 */
export function indirectFeedback(index: LibraryIndex, id: string): PromptDetail["indirect_feedback"] {
  const out: PromptDetail["indirect_feedback"] = [];
  for (const [other, entries] of index.feedback) {
    if (other === id) continue;
    for (const f of entries) {
      const r = index.renders.get(f.rendered_hash);
      if (r?.includes && id in r.includes) out.push({ ...f, via: r.prompt, version_key: versionKey(r.prompt, r.prompt_version, r.includes) });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

// ---- git history (A1.1: git is the version history) ------------------------------

/** unit separator: safe in a commit subject in a way that tabs and pipes are not */
const SEP = "\x1f";

export function promptHistory(root: string, id: string): PromptDetail["history"] {
  const r = spawnSync("git", ["log", "--format=%H%x1f%aI%x1f%s", "--", join("prompts", `${id}.md`)], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status !== 0 || !r.stdout) return []; // not a repo, or the file was never committed
  return r.stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const [sha = "", at = "", ...rest] = l.split(SEP);
      return { sha: sha.slice(0, 8), at, subject: rest.join(SEP) };
    });
}

// ---- proposals (counted here, detailed in proposals.ts) --------------------------

function proposalCounts(proposalsDir: string, id: string): PromptSummary["proposals"] {
  if (!existsSync(proposalsDir)) return { pending: 0, total: 0 };
  let pending = 0;
  let total = 0;
  for (const f of readdirSync(proposalsDir)) {
    if (!f.startsWith(`${id}.v`) || !f.endsWith(".proposal.md")) continue;
    total++;
    const { frontmatter } = splitFrontMatter(readFileSync(join(proposalsDir, f), "utf8"));
    if (frontMatterField(frontmatter, "status") === "pending") pending++;
  }
  return { pending, total };
}

// ---- summaries + detail ----------------------------------------------------------

/**
 * The graph nodes that run this prompt: directly (`def.prompt === id`) and — given a store to
 * expand with — through includes (`via` the includer), following nested includes. A node whose
 * prompt's includes cannot be expanded is skipped here (codegen refuses such a library).
 */
export function consumersOf(graphs: Graph<any>[], id: string, store?: PromptStore): Consumer[] {
  const direct: Consumer[] = [];
  const indirect: Consumer[] = [];
  const includedBy = new Map<string, string[]>();
  const closure = (prompt: string): string[] => {
    let c = includedBy.get(prompt);
    if (c === undefined) {
      try {
        c = store ? expandIncludes(store.load(prompt).body, (i) => store.load(i).body, [prompt]).included : [];
      } catch {
        c = [];
      }
      includedBy.set(prompt, c);
    }
    return c;
  };
  for (const g of graphs) {
    for (const [node, def] of Object.entries(g.def.nodes)) {
      if (def.kind !== "agent") continue;
      if (def.prompt === id) direct.push({ graph: g.def.name, node });
      else if (closure(def.prompt).includes(id)) indirect.push({ graph: g.def.name, node, via: def.prompt });
    }
  }
  return [...direct, ...indirect];
}

function tagsOf(frontmatter: string | null): string[] {
  const raw = frontMatterField(frontmatter, "tags");
  if (!raw) return [];
  return raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function summaryFor(d: Dirs, graphs: Graph<any>[], index: LibraryIndex, id: string, store: PromptStore): PromptSummary {
  const file = store.load(id);
  const { frontmatter } = splitFrontMatter(readFileSync(store.path(id), "utf8"));
  const feedback = index.feedback.get(id) ?? readFeedback(d.feedback, id);
  const indirect = indirectFeedback(index, id);
  return {
    id,
    version: file.version,
    tags: tagsOf(frontmatter),
    consumers: consumersOf(graphs, id, store),
    feedback: {
      count: feedback.length,
      rejects: feedback.filter((f) => f.verdict === "reject").length,
      last_at: feedback.at(-1)?.at ?? null,
      indirect: indirect.length,
    },
    outcomes: tally(outcomeRows(index.scans, id)),
    proposals: proposalCounts(d.proposals, id),
  };
}

/**
 * Every prompt, with its consumers, feedback and outcome tallies. Ordered most-actionable
 * first: pending proposals, then unaddressed rejects, then id — the screen should open on
 * what is waiting for you (R2: nothing changes until you look, so make looking easy).
 */
export function promptSummaries(
  paths: LibraryPaths,
  graphs: Graph<any>[],
  // the store MUST default out of `paths`: defaulting to the repo prompts dir would silently
  // ignore a caller-supplied promptsDir and list the wrong library
  store = new PromptStore(dirs(paths).prompts),
): PromptSummary[] {
  const d = dirs(paths);
  const ids = store.list();
  const index = libraryIndex(scanRuns(d.runs), d.feedback, ids);
  const summaries = ids.map((id) => summaryFor(d, graphs, index, id, store));
  return summaries.sort((a, b) => {
    if (a.proposals.pending !== b.proposals.pending) return b.proposals.pending - a.proposals.pending;
    if (a.feedback.rejects !== b.feedback.rejects) return b.feedback.rejects - a.feedback.rejects;
    return a.id.localeCompare(b.id);
  });
}

export function promptDetail(
  paths: LibraryPaths,
  graphs: Graph<any>[],
  id: string,
  store = new PromptStore(dirs(paths).prompts),
): PromptDetail {
  const d = dirs(paths);
  const index = libraryIndex(scanRuns(d.runs), d.feedback, store.list());
  const file = store.load(id);
  const { frontmatter } = splitFrontMatter(readFileSync(store.path(id), "utf8"));
  const rows = outcomeRows(index.scans, id);
  const summary = summaryFor(d, graphs, index, id, store);
  return {
    ...summary,
    body: file.body,
    accepted_at: frontMatterField(frontmatter, "accepted"),
    provenance: frontMatterField(frontmatter, "provenance"),
    history: promptHistory(d.root, id),
    feedback_entries: (index.feedback.get(id) ?? readFeedback(d.feedback, id)).map((f) => {
      const r = index.renders.get(f.rendered_hash);
      return r ? { ...f, version_key: versionKey(r.prompt, r.prompt_version, r.includes) } : f;
    }),
    indirect_feedback: indirectFeedback(index, id),
    outcome_rows: rows,
    by_version: tallyByVersion(rows),
  };
}

// ---- rendered-instance reconstruction -------------------------------------------

export interface ReconstructedRender {
  prompt: string;
  prompt_version: number;
  node: string;
  visit: number;
  rendered_hash: string;
  text: string;
  /** re-hash matched the recorded rendered_hash — the text is exactly what the agent read */
  verified: boolean;
  context_read: Record<string, unknown>;
}

/**
 * Rebuild the rendered prompt for one turn from the run's PINNED template plus the
 * context it recorded reading, and prove it by re-hashing.
 *
 * Legal shapes are tried, because the engine appends an operator instruction to the next
 * render after a jump: no jump, then each operator-jump that preceded this render on this
 * node (most recent first). Anything else comes back `verified: false` — the text is still
 * the best available reconstruction, and the caller must say so.
 *
 * system-map 0.1: an event carrying `suffix_version` was hashed over the prompt AS SENT,
 * so each candidate is rebuilt through the same assemblePrompt() the engine used, with
 * that version's builders and the logged skills / output_keys. An event WITHOUT the field
 * predates 0.1 — its hash covered template (+ jump suffix) only — and is rebuilt exactly
 * that way, so old runs stay VERIFIED. A version this code has no builders for is never
 * guessed at: unverified, plain template text.
 *
 * system-map 0.2: a v2+ render may also carry an operator reply suffix, so each reply on
 * this node that preceded the render AND that rendersReply() accepts for the ask it
 * answered is a candidate too. resume()'s own resolutions and replies to non-renderable
 * parks never are — the engine never renders them.
 * Only versions with a reply builder get reply candidates; v1 and legacy events are
 * rebuilt exactly as before.
 *
 * HOW-14: a v4+ render that carried the context re-entry briefing logged
 * `reentry_after_visit`, its input. It is fed to every candidate as-is — it is a recorded
 * fact about this render, not one more thing to try.
 */
export function reconstructRender(runDir: string, renderedHashWanted: string): ReconstructedRender | null {
  const logPath = join(runDir, "run.jsonl");
  if (!existsSync(logPath)) return null;
  const events = readLog(logPath);
  const render = events.find((e) => e.type === "prompt-rendered" && e.rendered_hash === renderedHashWanted);
  if (!render || render.type !== "prompt-rendered") return null;

  const pinned = join(runDir, "prompts", `${render.prompt}.md`);
  if (!existsSync(pinned)) return null; // the pinned snapshot is the only honest source
  const { body } = splitFrontMatter(readFileSync(pinned, "utf8"));

  // context_read holds exactly the keys the template consumed, so resolution cannot miss.
  // HOW-37: by the render's OWN rules — v1 (absent) for every pre-HOW-37 render, v2 with the
  // logged cap, eliding exactly the keys the engine logged as elided, with the same stubs
  const sources = render.context_sources ?? {};
  const { text: plain } = renderTemplate(body, (key) => render.context_read[key], {
    version: render.render_version ?? 1,
    ...(render.context_cap !== undefined ? { cap: render.context_cap } : {}),
    elideOnly: new Set(Object.keys(sources)),
    sourceOf: (key) => sources[key] ?? "in this run's log",
  });

  const jumpMessages = events
    .filter((e) => e.type === "operator-jump" && e.to === render.node && e.seq < render.seq && e.message)
    .map((e) => (e as Extract<LoggedEvent, { type: "operator-jump" }>).message!)
    .reverse(); // most recent jump first — that is the one the engine would have consumed
  const jumpOptions: (string | undefined)[] = [undefined, ...jumpMessages];

  // system-map 0.2: a reply renders only by rendersReply(ask, resolution) — the same rule
  // replay applies — so each resolution is paired with the ask it answered
  const replyMessages: string[] = [];
  let ask: Extract<LoggedEvent, { type: "attention-raised" }> | null = null;
  for (const e of events) {
    if (e.seq >= render.seq) break;
    if (e.type === "attention-raised") ask = e;
    else if (e.type === "operator-jump") ask = null;
    else if (e.type === "attention-resolved") {
      const message = e.node === render.node ? rendersReply(ask, e) : null;
      if (message !== null) replyMessages.unshift(message); // most recent first, as with jumps
      ask = null;
    }
  }

  // system-map 1c: a refused proposal's reason renders into the node's next attempt — the
  // candidates are the refusals logged on that node before this render, most recent first
  const refusalMessages = events
    .filter((e): e is Extract<LoggedEvent, { type: "node-finished" }> => e.type === "node-finished" && e.node === render.node && e.seq < render.seq && e.refused !== undefined)
    .map((e) => e.refused!)
    .reverse();

  const carriedSteers = (render.steers_carried ?? []).map((seq) => {
    const e = events.find((x) => x.seq === seq);
    return e?.type === "operator-steered" ? e.text : null;
  });
  const stopEvent = render.resumed_after_stop === undefined ? undefined : events.find((x) => x.seq === render.resumed_after_stop);
  const stopResumeText = stopEvent?.type === "soft-stop-honored" ? stopEvent.last_message : render.resumed_after_stop === undefined ? null : undefined;
  let candidates: string[];
  const builders = render.suffix_version === undefined ? undefined : suffixBuilders(render.suffix_version);
  const handoff = render.reentry_after_visit !== undefined && (render.suffix_version ?? 0) >= 5
    ? deriveHandoff(events.filter((e) => e.seq < render.seq), render.node, render.reentry_after_visit, render.output_keys ?? [])
    : undefined;
  if (render.suffix_version === undefined) {
    // pre-0.1 event: the hash never covered the skill hint or outputs contract
    candidates = jumpOptions.map((m) => (m === undefined ? plain : plain + operatorInstructionSuffix(m)));
  } else if (
    builders &&
    (render.reentry_after_visit === undefined || builders.reentryInstruction) &&
    // a carried steer this code cannot word, or one whose event is gone, is not reconstructable
    (carriedSteers.length === 0 || (builders.steerInstruction && carriedSteers.every((t) => t !== null))) &&
    // a stop-resume briefing whose event is gone, or that this version cannot word, is not either
    (render.resumed_after_stop === undefined || (builders.stopResumeInstruction && typeof stopResumeText === "string")) &&
    // a stacked briefing this version cannot word is not reconstructable
    (render.stacked_on === undefined || builders.stackedInstruction)
  ) {
    const suffixVersion = render.suffix_version;
    const assemble = (jumpMessage?: string, replyMessage?: string, refusalMessage?: string) =>
      assemblePrompt({
        body: plain, jumpMessage, replyMessage, refusalMessage,
        // HOW-14: LOGGED, not guessed — so it is the same input for every candidate, not another axis
        reentryAfterVisit: render.reentry_after_visit,
        // HOW-36: re-derived from the very events the engine derived it from (all before the render)
        ...(handoff ? { handoff } : {}),
        // HOW-47: the same for carried steers — the seqs are logged, the texts are their events'
        steerMessages: carriedSteers.filter((t): t is string => t !== null),
        // HOW-48: likewise the stop-resume briefing — its text is the named event's last_message
        stopResumeMessage: stopResumeText ?? undefined,
        // HOW-57: the stacked briefing's input is logged, like reentry_after_visit
        ...(render.stacked_on ? { stackedOn: render.stacked_on } : {}),
        skills: render.skills ?? [], outputKeys: render.output_keys ?? [], suffixVersion,
      });
    // [plain, ...jumps, ...replies] — never both: a jump clears any pending reply (replay.ts),
    // and v1 has no reply builder, so a v1 render cannot have carried one. A refusal (v3+) comes
    // with no jump (a jump drops it) and with or without a reply.
    const base = [
      ...jumpOptions.map((m) => assemble(m)),
      ...(builders.replyInstruction ? replyMessages.map((m) => assemble(undefined, m)) : []),
    ];
    const refused = builders.refusalInstruction
      ? refusalMessages.flatMap((r) => [assemble(undefined, undefined, r), ...replyMessages.map((m) => assemble(undefined, m, r))])
      : [];
    candidates = [...base, ...refused];
  } else {
    // a suffix version this code never had, or a re-entry it could not have rendered — do not guess
    candidates = [];
  }
  const verifiedText = candidates.find((c) => renderedHash(c) === renderedHashWanted);

  return {
    prompt: render.prompt,
    prompt_version: render.prompt_version,
    node: render.node,
    visit: render.visit,
    rendered_hash: render.rendered_hash,
    text: verifiedText ?? candidates[0] ?? plain,
    verified: verifiedText !== undefined,
    context_read: render.context_read,
  };
}

/** The repo root, from this file's location — the default for LibraryPaths.root. */
export function repoRoot(): string {
  return dirname(dirname(new URL(import.meta.url).pathname));
}
