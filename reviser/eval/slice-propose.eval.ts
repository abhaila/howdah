#!/usr/bin/env bun
/**
 * T14 — the slice.propose eval (system-map 1c, Eval D12/11A). Follows delivery-publish.eval.ts:
 * a deterministic checklist over what the REAL proposer produces from the stock prompt.
 *
 *   bun reviser/eval/slice-propose.eval.ts --score-only                 fixture case (graphs/fixtures/slice-repo)
 *   bun reviser/eval/slice-propose.eval.ts --score-only --repo <dir> --goal <text> [--work <text>]
 *                                          [--comment <entity-id>=<text>]  plus a personal-repo snapshot
 *
 * Each case runs two rounds through the real `claude` CLI (plan mode, read-only), exactly as a
 * run would render them (engine/executors/map.ts proposerMapText + core/template.ts
 * assemblePrompt): round 1 on the ticket, round 2 with the case's pinned comments as feedback.
 *
 * Scores (per case, and in total):
 *   schema pass rate   rounds whose output validates as a GhostSet against the base (map/ghosts.ts)
 *   % ids valid        ghost ids that fit the base: modify/remove/keep exist, add parses and is new
 *   % comments addressed  the redraw changed what the comment pinned (or met the case's own check)
 * The first scored run is recorded as the baseline (slice-propose.baseline.json); later runs
 * print the delta against it.
 *
 * It spends tokens, so it NEVER runs in `bun test` (not a *.test.ts file, and it refuses with
 * HOWDAH_STUB set); without --score-only it only prints usage. The scoring functions are pure
 * and exported — slice-propose.eval.test.ts pins them without any agent.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { extract } from "../../map/extract";
import { assemble } from "../../map/assemble";
import { MapStore } from "../../map/store";
import { EDGE_KINDS, parseKey } from "../../map/keys";
import { validateGhostSet, ghostEdgeId, type GhostSet } from "../../map/ghosts";
import type { AssembledMap } from "../../map/types";
import { proposerMapText } from "../../engine/executors/map";
import { parseOutputs } from "../../engine/executors/outputs";
import { DEFAULT_CONTEXT_CAP, RENDER_VERSION, SUFFIX_VERSION, assemblePrompt, expandIncludes, renderTemplate, splitFrontMatter } from "../../core/template";
import type { FeedbackItem } from "../../engine/slice-decision";
import { sliceRepo, COMMENT_V1, SLICE_GOAL, SLICE_WORK, DELETE_ROUTE } from "../../graphs/slice-fixture";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..", "..");
export const BASELINE_PATH = join(HERE, "slice-propose.baseline.json");

// ---- scoring (pure) ------------------------------------------------------------------------

/** An untrusted edge's id, or null when its kind is not an edge kind (then it cannot be valid). */
function rawEdgeId(e: Record<string, unknown>): string | null {
  const kind = EDGE_KINDS.find((k) => k === e.kind);
  return kind === undefined ? null : ghostEdgeId({ from: String(e.from), to: String(e.to), kind });
}

export interface IdScore {
  valid: number;
  total: number;
  invalid: string[];
}

/** Every ghost id checked against the base: the rule validateGhostSet applies, id by id. */
export function scoreIds(raw: unknown, base: AssembledMap): IdScore {
  const g = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<Record<keyof GhostSet, unknown>>;
  const entityKeys = new Set(base.entities.map((e) => e.key));
  const blockKeys = new Set(base.blocks.map((b) => b.key));
  const edgeKeys = new Set(base.edges.map((e) => e.key));
  const items: Array<{ id: string; op: unknown; exists: boolean; badKind?: boolean }> = [];
  const list = (v: unknown) => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
  for (const b of list(g.blocks)) items.push({ id: String(b.id), op: b.op, exists: blockKeys.has(String(b.id)) });
  for (const e of list(g.entities)) items.push({ id: String(e.id), op: e.op, exists: entityKeys.has(String(e.id)) });
  for (const e of list(g.edges)) {
    const id = rawEdgeId(e);
    items.push({ id: id ?? `${String(e.from)}→${String(e.to)}:${String(e.kind)}`, op: e.op, exists: id !== null && edgeKeys.has(id), badKind: id === null });
  }
  const invalid = items.filter((i) => i.badKind || (i.op === "add" ? !parseKey(i.id).ok || i.exists : !i.exists)).map((i) => i.id);
  return { valid: items.length - invalid.length, total: items.length, invalid };
}

/** Did the ghost set change what `entityId` pins (op/fields changed, or the item dropped)? */
export function changedAt(v1: unknown, v2: unknown, entityId: string): boolean {
  const find = (g: unknown) => {
    const s = (typeof g === "object" && g !== null ? g : {}) as Record<string, unknown>;
    const all = [
      ...(Array.isArray(s.blocks) ? s.blocks : []),
      ...(Array.isArray(s.entities) ? s.entities : []),
    ] as Array<Record<string, unknown>>;
    const edges = (Array.isArray(s.edges) ? s.edges : []) as Array<Record<string, unknown>>;
    return (
      all.find((x) => x.id === entityId) ??
      edges.find((e) => rawEdgeId(e) === entityId) ??
      null
    );
  };
  return JSON.stringify(find(v1)) !== JSON.stringify(find(v2));
}

export interface EvalComment {
  entity_id: string;
  text: string;
  /** a case-specific check that the redraw answered it; default: the pinned item changed */
  addressedWhen?: (v2: GhostSet) => boolean;
}

export interface RoundScore {
  schemaPass: boolean;
  errors: string[];
  ids: IdScore;
}

export function scoreRound(raw: unknown, base: AssembledMap): RoundScore {
  const checked = validateGhostSet(raw, base);
  return { schemaPass: checked.ok, errors: checked.ok ? [] : checked.errors, ids: scoreIds(raw, base) };
}

export function scoreComments(v1: unknown, v2: unknown, comments: readonly EvalComment[], base: AssembledMap): { addressed: number; total: number } {
  const checked = validateGhostSet(v2, base);
  const addressed = comments.filter((c) => (c.addressedWhen ? checked.ok && c.addressedWhen(checked.ghosts) : changedAt(v1, v2, c.entity_id))).length;
  return { addressed, total: comments.length };
}

export interface CaseScore {
  name: string;
  rounds: RoundScore[];
  comments: { addressed: number; total: number };
}

export interface Totals {
  schema_pass_rate: number;
  ids_valid_pct: number;
  comments_addressed_pct: number;
}

const pct = (n: number, d: number) => (d === 0 ? 100 : Math.round((n / d) * 1000) / 10);

export function totals(cases: readonly CaseScore[]): Totals {
  const rounds = cases.flatMap((c) => c.rounds);
  return {
    schema_pass_rate: pct(rounds.filter((r) => r.schemaPass).length, rounds.length),
    ids_valid_pct: pct(rounds.reduce((n, r) => n + r.ids.valid, 0), rounds.reduce((n, r) => n + r.ids.total, 0)),
    comments_addressed_pct: pct(cases.reduce((n, c) => n + c.comments.addressed, 0), cases.reduce((n, c) => n + c.comments.total, 0)),
  };
}

// ---- cases ---------------------------------------------------------------------------------

export interface EvalCase {
  name: string;
  repo: string;
  goal: string;
  work: string;
  comments: EvalComment[];
}

/** The fixture ticket; the operator's comment asks for the web half, answered by a web fetch site. */
export function fixtureCase(): EvalCase {
  return {
    name: "fixture: delete-user slice",
    repo: sliceRepo().dir,
    goal: SLICE_GOAL,
    work: SLICE_WORK,
    comments: [
      {
        ...COMMENT_V1,
        addressedWhen: (v2) => v2.entities.some((e) => e.op === "add" && e.block === "web" && e.kind === "fetch-site" && e.id.endsWith(`|${DELETE_ROUTE}`)),
      },
    ],
  };
}

/** Whether a baseline has been recorded — said on every invocation, so its absence is never silent. */
export function baselineStatus(path = BASELINE_PATH): string {
  if (!existsSync(path)) return "no baseline yet — run with --score-only to record one (it spends tokens)";
  const b = JSON.parse(readFileSync(path, "utf8")) as Totals & { recorded_at: string };
  return `baseline (${b.recorded_at}): schema pass ${b.schema_pass_rate}% · ids valid ${b.ids_valid_pct}% · comments addressed ${b.comments_addressed_pct}%`;
}

// ---- running the real proposer --------------------------------------------------------------

function renderPropose(neighbourhood: string, goal: string, work: string, feedback: FeedbackItem[]): string {
  const bodyOf = (id: string) => splitFrontMatter(readFileSync(join(ROOT, "prompts", `${id}.md`), "utf8")).body;
  const { text: body } = expandIncludes(bodyOf("slice.propose"), bodyOf, ["slice.propose"]); // as a run pins it
  const values: Record<string, unknown> = { goal, work, "map.neighbourhood": neighbourhood, "slice.feedback": feedback };
  const { text } = renderTemplate(body, (k) => {
    if (!(k in values)) throw new Error(`slice.propose reads ${k}, which the eval does not supply`);
    return values[k];
  }, { version: RENDER_VERSION, cap: DEFAULT_CONTEXT_CAP, exempt: new Set(["goal", "work"]) }); // the engine's rules (HOW-37)
  return assemblePrompt({ body: text, skills: [], outputKeys: ["slice.ghosts"], suffixVersion: SUFFIX_VERSION });
}

function askClaude(prompt: string, cwd: string): unknown {
  const r = Bun.spawnSync(["claude", "-p", "--output-format", "text", "--permission-mode", "plan"], {
    cwd,
    stdin: new TextEncoder().encode(prompt),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const text = new TextDecoder().decode(r.stdout);
  if (r.exitCode !== 0) throw new Error(`claude failed (${r.exitCode}): ${new TextDecoder().decode(r.stderr).slice(0, 300)}`);
  const parsed = parseOutputs(text, ["slice.ghosts"]);
  return parsed.ok ? parsed.writes["slice.ghosts"] : { unparseable: parsed.problem };
}

async function runCase(c: EvalCase): Promise<CaseScore> {
  const store = new MapStore();
  const { manifest } = await extract({ repoDir: c.repo, store });
  const base = assemble(manifest, store);
  const { text } = proposerMapText(base, c.goal, c.work);
  console.log(`\n== ${c.name} (${base.entities.length} entities) — round 1`);
  const v1 = askClaude(renderPropose(text, c.goal, c.work, []), c.repo);
  const r1 = scoreRound(v1, base);
  if (c.comments.length === 0) return { name: c.name, rounds: [r1], comments: { addressed: 0, total: 0 } };
  console.log(`== ${c.name} — round 2 (${c.comments.length} comment(s))`);
  const feedback: FeedbackItem[] = c.comments.map((m, i) => ({ source: "comment", id: `c${i + 1}`, entity_id: m.entity_id, text: m.text }));
  const v2 = askClaude(renderPropose(text, c.goal, c.work, feedback), c.repo);
  return { name: c.name, rounds: [r1, scoreRound(v2, base)], comments: scoreComments(v1, v2, c.comments, base) };
}

function parseCli(argv: string[]): { scoreOnly: boolean; extra: EvalCase | null } {
  const val = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repo = val("--repo");
  const goal = val("--goal");
  if ((repo === undefined) !== (goal === undefined)) throw new Error("--repo and --goal go together");
  const comments: EvalComment[] = argv.flatMap((a, i) => {
    if (a !== "--comment") return [];
    const raw = argv[i + 1] ?? "";
    const eq = raw.indexOf("=");
    if (eq < 1) throw new Error(`--comment wants <entity-id>=<text>, got "${raw}"`);
    return [{ entity_id: raw.slice(0, eq), text: raw.slice(eq + 1) }];
  });
  return {
    scoreOnly: argv.includes("--score-only"),
    extra: repo && goal ? { name: `personal: ${repo}`, repo, goal, work: val("--work") ?? "", comments } : null,
  };
}

if (import.meta.main) {
  const { scoreOnly, extra } = parseCli(process.argv.slice(2));
  if (!scoreOnly) {
    console.error("usage: bun reviser/eval/slice-propose.eval.ts --score-only [--repo <dir> --goal <text> [--work <text>] [--comment <entity-id>=<text>]...]");
    console.error("runs the real claude CLI (spends tokens) on the stock slice.propose prompt and scores it");
    console.error(baselineStatus());
    process.exit(2);
  }
  if (process.env.HOWDAH_STUB) {
    console.error("HOWDAH_STUB is set: this eval runs real agents and spends tokens — unset it to run");
    process.exit(2);
  }
  const cases = [fixtureCase(), ...(extra ? [extra] : [])];
  const scored: CaseScore[] = [];
  for (const c of cases) scored.push(await runCase(c));

  for (const c of scored) {
    console.log(`\n${c.name}`);
    c.rounds.forEach((r, i) => {
      console.log(`  round ${i + 1}: schema ${r.schemaPass ? "PASS" : "FAIL"} · ids ${r.ids.valid}/${r.ids.total}${r.ids.invalid.length ? ` (invalid: ${r.ids.invalid.slice(0, 5).join(", ")})` : ""}`);
      for (const e of r.errors.slice(0, 5)) console.log(`    - ${e}`);
    });
    if (c.comments.total) console.log(`  comments addressed: ${c.comments.addressed}/${c.comments.total}`);
  }
  const now = totals(scored);
  console.log(`\nSCORE: schema pass ${now.schema_pass_rate}% · ids valid ${now.ids_valid_pct}% · comments addressed ${now.comments_addressed_pct}%`);
  if (!existsSync(BASELINE_PATH)) {
    writeFileSync(BASELINE_PATH, JSON.stringify({ recorded_at: new Date().toISOString(), cases: scored.map((c) => c.name), ...now }, null, 2) + "\n");
    console.log(`baseline recorded → ${BASELINE_PATH}`);
  } else {
    const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Totals & { recorded_at: string };
    const d = (k: keyof Totals) => `${now[k] - base[k] >= 0 ? "+" : ""}${Math.round((now[k] - base[k]) * 10) / 10}`;
    console.log(`vs baseline (${base.recorded_at}): schema ${d("schema_pass_rate")} · ids ${d("ids_valid_pct")} · comments ${d("comments_addressed_pct")}`);
  }
  process.exit(now.schema_pass_rate === 100 ? 0 : 1);
}
