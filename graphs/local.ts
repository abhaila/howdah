/**
 * Local graphs — the ones an operator writes, kept in `$HOWDAH_HOME`, not in this repo.
 *
 * Built-in graphs are protected by TWO things: `validate()` and the compiler, via the
 * generated `PromptId` union and `bun run check`. A graph living under `$HOWDAH_HOME` is
 * outside the repo's tsconfig `include`, so the second protection does not reach it for free.
 * This module is what stands in its place: a local graph is imported, validated, and checked
 * for the one property the union was really protecting — that every agent node names a prompt
 * file that exists. `graphs/typecheck.ts` adds the real compiler pass on demand.
 *
 * The registry invariant bends here, deliberately, and it is worth being explicit about how.
 * `graphs/index.ts` validates at import time so a broken graph fails the REGISTRY rather than
 * a run. That is right for graphs we ship: a broken one is our bug. It is wrong for a graph
 * the operator is halfway through editing — one bad file would brick the launcher and the
 * viewer for every other graph too. So a broken local graph is EXCLUDED from the catalog and
 * REPORTED, never silently runnable. The guarantee "nothing runnable is unvalidated" holds;
 * the guarantee "one bad graph stops everything" is traded for one bad graph stopping itself.
 *
 * Why `$HOWDAH_HOME` and not `graphs/`: an operator's graphs are not edits to this tool's
 * source. Keeping them out means `git pull` on Howdah never conflicts with them, and it means
 * `graphs/index.ts` is never machine-edited — the scaffolder used to string-replace anchors
 * in it and fail with "anchors moved" when they drifted.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Graph } from "../core/graph";

/** kebab-case, and nothing that could escape the graphs dir */
export const LOCAL_NAME = /^[a-z][a-z0-9-]*$/;

export const localGraphsDir = (home: string) => join(home, "graphs");
export const localPromptsDir = (home: string) => join(home, "prompts");

export function localGraphPath(home: string, name: string): string {
  if (!LOCAL_NAME.test(name)) throw new Error(`graph name must be kebab-case: "${name}"`);
  return join(localGraphsDir(home), `${name}.ts`);
}

export function ensureLocalDirs(home: string): void {
  mkdirSync(localGraphsDir(home), { recursive: true });
  mkdirSync(localPromptsDir(home), { recursive: true });
}

export function listLocalGraphNames(home: string): string[] {
  const dir = localGraphsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && LOCAL_NAME.test(f.slice(0, -3)))
    .map((f) => f.slice(0, -3))
    .sort();
}

export function readLocalSource(home: string, name: string): string | null {
  const p = localGraphPath(home, name);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/**
 * Where a prompt id may live, local first. Runs pin prompts at start (OV-2), so this only
 * decides what gets copied INTO the run dir — a pinned run is unaffected by later edits.
 */
export const promptSearchPath = (home: string, repoRoot: string): string[] => [
  localPromptsDir(home),
  join(repoRoot, "prompts"),
];

export function findPromptFile(id: string, dirs: string[]): string | null {
  for (const d of dirs) {
    const p = join(d, `${id}.md`);
    if (existsSync(p)) return p;
  }
  return null;
}

export interface LocalGraphProblem {
  name: string;
  /** what is wrong, in the operator's terms — shown in the UI next to the graph */
  error: string;
}

export interface LoadedLocal {
  graphs: Record<string, Graph<any>>;
  problems: LocalGraphProblem[];
}

/**
 * Import one local graph and prove it is runnable. The module may export anything; the graph
 * is the export whose `def.name` matches the file, falling back to the only Graph exported —
 * matching on the filename first means a file that exports two graphs is unambiguous.
 *
 * The import goes through a COPY IN A FRESH DIRECTORY, and both halves of that are load
 * bearing (each verified, not assumed):
 *
 *   - a copy, because Bun's module cache is keyed on the path and IGNORES a `?v=` query, so
 *     re-importing the real file after a rewrite returns the first version forever. The
 *     editor would validate stale source, and a refused save would keep serving the broken
 *     module it had just rejected — a graph reading as broken with a correct file on disk.
 *   - a fresh directory, because Bun also caches a directory's listing once it has resolved
 *     anything from it: a second uniquely named copy written NEXT TO the first fails with
 *     "Cannot find module", even though the file is right there.
 *
 * The cost is that a local graph cannot use a RELATIVE import — it is evaluated from a temp
 * directory, so `./helper` would not resolve. The scaffold imports `core/graph` by absolute
 * path for exactly this reason, and a relative import surfaces as a plain "does not load:
 * Cannot find module './helper'" rather than anything mysterious.
 */
export async function loadLocalGraph(home: string, name: string, repoRoot: string): Promise<Graph<any>> {
  const path = localGraphPath(home, name);
  if (!existsSync(path)) throw new Error(`no local graph "${name}"`);
  const shadowDir = mkdtempSync(join(tmpdir(), `howdah-graph-${name}-`));
  const shadow = join(shadowDir, `${name}.ts`);
  copyFileSync(path, shadow);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(shadow).href)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`does not load: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    rmSync(shadowDir, { recursive: true, force: true });
  }

  const exported = Object.values(mod).filter((v): v is Graph<any> => v instanceof Graph);
  const graph = exported.find((g) => g.def.name === name) ?? (exported.length === 1 ? exported[0] : undefined);
  if (!graph)
    throw new Error(
      exported.length === 0
        ? `exports no graph — the file must export a defineGraph(...) value`
        : `exports ${exported.length} graphs and none is named "${name}"; name one after the file`,
    );
  if (graph.def.name !== name) throw new Error(`declares name "${graph.def.name}" but the file is ${name}.ts`);

  graph.validateOrThrow();

  // the property the PromptId union protects for built-ins, checked directly for local ones
  const dirs = promptSearchPath(home, repoRoot);
  const missing = Object.entries(graph.def.nodes)
    .filter(([, n]) => n.kind === "agent")
    .map(([id, n]) => [id, (n as { prompt: string }).prompt] as const)
    .filter(([, prompt]) => findPromptFile(prompt, dirs) === null);
  if (missing.length)
    throw new Error(
      missing.map(([node, prompt]) => `node "${node}" names prompt "${prompt}", which has no .md file`).join("; "),
    );

  return graph;
}

/** every local graph that loads, plus a reason for each that does not — never throws */
export async function loadLocalGraphs(home: string, repoRoot: string): Promise<LoadedLocal> {
  const graphs: Record<string, Graph<any>> = {};
  const problems: LocalGraphProblem[] = [];
  for (const name of listLocalGraphNames(home)) {
    try {
      graphs[name] = await loadLocalGraph(home, name, repoRoot);
    } catch (err) {
      problems.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { graphs, problems };
}

/**
 * Write source and prove the result loads, restoring the previous bytes if it does not. The
 * file on disk is therefore always a graph that ran the gate — an operator never gets a
 * half-saved graph that the launcher then refuses.
 */
export async function saveLocalSource(
  home: string,
  name: string,
  source: string,
  repoRoot: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const path = localGraphPath(home, name);
  const previous = existsSync(path) ? readFileSync(path, "utf8") : null;
  ensureLocalDirs(home);
  writeFileSync(path, source);
  try {
    await loadLocalGraph(home, name, repoRoot);
    return { ok: true };
  } catch (err) {
    if (previous === null) unlinkSync(path);
    else writeFileSync(path, previous);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function deleteLocalGraph(home: string, name: string): boolean {
  const p = localGraphPath(home, name);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}
