/**
 * `evidence:screenshot` (HOW-52) against a real preview process and the real headless browser:
 * N paths produce N PNGs plus console.txt, the preview's process group is gone afterwards, and
 * every way it cannot look is `not-checked` or `failed` with a reason — never a silent pass.
 *
 * The capture tests need chrome-headless-shell (Playwright's browser cache, or $HOWDAH_BROWSER);
 * on a machine without one they are skipped, and the not-checked test below proves what the
 * built-in reports there instead.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceBuiltinExecutor } from "./evidence";
import { commandExecutor } from "./worktree";
import { findHeadlessBrowser } from "./cdp";
import { worktreeRecordPath } from "./worktree-record";
import { EventLog } from "../../log/write";
import { EVIDENCE_MAX_PATHS, evidenceFileName, isEvidencePath, type EvidenceResult, type PreviewContract } from "../../core/evidence";
import type { ExecArgs } from "../run";

const BROWSER = findHeadlessBrowser();

/** a tiny static app: every path is a page; /broken logs a console error; writes its pid */
function previewApp(): { dir: string; pidFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "howdah-preview-app-"));
  const pidFile = join(dir, "server.pid");
  writeFileSync(join(dir, "server.ts"), `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    if (process.env.HOWDAH_HOME?.includes("howdah-preview-home-") !== true) throw new Error("not a temp HOWDAH_HOME");
    Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch(req) {
      const path = new URL(req.url).pathname;
      const script = path === "/broken" ? "<script>console.error('the panel threw')</script>"
        : path === "/slow" ? "<script>setTimeout(() => { console.error('late'); document.body.className = 'ready'; }, 900)</script>" : "";
      return new Response("<html><body style='background:#fff'><h1>" + path + "</h1>" + script + "</body></html>", { headers: { "content-type": "text/html" } });
    } });
  `);
  return { dir, pidFile };
}

function runWith(worktree: string): EventLog {
  const runDir = mkdtempSync(join(tmpdir(), "howdah-evidence-run-"));
  writeFileSync(worktreeRecordPath(runDir), JSON.stringify({ path: worktree, branch: "howdah/r", repo: "/repos/app" }));
  return new EventLog(join(runDir, "run.jsonl"));
}

function args(log: EventLog, def: Record<string, unknown> = {}): ExecArgs {
  return {
    nodeId: "implementation.evidence", visit: 1, attemptId: "implementation.evidence#1", runId: "r", reads: {}, log,
    def: { kind: "command", run: "evidence:screenshot", writes: { "evidence.items": { scope: "per-visit" } }, ...def },
    effects: { claim: () => false, done: () => {} },
  } as ExecArgs;
}

const result = (r: { writes: Record<string, unknown> }) => r.writes["evidence.items"] as EvidenceResult;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const previewFor = (p: PreviewContract | undefined) => (repo: string) => (repo === "/repos/app" ? p : undefined);

describe("evidence:screenshot", () => {
  test.skipIf(!BROWSER)("N paths → N PNGs plus console.txt in the RUN dir; console errors counted; the process group is gone", async () => {
    const app = previewApp();
    const log = runWith(app.dir);
    const exec = evidenceBuiltinExecutor({ previewFor: previewFor({ command: `bun ${join(app.dir, "server.ts")}`, paths: ["/", "/broken"] }), renderWaitMs: 200 });
    const r = await exec(args(log));
    expect(r.status).toBe("succeeded");
    const ev = result(r);
    expect(ev.outcome).toBe("captured");
    expect(ev.items.map((i) => i.file)).toEqual(["evidence/implementation.evidence@1/01-index.png", "evidence/implementation.evidence@1/02-broken.png"]);
    const runDir = join(log.path, "..");
    for (const i of ev.items) {
      const png = readFileSync(join(runDir, i.file));
      expect([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
      expect(i.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    }
    expect(ev.items.map((i) => i.console_errors)).toEqual([0, 1]);
    expect(ev.items[1]!.console_sample[0]).toContain("the panel threw");
    expect(readFileSync(join(runDir, ev.console_file!), "utf8")).toContain("the panel threw");
    // not in the worktree, where the agent could edit it or commit it
    expect(existsSync(join(app.dir, "evidence"))).toBe(false);
    // the preview never took the operator's port
    expect(ev.items[0]!.url).not.toContain(":4711/");
    const pid = Number(readFileSync(app.pidFile, "utf8"));
    await Bun.sleep(100);
    expect(alive(pid)).toBe(false);
  }, 60_000);

  test.skipIf(!BROWSER)("two previews at once each take their own free port — no collision", async () => {
    const a = previewApp();
    const b = previewApp();
    const run = (app: ReturnType<typeof previewApp>) =>
      evidenceBuiltinExecutor({ previewFor: previewFor({ command: `bun ${join(app.dir, "server.ts")}`, paths: ["/"] }), renderWaitMs: 100 })(args(runWith(app.dir)));
    const [ra, rb] = await Promise.all([run(a), run(b)]);
    expect(result(ra).outcome).toBe("captured");
    expect(result(rb).outcome).toBe("captured");
    expect(result(ra).items[0]!.url).not.toBe(result(rb).items[0]!.url);
  }, 60_000);

  test.skipIf(!BROWSER)("a preview that never becomes ready is FAILED with a reason — the attempt still succeeds — and is killed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-preview-hang-"));
    const pidFile = join(dir, "pid");
    const exec = evidenceBuiltinExecutor({ previewFor: previewFor({ command: `echo $$ > ${pidFile}; sleep 60`, paths: ["/"] }), readyTimeoutMs: 800 });
    const r = await exec(args(runWith(dir)));
    expect(r.status).toBe("succeeded");
    expect(result(r)).toMatchObject({ outcome: "failed", items: [] });
    expect(result(r).reason).toMatch(/did not answer http:\/\/127\.0\.0\.1:\d+\/ within 1s/);
    await Bun.sleep(100);
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  }, 30_000);

  test.skipIf(!BROWSER)("a preview command that exits early says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-preview-exit-"));
    const r = await evidenceBuiltinExecutor({ previewFor: previewFor({ command: "echo boom >&2; exit 3", paths: ["/"] }) })(args(runWith(dir)));
    expect(result(r)).toMatchObject({ outcome: "failed" });
    expect(result(r).reason).toContain("exited (code 3)");
  }, 30_000);

  test.skipIf(!BROWSER)("readyWhen holds the capture until the app says its real screen is up", async () => {
    const app = previewApp();
    const contract = (readyWhen?: string) => ({ command: `bun ${join(app.dir, "server.ts")}`, paths: ["/slow"], renderWaitMs: 50, ...(readyWhen ? { readyWhen } : {}) });
    const eager = result(await evidenceBuiltinExecutor({ previewFor: previewFor(contract()) })(args(runWith(app.dir))));
    expect(eager.items[0]!.console_errors).toBe(0); // captured before the page finished drawing
    const patient = result(await evidenceBuiltinExecutor({ previewFor: previewFor(contract("document.body.className === 'ready'")) })(args(runWith(app.dir))));
    expect(patient.items[0]!.console_errors).toBe(1); // it waited, so it saw what the page did
  }, 60_000);

  test("no preview contract → not-checked, saying how to configure one; nothing is spawned", async () => {
    const r = await evidenceBuiltinExecutor({ previewFor: () => undefined, browser: () => "/bin/false" })(args(runWith(mkdtempSync(join(tmpdir(), "e-")))));
    expect(r.status).toBe("succeeded");
    expect(result(r)).toMatchObject({ outcome: "not-checked", items: [] });
    expect(result(r).reason).toContain("howdah workspace preview");
  });

  test("no headless browser → not-checked, never a pass", async () => {
    const r = await evidenceBuiltinExecutor({ previewFor: previewFor({ command: "true", paths: ["/"] }), browser: () => null })(args(runWith(mkdtempSync(join(tmpdir(), "e-")))));
    expect(result(r)).toMatchObject({ outcome: "not-checked" });
    expect(result(r).reason).toContain("no headless browser");
  });

  test("a node declaring a write the built-in cannot produce is refused before anything runs", async () => {
    const r = await evidenceBuiltinExecutor({ previewFor: () => undefined })(args(runWith(mkdtempSync(join(tmpdir(), "e-"))), { writes: { "evidence.items": { scope: "per-visit" }, review_verdict: { scope: "cleared" } } }));
    expect(r).toMatchObject({ status: "failed" });
    expect((r as { reason: string }).reason).toContain("cannot produce review_verdict");
  });

  test("the command executor dispatches it", async () => {
    const r = await commandExecutor({ evidence: { previewFor: () => undefined } })(args(runWith(mkdtempSync(join(tmpdir(), "e-")))));
    expect(result(r as { writes: Record<string, unknown> }).outcome).toBe("not-checked");
  });
});

describe("the evidence contract", () => {
  test("file names are slugs of the path, numbered; the viewer serves only evidence/ files", () => {
    expect(evidenceFileName("/", 0)).toBe("01-index");
    expect(evidenceFileName("/run/abc?tab=chat", 1)).toBe("02-run-abc-tab-chat");
    expect(isEvidencePath("evidence/n@1/01-index.png")).toBe(true);
    expect(isEvidencePath("evidence/../run.jsonl")).toBe(false);
    expect(isEvidencePath("run.jsonl")).toBe(false);
    expect(isEvidencePath("evidence/n@1/x.sh")).toBe(false);
    expect(EVIDENCE_MAX_PATHS).toBe(8);
  });
});
