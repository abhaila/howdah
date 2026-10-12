/**
 * `evidence:screenshot` (HOW-52) — the command built-in that LOOKS at the change before it is
 * reviewed. A sibling of `verify:run` (HOW-12): that one runs the tests, this one starts the
 * workspace's preview from the run's worktree and captures each configured path, so the
 * reviewer reads what the screen shows instead of the builder's account of it.
 *
 *   1. the workspace's preview contract (config.json `repos.<name>.preview`, core/evidence.ts)
 *      is started in the worktree, in its OWN process group, on a FREE port (the operator's
 *      viewer already holds 4711) and with a TEMP `HOWDAH_HOME` — it must never read or touch
 *      the operator's real runs;
 *   2. it is polled over HTTP until it answers;
 *   3. each path (≤ EVIDENCE_MAX_PATHS, at EVIDENCE_VIEWPORT) is captured over CDP after the
 *      load event, a DOM-ready check and a fixed render pause — NEVER network idle, which a
 *      page holding an SSE stream never reaches (engine/executors/cdp.ts);
 *   4. PNGs and console.txt go to `<run dir>/evidence/<node>@<visit>/` and `evidence.items` is
 *      published; the process group is killed in a `finally`, timeout or not.
 *
 * Outcomes follow verify's rule: a preview that will not start is `failed` and the attempt
 * still SUCCEEDS (it is evidence for the reviewer, not an executor error); no contract or no
 * browser is `not-checked` with a reason saying how to fix it — never a silent pass, never a
 * park. Refused BEFORE anything is spawned: a node declaring a write other than `evidence.items`.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AttemptResult, Executor } from "../run";
import { probeGit } from "../reconcile";
import { effectiveCwd, readWorktreeRecord } from "./worktree-record";
import { declaredWrites } from "./map";
import { signalGroup } from "./shell";
import { findHeadlessBrowser, freePort, openBrowser } from "./cdp";
import {
  EVIDENCE_BUILTIN, EVIDENCE_KEY, EVIDENCE_MAX_PATHS, EVIDENCE_PRODUCES, EVIDENCE_VIEWPORT, evidenceFileName,
  type EvidenceItem, type EvidenceResult, type PreviewContract,
} from "../../core/evidence";

export { EVIDENCE_BUILTIN, EVIDENCE_PRODUCES } from "../../core/evidence";

export function isEvidenceBuiltin(run: string): boolean {
  return run.trim().split(/\s+/)[0] === EVIDENCE_BUILTIN;
}

export interface EvidenceBuiltinOpts {
  /** the workspace's preview contract for a repo path — injected (cli/main.ts reads config.json) */
  previewFor?: (repoPath: string) => PreviewContract | undefined;
  /** the headless browser binary; default findHeadlessBrowser() */
  browser?: () => string | null;
  /** how long the preview gets to answer (default 60s); a node's `timeoutMs` is the whole budget */
  readyTimeoutMs?: number;
  /** the pause after DOM-ready before a capture (default 1500ms) */
  renderWaitMs?: number;
}

const HOW_TO_CONFIGURE =
  'register one with `howdah workspace preview <name> "<command>" --paths "/,/runs"`, or set ' +
  '"preview": { "command": …, "paths": […] } on the repo in $HOWDAH_HOME/config.json';

export function evidenceBuiltinExecutor(opts: EvidenceBuiltinOpts = {}): Executor {
  return async (args) => {
    const { def, nodeId, visit, log, cwd } = args;
    if (def.kind !== "command") throw new Error("evidence built-in on a non-command node");
    const extra = def.run.trim().split(/\s+/).slice(1);
    if (extra.length) return failed(`${EVIDENCE_BUILTIN} takes no arguments (got "${extra.join(" ")}") — the preview comes from the workspace`);
    const producible = EVIDENCE_PRODUCES as readonly string[];
    const unproducible = Object.keys(def.writes ?? {}).filter((k) => !producible.includes(k));
    if (unproducible.length)
      return failed(`${EVIDENCE_BUILTIN} cannot produce ${unproducible.join(", ")} — it publishes only ${producible.join(", ")}. Nothing was run.`);

    let index = 0;
    const chunk = (kind: "tool_call" | "tool_result" | "text", content: string) =>
      log.append({ type: "chunk", node: nodeId, visit, turn: 1, index: index++, kind, content });
    const publish = (result: EvidenceResult): AttemptResult => {
      chunk("tool_result", result.outcome === "captured"
        ? `captured ${result.items.length} screen${result.items.length === 1 ? "" : "s"}${result.items.some((i) => i.console_errors) ? ` · ${result.items.reduce((n, i) => n + i.console_errors, 0)} console errors` : ""}`
        : `${result.outcome}: ${result.reason}`);
      return { status: "succeeded", writes: declaredWrites(EVIDENCE_BUILTIN, def, { [EVIDENCE_KEY]: result }) };
    };
    const notChecked = (reason: string) => publish({ outcome: "not-checked", items: [], reason });

    const runDir = dirname(log.path);
    const record = readWorktreeRecord(runDir);
    const repo = record?.repo ?? cwd;
    const workDir = effectiveCwd(log.path, cwd);
    if (!repo || !workDir) return notChecked("the run has no repo or worktree to start a preview from, so nothing was looked at");
    const preview = opts.previewFor?.(repo);
    if (!preview?.command?.trim() || !preview.paths?.length)
      return notChecked(`no preview is configured for the workspace at ${repo}, so no screen was captured — ${HOW_TO_CONFIGURE}`);
    const browser = (opts.browser ?? findHeadlessBrowser)();
    if (!browser) return notChecked("no headless browser on this machine (set $HOWDAH_BROWSER, or install Playwright's chromium-headless-shell), so no screen was captured");

    const rel = `evidence/${nodeId}@${visit}`;
    const outDir = join(runDir, rel);
    mkdirSync(outDir, { recursive: true });
    const port = freePort();
    const stateDir = mkdtempSync(join(tmpdir(), "howdah-preview-home-"));
    const command = preview.command.replaceAll("{port}", String(port));
    const git = probeGit(workDir);
    const base: Omit<EvidenceResult, "outcome" | "items"> = { command, commit: git.head, dirty: git.uncommitted > 0 };
    const budget = def.timeoutMs ?? 300_000;
    const started = Date.now();
    const left = () => budget - (Date.now() - started);

    chunk("tool_call", `${command}  (port ${port}, temp HOWDAH_HOME)`);
    const previewLog = join(outDir, "preview.log");
    writeFileSync(previewLog, "");
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: workDir,
      env: { ...process.env, PORT: String(port), HOWDAH_PORT: String(port), HOWDAH_HOME: stateDir, HOWDAH_STUB: "1" },
      stdout: "pipe", stderr: "pipe", detached: true,
    });
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      for await (const b of stream) appendFileSync(previewLog, dec.decode(b, { stream: true }));
    };
    void drain(proc.stdout).catch(() => {});
    void drain(proc.stderr).catch(() => {});
    let exited: number | null | undefined;
    void proc.exited.then((c) => { exited = c; }, () => { exited = null; });

    let page: Awaited<ReturnType<typeof openBrowser>> | null = null;
    try {
      // 1. ready: any HTTP answer below 500 on the ready path
      const readyUrl = `http://127.0.0.1:${port}${preview.readyPath ?? "/"}`;
      const readyBy = Date.now() + Math.min(opts.readyTimeoutMs ?? 60_000, Math.max(0, left()));
      let ready = false;
      while (!ready && Date.now() < readyBy && exited === undefined) {
        try {
          const r = await fetch(readyUrl, { signal: AbortSignal.timeout(2000) });
          await r.body?.cancel();
          ready = r.status < 500;
        } catch { /* not listening yet */ }
        if (!ready) await Bun.sleep(200);
      }
      if (!ready)
        return publish({
          ...base, outcome: "failed", items: [], console_file: `${rel}/preview.log`, console_abs_path: previewLog,
          reason: exited !== undefined
            ? `the preview command exited (${exited === null ? "on a signal" : `code ${exited}`}) before it served ${readyUrl} — see preview.log`
            : `the preview did not answer ${readyUrl} within ${Math.round((readyBy - started) / 1000)}s — see preview.log`,
        });

      // 2. capture each path
      page = await openBrowser(browser, EVIDENCE_VIEWPORT);
      const paths = preview.paths.slice(0, EVIDENCE_MAX_PATHS);
      if (preview.paths.length > paths.length) chunk("text", `capturing the first ${EVIDENCE_MAX_PATHS} of ${preview.paths.length} paths`);
      const items: EvidenceItem[] = [];
      const consoleLines: string[] = [];
      for (const [i, path] of paths.entries()) {
        if (left() <= 0) break;
        const url = `http://127.0.0.1:${port}${path.startsWith("/") ? path : `/${path}`}`;
        const { errors } = await page.visit(url, { renderWaitMs: preview.renderWaitMs ?? opts.renderWaitMs, readyWhen: preview.readyWhen });
        const file = `${rel}/${evidenceFileName(path, i)}.png`;
        writeFileSync(join(runDir, file), await page.screenshot());
        consoleLines.push(`## ${path} (${url})`, ...(errors.length ? errors : ["(no console errors)"]), "");
        items.push({ path, url, file, abs_path: join(runDir, file), captured_at: new Date().toISOString(), console_errors: errors.length, console_sample: errors.slice(0, 3).map((e) => e.slice(0, 300)) });
      }
      writeFileSync(join(outDir, "console.txt"), consoleLines.join("\n"));
      const short = items.length < paths.length;
      return publish({
        ...base,
        outcome: short ? "failed" : "captured",
        items,
        console_file: `${rel}/console.txt`,
        console_abs_path: join(outDir, "console.txt"),
        ...(short ? { reason: `ran out of time after ${items.length} of ${paths.length} paths` } : {}),
      });
    } catch (err) {
      return publish({ ...base, outcome: "failed", items: [], reason: `capture failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      await page?.close().catch(() => {});
      // the whole group: a dev server forks watchers and workers that would outlive bash
      signalGroup(proc.pid, "SIGTERM");
      const gone = await Promise.race([proc.exited.then(() => true), Bun.sleep(2000).then(() => false)]);
      if (!gone) signalGroup(proc.pid, "SIGKILL");
      signalGroup(proc.pid, "SIGKILL"); // children that ignored TERM after bash itself exited
      try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
    }
  };
}

type Failed = AttemptResult & { status: "failed" };
const failed = (reason: string): Failed => ({ status: "failed", writes: {}, reason });
