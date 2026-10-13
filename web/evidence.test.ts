/**
 * HOW-52 — the evidence file route serves a run's screenshots and nothing else, and the
 * workspace preview contract round-trips through config.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../log/write";
import { createHowdahServer } from "./server";
import { previewFor, setPreview, type HowdahConfig } from "../config/config";

describe("GET /api/runs/:id/file/evidence/…", () => {
  test("serves a screenshot; refuses traversal, other extensions and a symlink out of the folder", async () => {
    const home = mkdtempSync(join(tmpdir(), "howdah-evfile-"));
    const runDir = join(home, "runs", "r1");
    new EventLog(join(runDir, "run.jsonl")).append({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
    const dir = join(runDir, "evidence", "n@1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-index.png"), "\x89PNG fake");
    writeFileSync(join(home, "secret.txt"), "secret");
    symlinkSync(join(home, "secret.txt"), join(dir, "leak.txt"));
    const server = createHowdahServer({ runsDir: join(home, "runs"), attentionDir: join(home, "attention"), port: 0, graphs: {} });
    const get = (p: string) => fetch(`http://localhost:${server.port}/api/runs/r1/file/${p}`);
    try {
      const ok = await get("evidence/n%401/01-index.png");
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("image/png");
      // a URL parser normalises `..` and `%2e%2e` segments away before any route sees them, so
      // those never come back as the log; encoded SLASHES survive parsing and reach the guard
      for (const p of ["evidence/n%401/../../run.jsonl", "evidence/n%401/%2e%2e/%2e%2e/run.jsonl"])
        expect(await (await get(p)).text()).not.toContain("run-started");
      expect((await get("evidence/n%401%2F..%2F..%2Frun.jsonl")).status).toBe(400);
      expect((await get("evidence/n%401/x.sh")).status).toBe(400);
      expect((await get("evidence/n%401/leak.txt")).status).toBe(400);
      expect((await get("evidence/n%401/missing.png")).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});

describe("the workspace preview contract", () => {
  const config = (): HowdahConfig => ({ repos: { app: { path: "/repos/app" } }, folders: { notes: { path: "/n" } } } as HowdahConfig);

  test("set, normalised, read back by path; a blank command clears it", () => {
    const c = config();
    setPreview(c, "app", " bun run web ", ["/", "runs", " "]);
    expect(previewFor(c, "/repos/app")).toEqual({ command: "bun run web", paths: ["/", "/runs"] });
    setPreview(c, "app", "", []);
    expect(previewFor(c, "/repos/app")).toBeUndefined();
  });

  test("refused for a Plain folder, an unknown name, or a command with no path", () => {
    expect(() => setPreview(config(), "notes", "x", ["/"])).toThrow(/Plain folder/);
    expect(() => setPreview(config(), "nope", "x", ["/"])).toThrow(/unknown repo workspace/);
    expect(() => setPreview(config(), "app", "x", [" "])).toThrow(/at least one path/);
  });
});
