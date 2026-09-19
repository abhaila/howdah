#!/usr/bin/env bun
/**
 * Howdah viewer server (T11, shaping A9.1): a Bun server over the SAME on-disk run logs
 * the engine writes — storage unchanged, the server is a read model plus one write: the
 * reply. SSE streams new events by tailing the log file.
 *
 *   GET  /api/runs                 run summaries, needs-input first
 *   GET  /api/runs/:id             full detail (thread, timeline, usage, allowance, ask)
 *   GET  /api/runs/:id/events?since=N   SSE of events with seq > N
 *   POST /api/runs/:id/reply       {text} → resolveReply (system-map 0.2): 200 + record cleared, or 409 naming the next step
 *   POST /api/runs/:id/comments    {entity_id, text, proposal_id?} → pin a comment to the current proposal round
 *   POST /api/runs/:id/approval    {approved, proposal_id} → approve, or send the round's comments as feedback
 *   POST /api/runs/:id/redesign    {message} → re-extract and redraw (refused while a runner is live)
 *   (system-map 1a: the same engine/control.ts functions as the CLI verbs; 400 on a malformed
 *   body, 409 {error, code} on a refusal)
 *
 * Run layout: <runsDir>/<run-id>/run.jsonl (the engine's dir option).
 *
 * Local-only surface (system-map 0.4 / eng review issue 1). The reads expose run logs full
 * of proprietary code and the writes can launch an autonomous agent run in any folder, so:
 *   - the server binds 127.0.0.1 only — unbound, Bun listened on every interface (LAN);
 *   - guardRequest() runs before EVERY route. Any request whose Host is not
 *     localhost:<port> / 127.0.0.1:<port> is refused (DNS rebinding: a page on a hostname
 *     that re-resolves to 127.0.0.1 is same-origin to itself, but still sends its own Host);
 *   - a write carrying a foreign Origin is refused (CSRF); a write with NO Origin is a
 *     non-browser client (the CLI, curl, tests) and passes;
 *   - a write carrying a body must be application/json (415 otherwise). A cross-origin page
 *     can POST text/plain or a form without a CORS preflight; it cannot send JSON without
 *     one, and we answer no preflight — so this closes the no-preflight path even for
 *     browsers that omit Origin.
 * The port compared against is the BOUND one (server.port), so port 0 works and a port
 * change cannot lock the UI out of its own writes.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { readLog } from "../log/write";
import { deriveDetail, deriveSummary, deriveTimeline, runDigest, sortRuns, type RunSummary } from "./derive";
import { AttentionCenter } from "../engine/attention";
import { graphCatalog, GRAPHS } from "../graphs/index";
import { ensureHowdahHome, loadConfig, saveConfig } from "../config/config";
import { listGithubRepos, registerGithubRepo } from "../config/github";
import { loadTuning, saveTuning, pruneTuning } from "../config/tuning";
import {
  writeControl, clearControl, interruptRunner, jumpRefusal, markPaused, resolveReply, runnerAlive, approve, sendFeedback, pinComment, redesign, afterDecision, wakeRunner,
  clearAsks, runnerHolder, type DecisionResult,
} from "../engine/control";
import { resolveAgentConfig } from "../engine/run";
import type { Graph } from "../core/graph";
import { EventLog as ControlLog } from "../log/write";
import { effectiveCwd, readWorktreeRecord } from "../engine/executors/worktree";
import { PromptStore } from "../prompts/store";
import {
  appendFeedback, promptDetail, promptSummaries, reconstructRender, repoRoot,
  type LibraryPaths,
} from "../prompts/library";
import { acceptProposal, listProposals, proposalsDir, rejectProposal, viewProposal } from "../prompts/proposals";

export interface ServerOpts {
  runsDir: string;
  attentionDir: string;
  port?: number;
  /** SSE poll interval; small in tests */
  pollMs?: number;
  /** where prompts/, feedback/ and reviser/proposals/ live — overridable so tests that
   *  accept proposals and write feedback cannot mutate the real repo */
  repoRoot?: string;
  /** the graph registry (default graphs/index.ts GRAPHS) — tests pass graphs of their own */
  graphs?: Record<string, Graph<any>>;
  /**
   * starts a detached runner for a run (default: `bun cli/main.ts resume <id>`). Tests inject
   * a recorder: the real one spawns an engine that may spend tokens.
   */
  resumeRun?: (id: string) => void;
}

type EngineTuning = NonNullable<Parameters<typeof resolveAgentConfig>[3]>["tuning"];

const logPath = (runsDir: string, id: string) => join(runsDir, id, "run.jsonl");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** loopback only: see the header — this is the LAN half of system-map 0.4 */
const LOOPBACK = "127.0.0.1";
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The single request guard (system-map 0.4). Returns a response to short-circuit with, or
 * null to let the request through. Order matters only for the error message: Host first
 * (applies to reads too), then Origin, then the body's media type.
 */
export function guardRequest(req: Request, port: number): Response | null {
  const ownHosts = [`localhost:${port}`, `${LOOPBACK}:${port}`];
  const host = (req.headers.get("host") ?? "").toLowerCase();
  if (!ownHosts.includes(host))
    return json({ error: `foreign Host ${host || "(none)"} refused — the viewer only answers to ${ownHosts.join(" or ")}` }, 403);

  if (!WRITE_METHODS.has(req.method)) return null;

  const origin = req.headers.get("origin");
  if (origin !== null && !ownHosts.some((h) => origin === `http://${h}`))
    return json({ error: `foreign Origin ${origin} refused — writes are accepted only from the viewer itself` }, 403);

  const length = Number(req.headers.get("content-length") ?? 0);
  const hasBody = length > 0 || req.headers.has("transfer-encoding");
  if (hasBody) {
    const contentType = req.headers.get("content-type");
    const mediaType = ((contentType ?? "").split(";")[0] ?? "").trim().toLowerCase();
    if (mediaType !== "application/json")
      return json({ error: `content-type ${contentType ?? "(none)"} refused — a write body must be application/json` }, 415);
  }
  return null;
}

/** prompts/, feedback/ and reviser/proposals/ come from the repo; runs come from the server's dir */
const libraryPaths = (opts: ServerOpts): LibraryPaths => ({ root: opts.repoRoot ?? repoRoot(), runsDir: opts.runsDir });

function listRunIds(runsDir: string): string[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).filter((d) => existsSync(logPath(runsDir, d)));
}

function withRunnerLiveness<T extends { status: RunSummary["status"] }>(summary: T, events: ReturnType<typeof readLog>, runDir: string): T {
  if (summary.status !== "running") return summary;
  const hasOpenNode = deriveTimeline(events).some((row) => row.status === "running");
  return hasOpenNode && !runnerAlive(runDir) ? { ...summary, status: "harness-dead" } : summary;
}

export function createHowdahServer(opts: ServerOpts) {
  const pollMs = opts.pollMs ?? 500;
  const root = opts.repoRoot ?? repoRoot();
  const home = dirname(opts.runsDir);
  ensureHowdahHome(home);
  const promptStore = new PromptStore(join(root, "prompts"));
  const graphs = opts.graphs ?? GRAPHS;
  const launchResume =
    opts.resumeRun ??
    ((id: string) =>
      Bun.spawn(["bun", join(import.meta.dir, "..", "cli", "main.ts"), "resume", id], {
        stdout: "ignore", stderr: "ignore", env: { ...process.env },
      }).unref());
  /** explicit operator resume: start a runner unless one is live */
  const spawnResume = (id: string) => {
    if (!runnerAlive(join(opts.runsDir, id))) launchResume(id);
  };
  /**
   * after an answer (reply or decision): make a runner pick it up. Not a blind PID check — a
   * runner exiting within the grace window without consuming the answer is resumed
   * (engine/control.ts wakeRunner). Runs in the background so the response is not held.
   */
  const wake = (id: string) => void wakeRunner(join(opts.runsDir, id), () => launchResume(id)).catch(() => {});
  const decisionResponse = (id: string, result: DecisionResult, status = 200) => {
    if (!result.ok) return json({ error: result.message, code: result.code }, 409);
    // background: wake the runner, then clear the answered asks' attention records
    void afterDecision(join(opts.runsDir, id), result, { attentionDir: opts.attentionDir, spawn: () => launchResume(id) }).catch(() => {});
    return json({ ok: true, proposal_id: result.proposal_id, idempotent: result.idempotent, comment_id: result.comment_id }, status);
  };
  /** a JSON object body, or null (the caller answers 400) */
  const objectBody = async (req: Request): Promise<Record<string, unknown> | null> => {
    const body: unknown = await req.json().catch(() => undefined);
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  };
  return Bun.serve({
    port: opts.port ?? 4711,
    hostname: LOOPBACK,
    idleTimeout: 0,
    async fetch(req, server) {
      // server.port is typed optional only for unix sockets; we always listen on TCP
      const refused = guardRequest(req, server.port ?? opts.port ?? 4711);
      if (refused) return refused;
      const url = new URL(req.url);

      if (url.pathname === "/api/app") {
        return json({
          home,
          runsDir: opts.runsDir,
          attentionDir: opts.attentionDir,
          repoRoot: root,
          configPath: join(home, "config.json"),
          source: root === repoRoot() ? "repo checkout" : "custom repo root",
          supervisorHeartbeat: existsSync(join(home, "heartbeat.json")) ? join(home, "heartbeat.json") : null,
        });
      }

      if (url.pathname === "/api/graphs") return json(graphCatalog());
      const gm = url.pathname.match(/^\/api\/graphs\/([^/]+)(\/tuning)?$/);
      if (gm) {
        const g = graphs[gm[1]!];
        if (!g) return json({ error: "unknown graph" }, 404);

        if (gm[2] === "/tuning" && req.method === "PUT") {
          const body = pruneTuning((await req.json()) as any);
          // only real node ids may be tuned — a typo must not silently no-op
          for (const id of Object.keys(body.nodes ?? {}))
            if (!g.def.nodes[id]) return json({ error: `unknown node "${id}"` }, 400);
          const all = loadTuning();
          if (Object.keys(body).length === 0) delete all[g.def.name];
          else all[g.def.name] = body;
          saveTuning(all);
          return json({ ok: true, tuning: body });
        }

        const tuning = loadTuning()[g.def.name] ?? {};
        const tsDefaults = g.def.defaults ?? {};
        // the engine's own resolution (no run override): what a run would get, readOnly included
        const effectiveOf = (id: string, n: (typeof g.def.nodes)[string]) =>
          n.kind === "agent" ? resolveAgentConfig(g, n, id, { tuning: tuning as EngineTuning }) : undefined;
        return json({
          name: g.def.name,
          description: g.def.description ?? "",
          entry: g.def.entry,
          inputs: g.def.inputs,
          defaults: tsDefaults,
          tuning,
          nodes: Object.entries(g.def.nodes).map(([id, n]) => ({
            id,
            kind: n.kind,
            class: "class" in n ? n.class : undefined,
            prompt: n.kind === "agent" ? n.prompt : undefined,
            run: n.kind === "command" ? n.run : undefined,
            baseline: n.kind === "agent"
              ? { harness: n.harness, model: n.model, effort: n.effort, permissionMode: n.permissionMode, maxTurns: n.maxTurns, skills: n.skills }
              : undefined,
            node_tuning: tuning.nodes?.[id],
            effective: effectiveOf(id, n),
            // effective values drive the DAG subtitles
            harness: effectiveOf(id, n)?.harness,
            model: effectiveOf(id, n)?.model,
            effort: effectiveOf(id, n)?.effort,
            maxVisits: "maxVisits" in n ? n.maxVisits : undefined,
            outcome: n.kind === "terminal" ? n.outcome : undefined,
            duration: n.kind === "wait" ? n.duration : undefined,
          })),
          edges: g.def.edges.map((e) => ({ from: e.from, to: e.to, label: e.condition?.label, weight: e.weight })),
        });
      }
      // ---- prompt library + proposal review (T21) --------------------------------
      // The prompt is the addressable object (R1) and the proposal is the gate nothing
      // passes without you (R2), so these are read models over prompts/, feedback/,
      // reviser/proposals/ and the run logs — plus three writes: feedback, accept, reject.

      if (url.pathname === "/api/prompts") {
        return json(promptSummaries(libraryPaths(opts), Object.values(GRAPHS), promptStore));
      }
      const pm = url.pathname.match(/^\/api\/prompts\/([^/]+)(\/feedback)?$/);
      if (pm) {
        const id = decodeURIComponent(pm[1]!);
        // the id indexes a file path: only ids the store actually lists may be used
        if (!promptStore.list().includes(id)) return json({ error: "unknown prompt" }, 404);
        if (pm[2] === "/feedback" && req.method === "POST") {
          const body = (await req.json()) as Partial<import("../prompts/library").FeedbackInput>;
          try {
            const entry = appendFeedback(join(root, "feedback"), id, {
              run: String(body.run ?? ""),
              node: String(body.node ?? ""),
              visit: Number(body.visit),
              note: String(body.note ?? ""),
              verdict: body.verdict as "accept" | "reject",
              rendered_hash: String(body.rendered_hash ?? ""),
            });
            return json({ ok: true, entry }, 201);
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400);
          }
        }
        return json(promptDetail(libraryPaths(opts), Object.values(GRAPHS), id, promptStore));
      }

      if (url.pathname === "/api/proposals") return json(listProposals(proposalsDir(root), promptStore, root));
      const prm = url.pathname.match(/^\/api\/proposals\/([^/]+)\/(accept|reject|redraft)$/);
      if (prm && req.method === "POST") {
        const file = decodeURIComponent(prm[1]!);
        const dir = proposalsDir(root);
        // basename-only, and it must already exist in the proposals dir — no traversal
        if (file.includes("/") || !file.endsWith(".proposal.md") || !existsSync(join(dir, file)))
          return json({ error: "unknown proposal" }, 404);
        const path = join(dir, file);
        try {
          if (prm[2] === "accept") {
            const version = acceptProposal(path, Object.values(GRAPHS), promptStore);
            return json({ ok: true, version });
          }
          if (prm[2] === "reject") {
            const body = (await req.json().catch(() => ({}))) as { reason?: string };
            const reason = (body.reason ?? "").trim();
            // the reason IS reviser input (it feeds the next reflection), so it is required
            if (!reason) return json({ error: "a rejection reason is required — the reviser reads it" }, 400);
            rejectProposal(path, reason);
            return json({ ok: true });
          }
          // redraft: the reviser is a real agent call that spends tokens, so it is spawned
          // detached exactly like a run launch and the screen polls for the new proposal
          const view = viewProposal(dir, file, promptStore, root);
          if (process.env.HOWDAH_STUB) return json({ ok: true, drafting: view.id, stubbed: true }, 202);
          Bun.spawn(["bun", join(import.meta.dir, "..", "reviser", "revise.ts"), view.id], {
            stdout: "ignore", stderr: "ignore", env: { ...process.env },
          }).unref();
          return json({ ok: true, drafting: view.id }, 202);
        } catch (err) {
          // stale base and undeclared reads are refusals, not bugs: 409 with the message
          return json({ error: err instanceof Error ? err.message : String(err) }, 409);
        }
      }

      if (url.pathname === "/api/settings") {
        if (req.method === "PUT") {
          const body = (await req.json()) as Record<string, unknown>;
          const c = loadConfig();
          for (const k of ["editorCommand", "slackWebhook", "theme", "chime"] as const)
            if (k in body) (c as any)[k] = body[k];
          saveConfig(c);
          return json({ ok: true });
        }
        const { repos, folders, ...settings } = loadConfig();
        return json(settings);
      }
      if (url.pathname === "/api/github/repos") {
        try {
          return json(listGithubRepos(loadConfig(), { query: url.searchParams.get("q") ?? undefined }));
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 502);
        }
      }
      if (url.pathname === "/api/workspaces/github" && req.method === "POST") {
        const body = (await req.json()) as { nameWithOwner?: string };
        if (!body.nameWithOwner) return json({ error: "nameWithOwner required" }, 400);
        try {
          const c = loadConfig();
          const result = registerGithubRepo(c, body.nameWithOwner);
          saveConfig(c);
          return json({ ok: true, kind: "repo", ...result }, 201);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      }
      if (url.pathname === "/api/workspaces") {
        if (req.method === "POST") {
          const body = (await req.json()) as { name?: string; path?: string };
          const name = (body.name ?? "").trim();
          let p = (body.path ?? "").trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
          if (!/^[\w][\w.-]*$/.test(name)) return json({ error: "name must be alphanumeric/dash/dot" }, 400);
          if (!existsSync(p)) return json({ error: `path does not exist: ${p}` }, 400);
          const c = loadConfig();
          if (c.repos[name] || c.folders[name]) return json({ error: `workspace "${name}" already exists` }, 409);
          // the path decides the kind: a git repo gets worktrees + forge probes, else Plain
          const probe = Bun.spawnSync(["git", "-C", p, "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "pipe" });
          if (probe.exitCode === 0 && new TextDecoder().decode(probe.stdout).trim() === "true") {
            const head = Bun.spawnSync(["git", "-C", p, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { stdout: "pipe", stderr: "pipe" });
            const fallback = Bun.spawnSync(["git", "-C", p, "symbolic-ref", "--short", "HEAD"], { stdout: "pipe", stderr: "pipe" });
            const raw = head.exitCode === 0
              ? new TextDecoder().decode(head.stdout).trim().replace(/^origin\//, "")
              : new TextDecoder().decode(fallback.stdout).trim();
            const defaultBranch = raw && raw !== "HEAD" ? raw : "main";
            c.repos[name] = { path: p, defaultBranch };
            saveConfig(c);
            return json({ ok: true, kind: "repo", name, path: p, defaultBranch }, 201);
          }
          c.folders[name] = { path: p };
          saveConfig(c);
          return json({ ok: true, kind: "plain", name, path: p }, 201);
        }
        if (req.method === "DELETE") {
          const body = (await req.json()) as { name?: string };
          const c = loadConfig();
          if (body.name && (c.repos[body.name] || c.folders[body.name])) {
            delete c.repos[body.name];
            delete c.folders[body.name];
            saveConfig(c);
            return json({ ok: true });
          }
          return json({ error: "unknown workspace" }, 404);
        }
        const c = loadConfig();
        return json({
          repos: Object.entries(c.repos).map(([name, r]) => ({ name, ...r })),
          folders: Object.entries(c.folders).map(([name, f]) => ({ name, ...f })),
        });
      }
      if (url.pathname === "/api/runs" && req.method === "POST") {
        // launch: hand off to the CLI, detached — the viewer never owns an engine loop
        const body = (await req.json()) as {
          graph?: string; inputs?: Record<string, string>; workspace?: string; dir?: string;
          overrides?: { model?: string; effort?: string; permissionMode?: string; harness?: string; maxTurns?: number; skills?: string[] };
        };
        if (!body.graph) return json({ error: "graph required" }, 400);
        const runId = `${body.graph}-${Date.now().toString(36)}`;
        const args = ["run", body.graph, "--id", runId];
        for (const [k, v] of Object.entries(body.inputs ?? {})) args.push("-i", `${k}=${v}`);
        if (body.workspace) args.push("--workspace", body.workspace);
        if (body.dir) args.push("--dir", body.dir);
        const o = body.overrides ?? {};
        if (o.model) args.push("--model", o.model);
        if (o.effort) args.push("--effort", o.effort);
        if (o.permissionMode) args.push("--permission-mode", o.permissionMode);
        if (o.harness) args.push("--harness", o.harness);
        if (o.maxTurns) args.push("--max-turns", String(o.maxTurns));
        if (o.skills?.length) args.push("--skills", o.skills.join(","));
        Bun.spawn(["bun", join(import.meta.dir, "..", "cli", "main.ts"), ...args], {
          stdout: "ignore", stderr: "ignore", env: { ...process.env },
        }).unref();
        return json({ id: runId }, 202);
      }

      // the rendered prompt for one turn, rebuilt from the pinned template and proven by
      // re-hashing (T21) — the log stores the hash, never the text, so this is the only
      // honest way to show what the agent actually read (R3.1)
      const rm = url.pathname.match(/^\/api\/runs\/([^/]+)\/render\/([0-9a-f]{4,64})$/);
      if (rm) {
        const runDir = join(opts.runsDir, rm[1]!);
        const render = reconstructRender(runDir, rm[2]!);
        return render ? json(render) : json({ error: "no such render, or its pinned prompt is gone" }, 404);
      }

      const m = url.pathname.match(/^\/api\/runs(?:\/([^/]+)(?:\/(events|reply|open-ide|open-run-folder|resume|pause|abort|jump|ask|comments|approval|redesign))?)?$/);
      if (!m) {
        // static: /public assets by name, everything else → the app shell.
        // no-cache: this is a local app whose bundle changes constantly — the browser must
        // revalidate every load (a cached stale /app.css once served a whole old UI)
        const noCache = { "cache-control": "no-cache" };
        const asset = url.pathname.replace(/^\//, "");
        const file = Bun.file(join(import.meta.dir, "public", asset));
        if (asset && (await file.exists())) return new Response(file, { headers: noCache });
        return new Response(Bun.file(join(import.meta.dir, "public", "index.html")), { headers: noCache });
      }
      const [, id, sub] = m;

      if (!id) {
        const runs = listRunIds(opts.runsDir).map((rid) => {
          const events = readLog(logPath(opts.runsDir, rid));
          return withRunnerLiveness(deriveSummary(rid, events), events, join(opts.runsDir, rid));
        });
        return json(sortRuns(runs));
      }
      const path = logPath(opts.runsDir, id);
      if (!existsSync(path)) return json({ error: "unknown run" }, 404);

      if (sub === "open-ide" && req.method === "POST") {
        const editor = loadConfig().editorCommand;
        if (!editor) return json({ error: "no editor configured — set one in Settings" }, 409);
        const events = readLog(path);
        const started = events.find((e) => e.type === "run-started");
        const target = effectiveCwd(path, started?.type === "run-started" ? started.cwd : undefined);
        if (!target) return json({ error: "run has no folder" }, 404);
        if (!existsSync(target)) return json({ error: "folder is gone (worktree cleaned)" }, 410);
        Bun.spawn([editor, target], { stdout: "ignore", stderr: "ignore" }).unref();
        return json({ ok: true, opened: target });
      }

      if (sub === "open-run-folder" && req.method === "POST") {
        const runDir = join(opts.runsDir, id);
        if (!existsSync(runDir)) return json({ error: "run folder is gone" }, 410);
        const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
        Bun.spawn([opener, runDir], { stdout: "ignore", stderr: "ignore" }).unref();
        return json({ ok: true, opened: runDir });
      }

      if (sub === "reply" && req.method === "POST") {
        const body: unknown = await req.json().catch(() => undefined);
        if (typeof body !== "object" || body === null || Array.isArray(body))
          return json({ error: "body must be a JSON object {text}" }, 400);
        // absent text is the empty reply ("let it through" on a permission ask); anything
        // other than a string is a malformed request, not a 500 from deep in the rules
        const raw = (body as { text?: unknown }).text;
        const text = raw === undefined ? "" : raw;
        if (typeof text !== "string") return json({ error: "text must be a string" }, 400);
        // system-map 0.2: one shared rule set with `howdah reply`; refusals name the next step
        const result = resolveReply(join(opts.runsDir, id), text, { graphs });
        if (!result.ok) return json({ error: result.message, code: result.code }, 409);
        new AttentionCenter(opts.attentionDir, []).resolve(`${id}:${result.node}:${result.visit}`);
        wake(id); // the reply must MOVE the run, not just record the answer
        return json({ ok: true, rendered: result.rendered });
      }

      // ---- approval decisions (system-map 1a) ------------------------------------------
      if (sub === "comments" && req.method === "POST") {
        const body = await objectBody(req);
        if (!body) return json({ error: "body must be a JSON object {entity_id, text, proposal_id?}" }, 400);
        const { entity_id, text, proposal_id } = body;
        if (typeof entity_id !== "string" || entity_id.trim() === "") return json({ error: "entity_id must be a non-empty string" }, 400);
        if (typeof text !== "string" || text.trim() === "") return json({ error: "text must be a non-empty string" }, 400);
        if (proposal_id !== undefined && !Number.isInteger(proposal_id)) return json({ error: "proposal_id must be an integer" }, 400);
        const result = pinComment(join(opts.runsDir, id), entity_id, text, { proposalId: proposal_id as number | undefined });
        if (!result.ok) return json({ error: result.message, code: result.code }, 409);
        return json({ ok: true, proposal_id: result.proposal_id, comment_id: result.comment_id }, 201);
      }

      if (sub === "approval" && req.method === "POST") {
        const body = await objectBody(req);
        if (!body) return json({ error: "body must be a JSON object {approved, proposal_id}" }, 400);
        const { approved, proposal_id } = body;
        if (typeof approved !== "boolean") return json({ error: "approved must be a boolean" }, 400);
        // required: the operator decides on the proposal they SAW, never whatever is current now
        if (!Number.isInteger(proposal_id)) return json({ error: "proposal_id must be an integer" }, 400);
        const runDir = join(opts.runsDir, id);
        const decide = approved ? approve : sendFeedback;
        return decisionResponse(id, decide(runDir, { proposalId: proposal_id as number }));
      }

      if (sub === "redesign" && req.method === "POST") {
        const body = await objectBody(req);
        if (!body) return json({ error: "body must be a JSON object {message}" }, 400);
        const { message } = body;
        if (typeof message !== "string" || message.trim() === "") return json({ error: "message must be a non-empty string" }, 400);
        const runDir = join(opts.runsDir, id);
        const result = redesign(runDir, message, { graphs });
        if (!result.ok) return json({ error: result.message, code: result.code }, 409);
        clearAsks(opts.attentionDir, runDir, result.asks);
        clearControl(runDir); // like jump: the operator now owns where the run goes
        launchResume(id);
        return json({ ok: true, jumped_to: result.jumped_to }, 202);
      }

      if (sub === "resume" && req.method === "POST") {
        clearControl(join(opts.runsDir, id));
        spawnResume(id);
        return json({ ok: true }, 202);
      }

      if (sub === "pause" && req.method === "POST") {
        const runDir = join(opts.runsDir, id);
        writeControl(runDir, "pause");
        markPaused(runDir);
        const interrupted = await interruptRunner(runDir);
        return json({ ok: true, interrupted, note: interrupted ? "paused and interrupted the live runner" : "pause recorded" }, 202);
      }

      if (sub === "abort" && req.method === "POST") {
        const runDir = join(opts.runsDir, id);
        writeControl(runDir, "abort");
        // a live runner aborts at the boundary; a hung/mid-turn one is killed with its agents —
        // interruptRunner signals ONLY a holder PROVEN to be this run's runner (start time
        // matched, or a legacy lock whose argv is cli/main.ts … <this run>): a legacy runner.pid
        // can name any bun process (the supervisor, a test run, another run's runner), and an
        // unknown identity is never a licence to kill. Anything else is left alone; the control
        // file stops a real runner at its next boundary.
        await interruptRunner(runDir);
        const events = readLog(path);
        if (!events.some((e) => e.type === "run-finished"))
          new ControlLog(path).append({ type: "run-finished", outcome: "aborted" });
        return json({ ok: true });
      }

      if (sub === "jump" && req.method === "POST") {
        const body = (await req.json()) as { node?: string; message?: string };
        if (!body.node) return json({ error: "node required" }, 400);
        // refuse in-process (the same precheck `howdah jump` runs) — the jump itself is spawned
        // detached, so a refusal from it would never reach the operator
        const check = jumpRefusal(join(opts.runsDir, id), body.node, graphs);
        if (!check.ok) return json({ error: check.message }, 400);
        const cli = join(import.meta.dir, "..", "cli", "main.ts");
        const args = ["bun", cli, "jump", id, body.node, ...(body.message ? [body.message] : [])];
        Bun.spawn(args, { stdout: "ignore", stderr: "ignore", env: { ...process.env } }).unref();
        return json({ ok: true }, 202);
      }

      if (sub === "ask" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { question?: string };
        const question = (body.question ?? "").trim();
        if (!question) return json({ error: "a question is required" }, 400);

        const events = readLog(path);
        const started = events.find((e) => e.type === "run-started");
        const graph = started?.type === "run-started" ? graphs[started.graph] : undefined;
        let declarations = {};
        try { declarations = graph ? graph.declarations() : {}; } catch { /* still answerable */ }
        const digest = runDigest(id, events, declarations);

        // HOWDAH_STUB short-circuits every token-spending path in this codebase
        if (process.env.HOWDAH_STUB) return json({ answer: `[stubbed] ${question}`, stubbed: true, digest_chars: digest.length });

        const prompt = [
          "You are answering a question about ONE run of an agent harness.",
          "Answer only from the RUN DIGEST below. If the digest does not say, say so plainly.",
          "Refer to steps as node@visit so the reader can find them. Be brief: a short paragraph.",
          "",
          "RUN DIGEST:",
          digest,
          "",
          `QUESTION: ${question}`,
        ].join("\n");

        const res = Bun.spawnSync(
          // no tools, plan mode, and a temp cwd: this must not be able to touch the worktree
          ["claude", "-p", "--output-format", "json", "--permission-mode", "plan"],
          { stdin: new TextEncoder().encode(prompt), stdout: "pipe", stderr: "pipe", cwd: tmpdir(), env: { ...process.env }, timeout: 120_000 },
        );
        if (res.exitCode !== 0)
          return json({ error: `claude -p failed: ${new TextDecoder().decode(res.stderr).trim().slice(0, 300)}` }, 502);
        try {
          const parsed = JSON.parse(new TextDecoder().decode(res.stdout)) as { result?: unknown; is_error?: boolean; total_cost_usd?: number };
          if (parsed.is_error) return json({ error: String(parsed.result).slice(0, 300) }, 502);
          return json({ answer: String(parsed.result ?? ""), cost_usd: parsed.total_cost_usd, digest_chars: digest.length });
        } catch {
          return json({ error: "claude -p returned unparseable output" }, 502);
        }
      }

      if (sub === "events") {
        let since = Number(url.searchParams.get("since") ?? 0);
        let timer: ReturnType<typeof setInterval>;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(": connected\n\n"); // flush headers so clients resolve immediately
            const push = () => {
              try {
                for (const e of readLog(path).filter((e) => e.seq > since)) {
                  controller.enqueue(`data: ${JSON.stringify(e)}\n\n`);
                  since = e.seq;
                }
              } catch {
                /* torn write mid-read: next tick sees it whole */
              }
            };
            push();
            timer = setInterval(push, pollMs);
          },
          cancel() {
            clearInterval(timer);
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
        });
      }

      const events = readLog(path);
      // scopes and declared writers come from the graph, not the log: that is what lets the
      // Context tab list a key no step has reached yet instead of hiding it (CUR5)
      const started = events.find((e) => e.type === "run-started");
      const graph = started?.type === "run-started" ? graphs[started.graph] : undefined;
      let declarations = {};
      try {
        declarations = graph ? graph.declarations() : {};
      } catch {
        /* a graph with conflicting scopes throws; the rest of the run view still renders */
      }
      const detail = deriveDetail(id, events, declarations);
      detail.summary = withRunnerLiveness(detail.summary, events, join(opts.runsDir, id));
      const target = effectiveCwd(path, detail.identity.cwd ?? undefined);
      const runDir = join(opts.runsDir, id);
      const wt = readWorktreeRecord(runDir);
      detail.persistence = {
        home,
        run_dir: runDir,
        log_path: path,
        worktree_path: wt?.path ?? null,
        runner_alive: runnerAlive(runDir),
      };
      return json({
        ...detail,
        cwd_exists: target ? existsSync(target) : false,
        editor_configured: Boolean(loadConfig().editorCommand),
      });
    },
  });
}

/** bundle the React app (with Tailwind) to public/app.js + public/app.css artifacts */
export async function buildApp(): Promise<void> {
  const tailwind = (await import("bun-plugin-tailwind")).default;
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "app", "main.tsx")],
    outdir: join(import.meta.dir, "public"),
    naming: "app.[ext]",
    plugins: [tailwind],
    minify: false,
  });
  if (!result.success) throw new Error("app bundle failed: " + result.logs.join("\n"));
}

if (import.meta.main) {
  await buildApp();
  const base = process.env.HOWDAH_HOME ?? join(homedir(), ".howdah");
  const port = process.env.HOWDAH_PORT ? Number(process.env.HOWDAH_PORT) : undefined;
  const server = createHowdahServer({ runsDir: join(base, "runs"), attentionDir: join(base, "attention"), port });
  console.log(`howdah viewer: http://localhost:${server.port}`);
}
