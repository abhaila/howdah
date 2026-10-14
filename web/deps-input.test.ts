/**
 * HOW-57: `deps` picked in New run. The form sends `[{ run_id, until }]`; the rest comes from
 * the picked run's own log, and every pick that would only fail later — on the stacked run's
 * first step, after the spawn — is refused here instead.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../log/write";
import { parseDeps } from "../core/stack";
import { resolveDepsInput } from "./deps-input";
import { createHowdahServer } from "./server";

const WORKSPACES: Record<string, string> = { "/repos/api": "api", "/repos/web": "web" };

function runsWith(runs: Record<string, string | undefined>) {
  const runsDir = mkdtempSync(join(tmpdir(), "howdah-deps-"));
  for (const [id, cwd] of Object.entries(runs))
    new EventLog(join(runsDir, id, "run.jsonl")).append({ type: "run-started", graph: "implement-ticket", inputs: {}, pinned_prompts: {}, ...(cwd ? { cwd } : {}) });
  return { runsDir, workspaceOf: (cwd: string) => WORKSPACES[cwd] ?? null };
}
const pick = (rows: unknown) => JSON.stringify(rows);

describe("resolveDepsInput", () => {
  const ctx = runsWith({ "be-run": "/repos/api", "be-run-2": "/repos/api", "web-run": "/repos/web", "loose-run": "/tmp/x" });

  test("fills slice and workspace from the picked run's log, in a shape runs:await reads", () => {
    const r = resolveDepsInput(pick([{ run_id: "be-run", until: "published" }, { run_id: "web-run", until: "merged" }]), { ...ctx, workspace: "api" });
    expect(r.ok).toBe(true);
    const deps = parseDeps((r as { deps: string }).deps);
    expect(deps).toEqual({ ok: true, deps: [
      { slice: "be-run", until: "published", run_id: "be-run", workspace: "api" },
      { slice: "web-run", until: "merged", run_id: "web-run", workspace: "web" },
    ] });
  });

  test("anything the browser adds beyond run_id and until is ignored, never trusted", () => {
    const r = resolveDepsInput(pick([{ run_id: "be-run", until: "merged", workspace: "web", slice: "x" }]), { ...ctx, workspace: "api" });
    expect(parseDeps((r as { deps: string }).deps)).toMatchObject({ deps: [{ slice: "be-run", workspace: "api" }] });
  });

  test("every pick that would fail later is refused now, in words", () => {
    const refuse = (rows: unknown, workspace = "api") => (resolveDepsInput(typeof rows === "string" ? rows : pick(rows), { ...ctx, workspace }) as { error: string }).error;
    expect(refuse("merged")).toContain("deps must be the list of runs");
    expect(refuse([])).toBe("pick at least one run for this stacked run to wait for");
    expect(refuse([{ run_id: "", until: "merged" }])).toBe("dependency 1: pick a run");
    expect(refuse([{ run_id: "be-run", until: "soon" }])).toContain('"wait until" must be published, merged, package');
    expect(refuse([{ run_id: "ghost", until: "merged" }])).toBe("no run called ghost");
    expect(refuse([{ run_id: "loose-run", until: "merged" }])).toContain("did not run in a registered workspace");
    expect(refuse([{ run_id: "be-run", until: "merged" }, { run_id: "be-run", until: "published" }])).toBe("be-run is picked twice");
    expect(refuse([{ run_id: "be-run", until: "published" }, { run_id: "be-run-2", until: "published" }])).toContain('only one dependency can be "published"');
    expect(refuse([{ run_id: "web-run", until: "published" }])).toBe("web-run ran in web, so this run (in api) cannot stack on its branch — wait for it to be merged instead");
  });

  test("a merged or package dependency may be in another workspace — that is the BE → FE case", () => {
    expect(resolveDepsInput(pick([{ run_id: "be-run", until: "package" }]), { ...ctx, workspace: "web" }).ok).toBe(true);
  });
});

describe("POST /api/runs refuses a bad pick before anything is spawned", () => {
  test("400 in the resolver's words, and no run dir appears", async () => {
    const home = mkdtempSync(join(tmpdir(), "howdah-deps-route-"));
    const runsDir = join(home, "runs");
    const server = createHowdahServer({ runsDir, attentionDir: join(home, "attention"), port: 0, graphs: {} });
    try {
      const res = await fetch(`http://localhost:${server.port}/api/runs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ graph: "implement-stacked", inputs: { goal: "g", work: "w", deps: pick([{ run_id: "ghost", until: "merged" }]) }, workspace: "api" }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "no run called ghost" });
      expect(existsSync(runsDir) ? readdirSync(runsDir) : []).toEqual([]);
    } finally { server.stop(true); }
  });
});

