#!/usr/bin/env bun
/**
 * HOW-57 S1 [→EVAL] — does the REAL plan.propose choose sensible `until`s?
 *
 *   bun reviser/eval/plan-until.eval.ts --score-only
 *
 * One BE/FE case: a feature that spans an `api` repo (this run's own workspace) and a `web` repo,
 * where the web consumes the api's generated OpenAPI client and the api work is naturally a
 * stack. The stock prompt is rendered exactly as a run would (core/template.ts) and sent through
 * the real `claude` CLI in plan mode. Scores, all deterministic over the returned plan:
 *
 *   valid          the plan passes validateSlicePlan (so ≤ 1 published, never across repos)
 *   cross-repo     every web → api dependency is `package` (the FE needs the published client,
 *                  not just the merge)
 *   same-repo      at least one same-repo dependency is `published` (a stack was used where one
 *                  slice builds on another's code)
 *
 * It spends tokens, so it NEVER runs in `bun test` (not a *.test.ts file, and it refuses with
 * HOWDAH_STUB set). `scoreUntils` is pure and pinned by plan-until.eval.test.ts.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseOutputs } from "../../engine/executors/outputs";
import { DEFAULT_CONTEXT_CAP, RENDER_VERSION, SUFFIX_VERSION, assemblePrompt, expandIncludes, renderTemplate, splitFrontMatter } from "../../core/template";
import { validateSlicePlan, type SlicePlan } from "../../graphs/slice-plan";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..", "..");

export const OPTS = { knownWorkspaces: ["api", "web"], parentWorkspace: "api" };

export interface UntilScore {
  valid: boolean;
  errors: string[];
  /** web → api dependencies, and how many of them are `package` */
  crossRepo: { total: number; package: number };
  /** same-repo dependencies, and how many are `published` */
  sameRepo: { total: number; published: number };
  pass: boolean;
}

/** Score one proposed plan. Pure: the plan is whatever the model returned. */
export function scoreUntils(raw: unknown, opts = OPTS): UntilScore {
  const checked = validateSlicePlan(raw, opts);
  if (!checked.ok) return { valid: false, errors: checked.errors, crossRepo: { total: 0, package: 0 }, sameRepo: { total: 0, published: 0 }, pass: false };
  const plan: SlicePlan = checked.plan;
  const ws = new Map(plan.slices.map((s) => [s.id, s.workspace ?? opts.parentWorkspace]));
  const crossRepo = { total: 0, package: 0 };
  const sameRepo = { total: 0, published: 0 };
  for (const s of plan.slices)
    for (const d of s.depends_on) {
      const mine = ws.get(s.id);
      const theirs = ws.get(d.slice);
      if (mine === theirs) {
        sameRepo.total++;
        if (d.until === "published") sameRepo.published++;
      } else if (mine === "web" && theirs === "api") {
        crossRepo.total++;
        if (d.until === "package") crossRepo.package++;
      }
    }
  const pass = crossRepo.total > 0 && crossRepo.package === crossRepo.total && sameRepo.published > 0;
  return { valid: true, errors: [], crossRepo, sameRepo, pass };
}

export const CASE = {
  goal: "Users can export their invoices as CSV from the billing page",
  work: [
    "Two repos: `api` (this run's own workspace — Kotlin + http4k + Flyway) and `web` (React + TypeScript).",
    "The api publishes an OpenAPI package that the web consumes for its types; web never hand-rolls API shapes.",
    "Backend: a migration adding an export_jobs table, then an endpoint POST /invoices/export that builds on it, then GET /invoices/export/{id}.",
    "Frontend: an Export button on the billing page that calls the new endpoints through the generated client, and a download toast.",
  ].join("\n"),
};

function render(): string {
  const bodyOf = (id: string) => splitFrontMatter(readFileSync(join(ROOT, "prompts", `${id}.md`), "utf8")).body;
  const { text: body } = expandIncludes(bodyOf("plan.propose"), bodyOf, ["plan.propose"]);
  const values: Record<string, unknown> = {
    goal: CASE.goal,
    work: CASE.work,
    "map.base": "(eval: no snapshot)",
    "map.neighbourhood": "(eval: no map — plan from the brief)",
    "plan.feedback": [],
  };
  const { text } = renderTemplate(body, (k) => {
    if (!(k in values)) throw new Error(`plan.propose reads ${k}, which the eval does not supply`);
    return values[k];
  }, { version: RENDER_VERSION, cap: DEFAULT_CONTEXT_CAP, exempt: new Set(["goal", "work"]) });
  return assemblePrompt({ body: text, skills: [], outputKeys: ["plan.slices"], suffixVersion: SUFFIX_VERSION });
}

if (import.meta.main) {
  if (!process.argv.includes("--score-only")) {
    console.error("usage: bun reviser/eval/plan-until.eval.ts --score-only");
    console.error("runs the real claude CLI (spends tokens) on the stock plan.propose prompt and scores its `until` choices");
    process.exit(2);
  }
  if (process.env.HOWDAH_STUB) {
    console.error("HOWDAH_STUB is set: this eval runs real agents and spends tokens — unset it to run");
    process.exit(2);
  }
  const r = Bun.spawnSync(["claude", "-p", "--output-format", "text", "--permission-mode", "plan"], {
    stdin: new TextEncoder().encode(render()),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  if (r.exitCode !== 0) throw new Error(`claude failed (${r.exitCode}): ${new TextDecoder().decode(r.stderr).slice(0, 300)}`);
  const parsed = parseOutputs(new TextDecoder().decode(r.stdout), ["plan.slices"]);
  const score = scoreUntils(parsed.ok ? parsed.writes["plan.slices"] : { unparseable: parsed.problem });
  console.log(JSON.stringify(score, null, 2));
  process.exit(score.pass ? 0 : 1);
}
