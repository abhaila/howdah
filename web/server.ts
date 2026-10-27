#!/usr/bin/env bun
/**
 * Howdah viewer server (T11, shaping A9.1): a Bun server over the SAME on-disk run logs
 * the engine writes — storage unchanged, the server is a read model plus one write: the
 * reply. SSE streams new events by tailing the log file.
 *
 *   GET  /api/runs                 run summaries, needs-input first
 *   GET  /api/runs/:id             full detail (thread, timeline, usage, allowance, ask)
 *   GET  /api/runs/:id/shell       the same detail without the transcript or the log — what the page loads
 *   GET  /api/runs/:id/transcript  a window of coalesced turns (?limit & ?before index, or ?node & ?visit)
 *   GET  /api/runs/:id/logs        a page of log rows, without the stored event (?limit & ?before seq)
 *   GET  /api/runs/:id/event/:seq  one stored event, for the log row's Raw pane
 *   POST /api/runs                 {graph, inputs, workspace?, name?, overrides?} → launch detached; a bad name is 400 before the spawn (HOW-18)
 *   GET  /api/runs/:id/events?since=N   SSE of events with seq > N
 *   POST /api/runs/:id/reply       {text?, answers?} → resolveReply (system-map 0.2): 200 + record cleared, or 409 naming
 *                                  the next step. `answers` is the HOW-25 question card's structured pick.
 *   POST /api/runs/:id/comments    {entity_id, text, proposal_id?} → pin a comment to the current proposal round
 *   POST /api/runs/:id/approval    {approved, proposal_id} → approve, or send the round's comments as feedback
 *   POST /api/runs/:id/redesign    {message} → re-extract and redraw (refused while a runner is live)
 *   POST /api/runs/:id/effects     {effect, verdict, node?} → HOW-3: attest to an ambiguous side effect
 *   PUT  /api/graphs/:name/builder {spec, prompts, intent, fromRun?} → HOW-22: save a graph built in the viewer (201 new / 200 updated / 409 a built-in owns the name / 422 the gate refused).
 *                                  HOW-65: `drafted` is never taken from the client — derived from `fromRun`, kept on an update, else stripped (web/draft.ts)
 *   GET  /api/runs/:id/draft       HOW-65: a draft-graph run's draft, diff, advice and saved state (404 unknown / 409 drafting or refused, with a reason)
 *   POST /api/runs/:id/draft/save  {name} → HOW-65: save the draft as a local graph with provenance (201 / 409 name taken, already saved or discarded / 422 the gate refused)
 *   POST /api/runs/:id/draft/redraft {change} → HOW-66: launch a draft-graph run with --parent this one and this draft as its base (202 {id} / 400 no change / 409 not ready or discarded / 422 too large)
 *   POST /api/runs/:id/draft/discard → HOW-66: append `draft-discarded` (200 {ok, appended}; idempotent / 409 not ready or saved)
 *   GET  /api/local-prompts/:id    HOW-22: the body of a prompt a builder graph owns
 *   GET  /api/attention            HOW-20: the needs-you inbox — every pending ask with its run, reason and wait
 *   GET  /api/ready                HOW-67: the quiet "Ready for you" tier — finished drafts neither saved nor discarded
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
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { LogTail, readLog } from "../log/write";
import { deriveDetail, deriveSummary, deriveTimeline, runDigest, snapshotIndex, sortRuns, type RunSummary, type SnapshotIndex } from "./derive";
import { LiveGitHub, liveTargetOf, type LiveTarget } from "./live-git";
import { softStop, steer } from "../engine/steer";
import { SOFT_STOP_ESCALATE_MS } from "../core/steer";
import { isEvidencePath } from "../core/evidence";
import { waiveCriterion, waiveUnprovable } from "../engine/acceptance-decision";
import { replayState } from "../engine/replay";
import { BoardCache, boardRow } from "./board";
import { RunViewCache } from "./run-view-cache";
import { currentProposal } from "../engine/slice-decision";
import { loadSnapshot } from "../engine/slice-map";
import { MapStore, defaultStoreDir } from "../map/store";
import type { AssembledMap } from "../map/types";
import { AttentionCenter } from "../engine/attention";
import { inboxItems } from "../engine/attention-inbox";
import { graphCatalog, GRAPHS } from "../graphs/index";
import { catalogOf, loadRegistry, type Registry } from "../graphs/registry";
import { deleteLocalGraph, LOCAL_NAME, loadLocalGraph, loadLocalGraphs, localGraphPath, readLocalSource, saveLocalSource } from "../graphs/local";
import { builderProvenance, builtinTaken, discardRunDraft, DRAFT_STATUS, readRunDraft, readyDrafts, redraftRunDraft, saveRunDraft } from "./draft";
import { typecheckLocalGraph } from "../graphs/typecheck";
import { newGraph, type GraphKind } from "../cli/new-graph";
import { readLocalPrompt, saveBuilderGraph } from "../graphs/builder";
import { parseGraphSpec, specOf, SPEC_PROMPT_ID, type DraftBody } from "../core/graph-spec";
import { ensureHowdahHome, howdahHome, loadConfig, saveConfig, typesafeKeyState, workspaceNameFor } from "../config/config";
import { listGithubRepos, registerGithubRepo } from "../config/github";
import { loadTuning, saveTuning, pruneTuning } from "../config/tuning";
import {
  writeControl, clearControl, interruptRunner, jumpRefusal, markPaused, resolveReply, runnerAlive, approve, sendFeedback, pinComment, redesign, afterDecision, wakeRunner,
  clearAsks, runnerHolder, resolveEffect, EFFECT_VERDICTS, type DecisionResult, type EffectVerdict,
} from "../engine/control";
import { resolveAgentConfig } from "../engine/run";
import { defaultHarness, harnessNames, harnessSpec, isHarness } from "../core/harnesses";
import { agentConfigOf, type Graph } from "../core/graph";
import { EventLog as ControlLog } from "../log/write";
import { effectiveCwd, readWorktreeRecord } from "../engine/executors/worktree";
import { PromptStore } from "../prompts/store";
import {
  appendFeedback, promptDetail, promptSummaries, reconstructRender, repoRoot,
  type LibraryPaths,
} from "../prompts/library";
import { acceptProposal, listProposals, proposalsDir, rejectProposal, viewProposal } from "../prompts/proposals";
import { evidenceSource, loadFeedback } from "../reviser/revise";
import { isPartialId } from "../core/template";
import { normalizeRunName } from "../core/run-name";
import { launchArgs, type LaunchRequest } from "../core/launch-args";

/** POST /api/runs body — what the Start-a-run form sends */
export interface LaunchBody {
  graph?: string; inputs?: Record<string, string>; workspace?: string; dir?: string;
  /** HOW-18: optional display label; validated by core/run-name.ts before the spawn */
  name?: unknown;
  overrides?: { model?: string; effort?: string; permissionMode?: string; harness?: string; maxTurns?: number; skills?: string[] };
}

/**
 * The `cli/main.ts run` argv for a launch. HOW-23 moved the builder to core/launch-args.ts,
 * because the `runs:launch` built-in starts runs too and the two must not drift apart; it is
 * re-exported here so this route and everything importing it read exactly as before.
 */
export { launchArgs } from "../core/launch-args";

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
  /**
   * starts the reviser detached with this argv (default: Bun.spawn, unref'd). Tests inject a
   * recorder: the real reviser is an agent call that spends tokens.
   */
  spawnReviser?: (argv: string[]) => void;
  /**
   * opens a real terminal with this argv (default: Bun.spawn, unref'd). Tests inject a
   * recorder: the real one puts a Terminal window on the operator's screen and starts an
   * interactive `claude auth login`, which a test run must never do to the machine running it.
   */
  openTerminal?: (argv: string[]) => void;
  /**
   * HOW-66: starts a run detached with this `cli/main.ts` argv (default: `bun cli/main.ts …`,
   * unref'd). Tests inject a recorder: the real one starts an engine that may spend tokens.
   */
  spawnRun?: (argv: string[]) => void;
  /** HOW-49: how often a watched live step's worktree is probed; small in tests */
  liveGitIntervalMs?: number;
}

/** A prompt id as the library names files (`prompts/<id>.md`) — no separators, no traversal. */
const PROMPT_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]*(\.[A-Za-z0-9_][A-Za-z0-9_-]*)*$/;

type EngineTuning = NonNullable<Parameters<typeof resolveAgentConfig>[3]>["tuning"];

const logPath = (runsDir: string, id: string) => join(runsDir, id, "run.jsonl");

function queryLimit(url: URL, fallback: number, max: number): number {
  const n = Number(url.searchParams.get("limit") ?? fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(max, Math.floor(n));
}

function queryNum(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * How long a run's derived view is reused while its log has not grown. The run page refetches
 * the view on every streamed event and on a 5s timer, several tabs may be open, and a live step
 * streams many events a second: deriving a 55k-event log took 1.3s of the one thread each time,
 * so the server never left 100% CPU. A size-keyed cache with a short ceiling collapses a burst
 * into one derive; the ceiling bounds how stale a fact that is NOT in the log (a runner dying
 * without writing) can read.
 */
const DETAIL_CACHE_MS = 2000;

/** a builder body that is a copy (HOW-63): an object whose ONLY key is a string `copyOf` */
const isCopyBody = (v: unknown): v is { copyOf: string } =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { copyOf?: unknown }).copyOf === "string";

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
  /**
   * Built-ins plus the operator's own from `$HOWDAH_HOME`, re-read per request: local graphs
   * are created and edited while the viewer is open, so a cached registry would show a stale
   * shape and refuse a graph that exists. `opts.graphs` (tests) wins and stays static.
   */
  const registry = async (): Promise<Registry> =>
    opts.graphs
      ? { graphs: opts.graphs, source: Object.fromEntries(Object.keys(opts.graphs).map((n) => [n, "builtin" as const])), problems: [] }
      : loadRegistry(home, root);
  const launchResume =
    opts.resumeRun ??
    ((id: string) =>
      Bun.spawn(["bun", join(import.meta.dir, "..", "cli", "main.ts"), "resume", id], {
        stdout: "ignore", stderr: "ignore", env: { ...process.env },
      }).unref());
  /**
   * HOW-49: the live worktree probe. Only a run with a step in flight AND a proven runner is a
   * target — a dead run's worktree is not "live", and the rail's reconciler reading already
   * covers it. Subscribers are the run's SSE streams, so nobody watching means no git spawns.
   */
  const liveTargets = new Map<string, { size: number; target: LiveTarget | null }>();
  /** the derived run view by run id, reused while the log is the same size and the entry is young (DETAIL_CACHE_MS) */
  const detailCache = new Map<string, { size: number; at: number; body: string }>();
  /** a cache hit is a copy of the serialised view, never a re-stringify of 14 MB */
  const detailResponse = (body: string) => new Response(body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const liveGit = new LiveGitHub({
    intervalMs: opts.liveGitIntervalMs,
    target: (rid) => {
      const p = logPath(opts.runsDir, rid);
      if (!existsSync(p) || !runnerAlive(join(opts.runsDir, rid))) return null;
      // the log is re-read only when it grew: a 15s probe on a 13 MB log is otherwise a full
      // parse each time, for a target that cannot have changed without a new event
      const size = statSync(p).size;
      const cached = liveTargets.get(rid);
      if (cached && cached.size === size) return cached.target;
      const events = readLog(p);
      const started = events.find((e) => e.type === "run-started");
      const target = liveTargetOf(events, effectiveCwd(p, started?.type === "run-started" ? started.cwd : undefined));
      liveTargets.set(rid, { size, target });
      return target;
    },
  });
  const board = new BoardCache();
  /** one incremental fold per run log: shell, transcript and log pages all read it */
  const runViews = new RunViewCache();
  /**
   * The shell document, reused while the non-streaming events and the runner's liveness are
   * unchanged. A text chunk does not rebuild it — the page applies those itself — but the seq
   * and the last timestamps are patched on the way out so a new tab does not replay them.
   */
  const shellCache = new Map<string, { shellCount: number; shellSeq: number; alive: boolean; lastSeq: number; lastAt: string | null; body: string; detail: Record<string, unknown> }>();
  const launchTerminal =
    opts.openTerminal ??
    ((argv: string[]) => Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" }).unref());
  /**
   * HOW-66: the ONE way the viewer starts a run — New run and a draft's Ask for changes both
   * come through here, so the argv is launchArgs' in both and the spawn is the same.
   */
  const startRun = (request: LaunchRequest, runId: string) => {
    const args = launchArgs(request, runId);
    if (opts.spawnRun) opts.spawnRun(args);
    else Bun.spawn(["bun", join(import.meta.dir, "..", "cli", "main.ts"), ...args], {
      stdout: "ignore", stderr: "ignore", env: { ...process.env },
    }).unref();
  };
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
  /**
   * HOW-65: a run's draft against today's registry and the operator's own graphs. With a test
   * registry (`opts.graphs`) the locals are loaded on their own, since that registry has none.
   */
  const runDraft = async (rid: string) => {
    const reg = await registry();
    return readRunDraft({ runsDir: opts.runsDir, runId: rid, home, root, graphs: reg.graphs, locals: await localGraphs(reg) });
  };
  /** the operator's own graphs — who saved which draft (`savedAs`), for the card and HOW-67's tier alike */
  const localGraphs = async (reg?: Registry) => {
    if (opts.graphs) return (await loadLocalGraphs(home, root)).graphs;
    const r = reg ?? (await registry());
    return Object.fromEntries(Object.entries(r.graphs).filter(([n]) => r.source[n] === "local"));
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

      if (url.pathname === "/api/graphs" && req.method === "GET") {
        const reg = await registry();
        // a local graph that does not load is REPORTED beside the catalog, never just absent
        return json({ graphs: catalogOf(reg), problems: reg.problems });
      }
      if (url.pathname === "/api/graphs" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { name?: unknown; kind?: unknown };
        const name = typeof body.name === "string" ? body.name : "";
        const kind = typeof body.kind === "string" ? body.kind : "custom";
        if (!LOCAL_NAME.test(name)) return json({ error: `graph name must be kebab-case: "${name}"` }, 400);
        if (!["doc", "research", "code", "custom"].includes(kind)) return json({ error: `unknown kind "${kind}"` }, 400);
        try {
          const path = await newGraph(name, kind as GraphKind, home, root);
          return json({ ok: true, name, path }, 201);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 422);
        }
      }

      /**
       * HOW-22: save a graph the builder made. Separate from the source route because that
       * one 404s on a graph that does not exist yet, and this is also how one is CREATED.
       *
       * The spec arrives from the network and is written into a module, so nothing is
       * trusted: parseGraphSpec() rebuilds it field by field and drops everything it did not
       * put there, and the built-in collision is refused BEFORE any write — the registry
       * only reports that shadowing after the fact, which is too late to be useful while you
       * are still naming the thing. The body also declares `intent`, because a create and an
       * update are different writes and only the caller knows which one it meant.
       */
      const bm = url.pathname.match(/^\/api\/graphs\/([^/]+)\/builder$/);
      if (bm) {
        const name = bm[1]!;
        if (req.method !== "PUT") return json({ error: "method not allowed" }, 405);
        if (!LOCAL_NAME.test(name)) return json({ error: `graph name must be kebab-case: "${name}"` }, 400);
        if (name in GRAPHS) return json({ error: builtinTaken(name) }, 409);
        const body = await objectBody(req);
        if (!body) return json({ error: "expected a JSON object" }, 400);
        const parsed = parseGraphSpec(body.spec);
        if (!parsed.ok) return json({ error: parsed.error }, 400);
        if (parsed.spec.name !== name) return json({ error: `the spec is named "${parsed.spec.name}" but the path says "${name}"` }, 400);
        const prompts: Record<string, DraftBody> = {};
        const rawPrompts = body.prompts;
        if (rawPrompts !== undefined) {
          if (typeof rawPrompts !== "object" || rawPrompts === null || Array.isArray(rawPrompts))
            return json({ error: "prompts must be an object of id → body" }, 400);
          for (const [id, value] of Object.entries(rawPrompts as Record<string, unknown>)) {
            // HOW-63: text, or `{ "copyOf": "<prompt id>" }` — saveBuilderGraph writes a copy out,
            // and refuses (422) one naming a prompt Howdah does not have
            if (typeof value === "string") prompts[id] = value;
            else if (isCopyBody(value)) prompts[id] = { copyOf: value.copyOf };
            else return json({ error: `the body of "${id}" must be text or { "copyOf": "<prompt id>" }` }, 400);
          }
        }
        // the intent is REQUIRED, not inferred from a stat: a brand-new draft that happened to
        // reuse a name used to REPLACE that graph's module and its prompts (HOW-22 review), and
        // the only thing that can tell the two apart is the caller saying which it meant
        const intent = body.intent;
        if (intent !== "create" && intent !== "update")
          return json({ error: `say whether this is a new graph ("create") or an edit ("update")` }, 400);
        // HOW-65 decision 2: provenance is the SERVER's — a client-sent `drafted` is dropped here
        const fromRun = body.fromRun;
        if (fromRun !== undefined && (typeof fromRun !== "string" || !fromRun || fromRun.includes("/")))
          return json({ error: "fromRun must be a run id" }, 400);
        const provenance = builderProvenance({
          name,
          fromRun: typeof fromRun === "string" ? await runDraft(fromRun) : null,
          existing: intent === "update" && existsSync(localGraphPath(home, name))
            ? await loadLocalGraph(home, name, root).then(specOf).catch(() => null)
            : null,
        });
        if (!provenance.ok) return json({ error: provenance.error }, provenance.status);
        const { drafted: _client, ...clientSpec } = parsed.spec;
        const spec = provenance.drafted ? { ...clientSpec, drafted: provenance.drafted } : clientSpec;
        const saved = await saveBuilderGraph({ home, repoRoot: root, spec, prompts, intent });
        if (saved.ok) return json({ ok: true, name }, intent === "create" ? 201 : 200);
        return json({ error: saved.error }, saved.code === "exists" ? 409 : saved.code === "missing" ? 404 : 422);
      }

      /**
       * HOW-22: the instructions a builder step owns. Only $HOWDAH_HOME/prompts is read —
       * the id is a file name, so it must look like one and can carry no path.
       */
      const lpm = url.pathname.match(/^\/api\/local-prompts\/([^/]+)$/);
      if (lpm) {
        const id = decodeURIComponent(lpm[1]!);
        if (!SPEC_PROMPT_ID.test(id)) return json({ error: `"${id}" is not a prompt id` }, 400);
        const promptBody = readLocalPrompt(home, id);
        return promptBody === null ? json({ error: "no such local prompt", id }, 404) : json({ id, body: promptBody });
      }

      const sm = url.pathname.match(/^\/api\/graphs\/([^/]+)\/(source|typecheck)$/);
      if (sm) {
        const name = sm[1]!;
        if (!LOCAL_NAME.test(name)) return json({ error: "not a local graph" }, 400);
        const path = localGraphPath(home, name);
        if (!existsSync(path)) return json({ error: `no local graph "${name}" — built-in graphs are edited in the repo` }, 404);

        if (sm[2] === "source" && req.method === "GET") return json({ name, path, source: readLocalSource(home, name) });
        if (sm[2] === "source" && req.method === "PUT") {
          const body = (await req.json().catch(() => ({}))) as { source?: unknown };
          if (typeof body.source !== "string") return json({ error: "source must be a string" }, 400);
          // the gate: it must load, validate, and name prompt files that exist, or the bytes
          // on disk are restored — a saved graph is always one the launcher will accept
          const saved = await saveLocalSource(home, name, body.source, root);
          return saved.ok ? json({ ok: true }) : json({ error: saved.error }, 422);
        }
        if (sm[2] === "typecheck" && req.method === "POST") return json(await typecheckLocalGraph(home, name, root));
        return json({ error: "method not allowed" }, 405);
      }

      const gm = url.pathname.match(/^\/api\/graphs\/([^/]+)(\/tuning)?$/);
      if (gm) {
        const name = gm[1]!;
        if (!gm[2] && req.method === "DELETE") {
          if (!LOCAL_NAME.test(name) || !existsSync(localGraphPath(home, name)))
            return json({ error: "only a local graph can be deleted" }, 400);
          deleteLocalGraph(home, name);
          return json({ ok: true });
        }
        const g = (await registry()).graphs[name];
        if (!g) return json({ error: "unknown graph" }, 404);

        if (gm[2] === "/tuning" && req.method === "PUT") {
          const body = pruneTuning((await req.json()) as any);
          // only real node ids may be tuned — a typo must not silently no-op
          for (const id of Object.keys(body.nodes ?? {}))
            if (!g.def.nodes[id]) return json({ error: `unknown node "${id}"` }, 400);
          // HOW-17: and only a harness the table knows. core/ degrades an unknown name to the
          // configured default rather than throwing, so this is not a crash guard — it is so
          // the operator learns their typo here instead of watching every run quietly ignore it.
          for (const cfg of [body.defaults, ...Object.values(body.nodes ?? {})])
            if (cfg?.harness !== undefined && !isHarness(cfg.harness))
              return json({ error: `unknown harness "${cfg.harness}" — have: ${harnessNames().join(", ")}` }, 400);
          const all = loadTuning();
          if (Object.keys(body).length === 0) delete all[g.def.name];
          else all[g.def.name] = body;
          saveTuning(all);
          return json({ ok: true, tuning: body });
        }

        const tuning = loadTuning()[g.def.name] ?? {};
        const tsDefaults = g.def.defaults ?? {};
        // the engine's own resolution (no run override): what a run would get, readOnly included
        // HOW-17: the configured default harness is part of the resolution, so the effective
        // config the UI shows is still the one a run gets
        const configuredDefaultHarness = loadConfig().defaultHarness;
        const effectiveOf = (id: string, n: (typeof g.def.nodes)[string]) =>
          n.kind === "agent" ? resolveAgentConfig(g, n, id, { tuning: tuning as EngineTuning, defaultHarness: configuredDefaultHarness }) : undefined;
        // HOW-22/HOW-26: read the spec ONCE — specOf() re-parses every call — and index the
        // step TITLES out of it. A built graph carries an editable title beside its frozen id,
        // and without this the builder's own preview read "Implement the changes required"
        // while the tuner and every run's DAG read `ask-an-agent-8`. The title is absent for a
        // hand-written graph, where the id IS the name and GraphDag falls back to it.
        const built = specOf(g);
        const titles = new Map((built?.nodes ?? []).map((n) => [n.id, n.title?.trim() || undefined]));
        return json({
          name: g.def.name,
          description: g.def.description ?? "",
          entry: g.def.entry,
          inputs: g.def.inputs,
          defaults: tsDefaults,
          // HOW-22: the spec the builder can re-open, and whether it can. `specOf` re-parses
          // rather than trusting `def.spec`, so a hand-edited file that no longer holds a
          // readable spec reads as `builder: false` instead of opening half-understood.
          spec: built,
          builder: (await registry()).source[name] === "local" && built !== null,
          // what "inherit" means in the tuner, so it names the operator's default rather than
          // a hard-coded "claude"
          default_harness: defaultHarness(configuredDefaultHarness),
          tuning,
          nodes: Object.entries(g.def.nodes).map(([id, n]) => ({
            id,
            title: titles.get(id),
            kind: n.kind,
            class: "class" in n ? n.class : undefined,
            prompt: n.kind === "agent" ? n.prompt : undefined,
            run: n.kind === "command" ? n.run : undefined,
            baseline: n.kind === "agent"
              ? agentConfigOf(n)
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

      /**
       * HOW-20's other half: the notification says a run needs you, this says WHICH and WHY.
       * Read-only — a record leaves disk through the reply, approval and effect routes, never
       * by being looked at — and it filters through the same `stillNeedsHuman` the watchdog
       * rings by, so the screen's count and the banner's count cannot drift apart.
       */
      if (url.pathname === "/api/attention" && req.method === "GET")
        return json(inboxItems({ runsDir: opts.runsDir, attentionDir: opts.attentionDir }));
      /**
       * HOW-67: the QUIET tier — finished drafts nobody has saved or discarded. A separate route
       * on purpose: /api/attention is the list the watchdog rings by, and keeping this out of it
       * is what proves a draft waiting to be looked at can never ring, raise the favicon or go
       * amber. Derived per request, so a Save in another tab clears it on the next poll.
       */
      if (url.pathname === "/api/ready" && req.method === "GET")
        return json(readyDrafts({ runsDir: opts.runsDir, locals: await localGraphs() }));

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
          // A partial has no feedback of its own: revise.ts refuses it without --evidence-from
          // <includer>. That refusal would happen in a detached child (exit 1, unseen) while the
          // screen polls forever — so the rule is applied HERE, with revise.ts's own check.
          const body = (await req.json().catch(() => ({}))) as { evidence_from?: unknown };
          const evidenceFrom = body?.evidence_from;
          if (evidenceFrom !== undefined && (typeof evidenceFrom !== "string" || !PROMPT_ID.test(evidenceFrom)))
            return json({ error: "evidence_from must be a prompt id" }, 400);
          if (isPartialId(view.id) && evidenceFrom === undefined)
            return json({
              error: `${view.id} is a partial; re-draft it from an includer: bun reviser/revise.ts ${view.id} --evidence-from <includer> (or POST {"evidence_from": "<includer>"})`,
            }, 409);
          const source = evidenceSource(view.id, evidenceFrom, root); // throws (→ 409) when the includer does not include it
          // revise.ts exits 1 with nothing to revise from — in a detached child that is a screen
          // saying "the reviser is running" forever. Same rule, applied where it can be seen.
          if (loadFeedback(source, root).length === 0)
            return json({ error: `no feedback recorded for ${source}, so there is nothing to re-draft from — reject this proposal instead, or add feedback first` }, 409);
          const argv = [process.execPath, join(import.meta.dir, "..", "reviser", "revise.ts"), view.id, ...(evidenceFrom ? ["--evidence-from", evidenceFrom] : [])];
          if (opts.spawnReviser) opts.spawnReviser(argv);
          else if (process.env.HOWDAH_STUB) return json({ ok: true, drafting: view.id, stubbed: true }, 202);
          else Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", env: { ...process.env } }).unref();
          return json({ ok: true, drafting: view.id, ...(evidenceFrom ? { evidence_from: evidenceFrom } : {}) }, 202);
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
          // The key is write-only and the form PUTs the whole object on every save, so an
          // absent or blank field means "leave it alone" — otherwise saving the chime
          // checkbox would silently clear a key the screen is not allowed to show back.
          // `null` is the explicit clear, which is why there is a Clear button.
          if ("typesafeApiKey" in body) {
            const v = body.typesafeApiKey;
            if (v === null) delete c.typesafeApiKey;
            else if (typeof v === "string" && v.trim()) c.typesafeApiKey = v.trim();
          }
          saveConfig(c);
          return json({ ok: true });
        }
        // A credential is never served back into the bundle — only whether one is in force
        // and where it came from. 127.0.0.1 with the Host/Origin guards makes echoing it
        // low-stakes, not harmless, and the screen has no use for the value.
        const { repos, folders, typesafeApiKey, ...settings } = loadConfig();
        return json({ ...settings, typesafeApiKeyState: typesafeKeyState({ ...settings, typesafeApiKey, repos, folders }) });
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
      /**
       * HOW-50: ONE stream for the whole board, not a poll per row. It watches each run log's
       * SIZE (a stat, no read) and says which runs changed; the client refetches the board,
       * whose incremental fold then reads only the appended bytes. A runner dying writes
       * nothing, so liveness is not visible here — the client keeps a slow safety refresh.
       */
      if (url.pathname === "/api/board/events") {
        let timer: ReturnType<typeof setInterval>;
        const sizes = new Map<string, number>();
        const scan = (): string[] => {
          const changed: string[] = [];
          const seen = new Set<string>();
          for (const rid of listRunIds(opts.runsDir)) {
            seen.add(rid);
            let size = -1;
            try { size = statSync(logPath(opts.runsDir, rid)).size; } catch { /* removed mid-scan */ }
            if (sizes.get(rid) !== size) { sizes.set(rid, size); changed.push(rid); }
          }
          for (const rid of [...sizes.keys()]) if (!seen.has(rid)) { sizes.delete(rid); changed.push(rid); }
          return changed;
        };
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(": connected\n\n");
            scan(); // the baseline: the client already has the board it just fetched
            timer = setInterval(() => {
              try {
                const changed = scan();
                if (changed.length) controller.enqueue(`data: ${JSON.stringify({ changed })}\n\n`);
              } catch { /* the runs dir is mid-change: the next tick sees it */ }
            }, pollMs * 2);
          },
          cancel() { clearInterval(timer); },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
      }

      if (url.pathname === "/api/runs" && req.method === "POST") {
        // launch: hand off to the CLI, detached — the viewer never owns an engine loop
        const body = (await req.json()) as LaunchBody;
        if (!body.graph) return json({ error: "graph required" }, 400);
        // HOW-18: refuse a bad name HERE — past the spawn, the CLI's refusal is invisible
        const named = normalizeRunName(body.name);
        if (!named.ok) return json({ error: named.error }, 400);
        const runId = `${body.graph}-${Date.now().toString(36)}`;
        // validated against the table, not passed through: --harness reaches a spawn
        const harness = body.overrides?.harness;
        if (harness !== undefined && !isHarness(harness))
          return json({ error: `unknown harness "${harness}" — have: ${harnessNames().join(", ")}` }, 400);
        startRun({ ...body, graph: body.graph, name: named.name }, runId);
        return json({ id: runId }, 202);
      }

      /**
       * HOW-51: waive an acceptance criterion — a human decision, appended under the log lock
       * (engine/acceptance-decision.ts). When it was the last one holding delivery and the run
       * is parked on the gate, the runner is resumed, as a slice decision resumes it: the waiver
       * alone answers that park. 409 with the refusal's own words otherwise.
       */
      const aw = url.pathname.match(/^\/api\/runs\/([^/]+)\/acceptance\/waive$/);
      if (aw && req.method === "POST") {
        const runId = aw[1]!;
        const runDir = join(opts.runsDir, runId);
        const body = (await req.json().catch(() => ({}))) as { criterion?: unknown; reason?: unknown; unprovable?: unknown };
        // HOW-59: `unprovable: true` waives every row this run could never prove, in one decision
        const r = body.unprovable === true
          ? waiveUnprovable(runDir, String(body.reason ?? ""))
          : waiveCriterion(runDir, String(body.criterion ?? ""), String(body.reason ?? ""));
        if (!r.ok) return json({ error: r.message }, 409);
        const parked = replayState(readLog(join(runDir, "run.jsonl"))).parked;
        const resumed = r.remaining === 0 && parked?.code === "acceptance-unmet" && !runnerAlive(runDir);
        if (resumed) launchResume(runId);
        return json({ ok: true, ...("waived" in r ? { waived: r.waived } : { appended: r.appended }), remaining: r.remaining, resumed }, 202);
      }

      /**
       * HOW-52: a run's evidence files (screenshots, console.txt, preview.log). Only paths that
       * core/evidence.ts isEvidencePath accepts — under evidence/, no `..`, an allowed extension —
       * and only once the resolved file is still inside that run's evidence folder, so a crafted
       * path or a symlink cannot read anything else off the disk.
       */
      const ef = url.pathname.match(/^\/api\/runs\/([^/]+)\/file\/(evidence\/.+)$/);
      if (ef && req.method === "GET") {
        const rel = decodeURIComponent(ef[2]!);
        if (!isEvidencePath(rel)) return json({ error: "not an evidence file" }, 400);
        const root = join(opts.runsDir, ef[1]!, "evidence");
        const target = join(opts.runsDir, ef[1]!, rel);
        let real: string;
        try { real = realpathSync(target); } catch { return json({ error: "no such evidence file" }, 404); }
        if (!real.startsWith(realpathSync(root) + sep)) return json({ error: "not an evidence file" }, 400);
        const type = rel.endsWith(".png") ? "image/png" : "text/plain; charset=utf-8";
        return new Response(Bun.file(real), { headers: { "content-type": type, "cache-control": "no-cache" } });
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

      const evm = url.pathname.match(/^\/api\/runs\/([^/]+)\/event\/(\d+)$/);
      if (evm) {
        if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
        const runId = evm[1]!;
        const seq = Number(evm[2]);
        const logFile = logPath(opts.runsDir, runId);
        if (!existsSync(logFile)) return json({ error: "unknown run" }, 404);
        const event = runViews.event(logFile, seq);
        return event ? json(event) : json({ error: "no such event" }, 404);
      }

      /**
       * HOW-65: a draft-graph run's draft (web/draft.ts) and the card's Save. The state decides
       * the status — 404 for no such draft, 409 while drafting or after a refusal — and every
       * non-ready answer carries the reason the page shows.
       */
      const dm = url.pathname.match(/^\/api\/runs\/([^/]+)\/draft(?:\/(save|redraft|discard))?$/);
      if (dm) {
        const rid = decodeURIComponent(dm[1]!);
        if (rid.includes("/") || rid.startsWith(".")) return json({ state: "unknown", reason: "not a run id" }, 400);
        if (!dm[2]) {
          if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
          const draft = await runDraft(rid);
          return json(draft, DRAFT_STATUS[draft.state]);
        }
        if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
        if (dm[2] === "discard") {
          const r = discardRunDraft({ runsDir: opts.runsDir, runId: rid, draft: await runDraft(rid) });
          return r.ok ? json({ ok: true, appended: r.appended }) : json({ error: r.error }, r.status);
        }
        const body = await objectBody(req);
        if (!body) return json({ error: "expected a JSON object" }, 400);
        if (dm[2] === "redraft") {
          const config = loadConfig(home);
          const r = redraftRunDraft({
            runsDir: opts.runsDir, runId: rid, draft: await runDraft(rid), change: body.change,
            workspaceFor: (cwd) => workspaceNameFor(config, cwd),
          });
          if (!r.ok) return json({ error: r.error }, r.status);
          const childId = `${r.request.graph}-${Date.now().toString(36)}`;
          startRun(r.request, childId);
          return json({ id: childId }, 202);
        }
        const saved = await saveRunDraft({ home, root, draft: await runDraft(rid), name: body.name, builtins: Object.keys(GRAPHS) });
        return saved.ok ? json({ ok: true, name: saved.name }, 201) : json({ error: saved.error }, saved.status);
      }

      const m = url.pathname.match(/^\/api\/runs(?:\/([^/]+)(?:\/(events|reply|open-ide|open-run-folder|harness-login|resume|pause|abort|jump|steer|soft-stop|ask|comments|approval|redesign|effects|shell|transcript|logs))?)?$/);
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
        // HOW-50: the board. Each run's log is folded incrementally (web/board.ts) — a tick
        // re-reads only what was appended — so hundreds of runs stay cheap on every refresh.
        const ids = listRunIds(opts.runsDir);
        board.retain(ids.map((rid) => logPath(opts.runsDir, rid)));
        const runs = ids.map((rid) => {
          const p = logPath(opts.runsDir, rid);
          const fold = board.fold(p);
          const started = fold.events.find((e) => e.type === "run-started");
          return boardRow(rid, fold, {
            // the run's own repo: a removed worktree's commits still live in its object store
            cwd: started?.type === "run-started" ? started.cwd : undefined,
            commits: (cwd, base, head) => board.commitsBetween(cwd, base, head),
            liveness: (summary, events) => withRunnerLiveness(summary, events, join(opts.runsDir, rid)),
          });
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

      /**
       * The one thing the operator cannot do from inside Howdah: log the harness in. Agent
       * nodes run `claude -p` / `codex app-server` / `cursor-agent -p`, which have no TTY, so
       * when a run parks on `harness-unauthenticated` there is nowhere to type the login into.
       * This opens a real terminal sitting in the run's own folder with the login command ready.
       *
       * The harness name is matched against the harness TABLE (HOW-17: it used to be a
       * two-entry literal here, which 400d a cursor park) rather than interpolated, so
       * nothing from the request body ever reaches a shell — the command is assembled from
       * the table's own constants. It is returned either way, so a platform we cannot open a
       * terminal on still tells the operator what to run.
       */
      if (sub === "harness-login" && req.method === "POST") {
        const body: unknown = await req.json().catch(() => undefined);
        const asked = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { harness?: unknown }).harness : undefined;
        const harness = typeof asked === "string" ? asked : "";
        const spec = isHarness(harness) ? harnessSpec(harness) : undefined;
        const command = spec ? `${spec.binary} ${spec.loginVerb}` : undefined;
        if (!command) return json({ error: `unknown harness "${harness}"` }, 400);
        const events = readLog(path);
        const started = events.find((e) => e.type === "run-started");
        const cwd = effectiveCwd(path, started?.type === "run-started" ? started.cwd : undefined);
        const dir = cwd && existsSync(cwd) ? cwd : opts.runsDir;
        if (process.platform !== "darwin")
          return json({ ok: false, command, cwd: dir, error: "opening a terminal is macOS-only so far — run the command yourself" }, 501);
        // AppleScript string literal: the only untrusted part is the path, and a quote in a
        // directory name would otherwise end the literal
        const script = `tell application "Terminal" to do script "cd ${dir.replace(/(["\\$`])/g, "\\$1")} && ${command}"`;
        // through the seam, never Bun.spawn directly: this is the one route whose side effect
        // lands on the operator's screen, so the test suite has to be able to hold it back
        launchTerminal(["osascript", "-e", script, "-e", 'tell application "Terminal" to activate']);
        return json({ ok: true, command, cwd: dir });
      }

      if (sub === "reply" && req.method === "POST") {
        const body: unknown = await req.json().catch(() => undefined);
        if (typeof body !== "object" || body === null || Array.isArray(body))
          return json({ error: "body must be a JSON object {text?, answers?}" }, 400);
        // absent text is the empty reply ("let it through" on a permission ask); anything
        // other than a string is a malformed request, not a 500 from deep in the rules
        const raw = (body as { text?: unknown }).text;
        const text = raw === undefined ? "" : raw;
        if (typeof text !== "string") return json({ error: "text must be a string" }, 400);
        // HOW-25: a question card sends the options it picked. The shape is checked against
        // the questions the park is actually asking, inside decideReply — this only refuses
        // what is not even the right KIND of thing, so the 400s stay named.
        const answers = (body as { answers?: unknown }).answers;
        if (answers !== undefined && !Array.isArray(answers))
          return json({ error: "answers must be an array" }, 400);
        // system-map 0.2: one shared rule set with `howdah reply`; refusals name the next step
        const result = resolveReply(join(opts.runsDir, id), { text, answers }, { graphs });
        // a body that does not fit the questions is the caller's error; everything else a
        // reply can be refused for is a fact about the park, which is a 409 naming the next step
        if (!result.ok) return json({ error: result.message, code: result.code }, result.malformed ? 400 : 409);
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

      // HOW-3: the operator attests to an ambiguous side effect — the viewer half of
      // `howdah resolve-effect`, through the same locked engine/control.ts rules
      if (sub === "effects" && req.method === "POST") {
        const body = await objectBody(req);
        if (!body) return json({ error: "body must be a JSON object {effect, verdict, node?}" }, 400);
        const { effect, verdict, node } = body;
        if (typeof effect !== "string" || effect.trim() === "") return json({ error: "effect must be a non-empty string" }, 400);
        if (typeof verdict !== "string" || !EFFECT_VERDICTS.includes(verdict as EffectVerdict))
          return json({ error: `verdict must be ${EFFECT_VERDICTS.join(" or ")}` }, 400);
        if (node !== undefined && typeof node !== "string") return json({ error: "node must be a string" }, 400);
        const runDir = join(opts.runsDir, id);
        const result = resolveEffect(runDir, effect, verdict as EffectVerdict, { node });
        if (!result.ok) return json({ error: result.message, code: result.code }, 409);
        clearAsks(opts.attentionDir, runDir, result.asks);
        wake(id); // the resolution must MOVE the run, not just record the attestation
        return json({ ok: true, idempotent: result.idempotent, node: result.node, effect: result.effect, verdict: result.verdict });
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

      /**
       * HOW-47: steer a running agent. Not spawned — appending the steer IS the whole write, and
       * the runner's executor delivers it — so the refusal (not running, parked, paused, dead
       * runner, no steer channel on this harness) comes straight back from the one precheck the
       * CLI shares. 409: the request is fine, the run is not in a state that can take it.
       */
      if (sub === "steer" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { text?: unknown };
        const sent = steer(join(opts.runsDir, id), typeof body.text === "string" ? body.text : "");
        if (!sent.ok) return json({ error: sent.message }, 409);
        return json({ ok: true, seq: sent.seq, node: sent.node, visit: sent.visit }, 202);
      }

      /**
       * HOW-48: "stop at the next tool call" — the soft pause. Like a steer it is only a log
       * append (the runner's executor delivers it), so it is answered in-process with the shared
       * precheck's words. Asking twice for one turn is idempotent.
       */
      if (sub === "soft-stop" && req.method === "POST") {
        const sent = softStop(join(opts.runsDir, id));
        if (!sent.ok) return json({ error: sent.message }, 409);
        return json({ ok: true, node: sent.node, visit: sent.visit, already: sent.already }, 202);
      }

      if (sub === "ask" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { question?: string };
        const question = (body.question ?? "").trim();
        if (!question) return json({ error: "a question is required" }, 400);

        const events = readLog(path);
        const started = events.find((e) => e.type === "run-started");
        const graph = started?.type === "run-started" ? (await registry()).graphs[started.graph] : undefined;
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
        let unwatch: () => void = () => {};
        // only the bytes appended since the last tick are read (log/write.ts LogTail): a full
        // re-read every tick per tab is what froze the viewer on a 13 MB log
        const tail = new LogTail(path);
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(": connected\n\n"); // flush headers so clients resolve immediately
            // HOW-49: a NAMED event, so the client's log-event handler never mistakes it for
            // a run event — and it is never written anywhere, only sent to who is watching
            unwatch = liveGit.subscribe(id, (g) => controller.enqueue(`event: git-live\ndata: ${JSON.stringify(g)}\n\n`));
            const push = () => {
              try {
                for (const e of tail.next().filter((e) => e.seq > since)) {
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
            unwatch();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
        });
      }

      if (sub === "shell" || sub === "transcript" || sub === "logs") {
        if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
        if (sub === "transcript") {
          const node = url.searchParams.get("node");
          return json(runViews.transcript(path, {
            limit: queryLimit(url, 40, 200),
            before: queryNum(url, "before"),
            node: node ?? undefined,
            visit: queryNum(url, "visit"),
          }));
        }
        if (sub === "logs") {
          return json(runViews.logs(path, { limit: queryLimit(url, 200, 1000), before: queryNum(url, "before") }));
        }
        const view = runViews.fold(path);
        const runDir = join(opts.runsDir, id);
        const alive = runnerAlive(runDir);
        const shellSeq = view.shellEvents.at(-1)?.seq ?? 0;
        const hit = shellCache.get(id);
        const sameShell = hit !== undefined && hit.shellCount === view.shellCount && hit.shellSeq === shellSeq && hit.alive === alive;
        if (hit && sameShell && hit.lastSeq === view.lastSeq && hit.lastAt === view.lastAt) return detailResponse(hit.body);
        const base = hit && sameShell ? hit.detail : await (async () => {
          const started = view.shellEvents.find((e) => e.type === "run-started");
          const graph = started?.type === "run-started" ? (await registry()).graphs[started.graph] : undefined;
          let declarations = {};
          try { declarations = graph ? graph.declarations() : {}; } catch { /* the rest of the view still renders */ }
          const derived = deriveDetail(id, view.shellEvents, declarations, {
            turns: view.turns, omitTurns: true, skipLogRows: true, snapshot: baseIndex(runDir, view.shellEvents), runnerAlive: alive,
            graphs, // HOW-69: the reply route's registry, so the card and the route agree
          });
          derived.log_rows = view.notices;
          derived.summary = withRunnerLiveness(derived.summary, view.shellEvents, runDir);
          const target = effectiveCwd(path, derived.identity.cwd ?? undefined);
          const wt = readWorktreeRecord(runDir);
          derived.persistence = { home, run_dir: runDir, log_path: path, worktree_path: wt?.path ?? null, runner_alive: alive };
          return {
            ...derived,
            cwd_exists: target ? existsSync(target) : false,
            editor_configured: Boolean(loadConfig().editorCommand),
            soft_stop_escalate_ms: loadConfig().softStopEscalateMs ?? SOFT_STOP_ESCALATE_MS,
          };
        })();
        const summary = base.summary as { last_event_at?: string | null };
        const agentAt = base.last_agent_event_at;
        const patched = {
          ...base,
          events_seq: view.lastSeq,
          last_agent_event_at: view.lastAgentAt ?? (typeof agentAt === "string" ? agentAt : null),
          summary: { ...summary, last_event_at: view.lastAt ?? summary.last_event_at ?? null },
        };
        const body = JSON.stringify(patched);
        shellCache.set(id, { shellCount: view.shellCount, shellSeq, alive, lastSeq: view.lastSeq, lastAt: view.lastAt, body, detail: base });
        return detailResponse(body);
      }

      let logSize = -1;
      try { logSize = statSync(path).size; } catch { /* not there yet: derive from nothing, cache nothing */ }
      const cached = detailCache.get(id);
      if (cached && cached.size === logSize && Date.now() - cached.at < DETAIL_CACHE_MS) return detailResponse(cached.body);
      const events = readLog(path);
      // scopes and declared writers come from the graph, not the log: that is what lets the
      // Context tab list a key no step has reached yet instead of hiding it (CUR5)
      const started = events.find((e) => e.type === "run-started");
      const graph = started?.type === "run-started" ? (await registry()).graphs[started.graph] : undefined;
      let declarations = {};
      try {
        declarations = graph ? graph.declarations() : {};
      } catch {
        /* a graph with conflicting scopes throws; the rest of the run view still renders */
      }
      const runDir = join(opts.runsDir, id);
      // probed ONCE: the rail's "runner alive" and the turn states (HOW-46) must read the same answer
      const alive = runnerAlive(runDir);
      const detail = deriveDetail(id, events, declarations, { snapshot: baseIndex(runDir, events), runnerAlive: alive, graphs });
      detail.summary = withRunnerLiveness(detail.summary, events, runDir);
      const target = effectiveCwd(path, detail.identity.cwd ?? undefined);
      const wt = readWorktreeRecord(runDir);
      detail.persistence = {
        home,
        run_dir: runDir,
        log_path: path,
        worktree_path: wt?.path ?? null,
        runner_alive: alive,
      };
      const body = {
        ...detail,
        cwd_exists: target ? existsSync(target) : false,
        editor_configured: Boolean(loadConfig().editorCommand),
        // HOW-48: when the header offers to escalate a soft stop that has not taken effect
        soft_stop_escalate_ms: loadConfig().softStopEscalateMs ?? SOFT_STOP_ESCALATE_MS,
      };
      const serialised = JSON.stringify(body);
      if (logSize >= 0) detailCache.set(id, { size: logSize, at: Date.now(), body: serialised });
      return detailResponse(serialised);
    },
  });
}

/**
 * system-map 1d: the base snapshot of the current proposal round, indexed for tier glyphs.
 *
 * Everything here comes from the run log, so it is treated as untrusted before it touches the
 * disk: the manifest hash must be a sha256 hex, and the object store (the store the round's
 * `map-extracted` event names — taken from the events already read, so a GET never re-reads
 * run.jsonl) must be the default store or inside $HOWDAH_HOME.
 *
 * Cost on the live-polling path: loadSnapshot keeps an LRU of assembled maps (manifests are
 * immutable, content-addressed), the index is memoised per assembled map, and a snapshot that
 * cannot be read is remembered as unreadable for UNREADABLE_TTL_MS (bounded), so a broken one is
 * not retried per SSE tick yet a transient failure recovers without a viewer restart.
 * Unreadable → null: the card says tiers are unknown rather than failing the run view.
 */
const MANIFEST_HASH = /^[0-9a-f]{64}$/;
const indexes = new WeakMap<AssembledMap, SnapshotIndex>();
/** key → when the "unreadable" verdict expires (ms since epoch) */
const unreadable = new Map<string, number>();
const UNREADABLE_MAX = 256;
export const UNREADABLE_TTL_MS = 60_000;

function allowedStore(dir: string): boolean {
  const home = resolve(howdahHome());
  return dir === resolve(defaultStoreDir()) || dir.startsWith(home + sep);
}

export function baseIndex(runDir: string, events: ReturnType<typeof readLog>, now: () => number = Date.now): SnapshotIndex | null {
  const manifest = currentProposal(events)?.manifest_hash;
  if (!manifest || !MANIFEST_HASH.test(manifest)) return null;
  const extracted = events.findLast((e) => e.type === "map-extracted" && e.manifest_hash === manifest);
  const recorded = extracted?.type === "map-extracted" && typeof extracted.store === "string" && extracted.store !== "" ? extracted.store : null;
  const storeDir = resolve(recorded ?? defaultStoreDir());
  if (!allowedStore(storeDir)) return null;
  const key = `${resolve(runDir)}\0${storeDir}\0${manifest}`;
  const until = unreadable.get(key);
  if (until !== undefined) {
    if (now() < until) return null;
    unreadable.delete(key); // expired: try again
  }
  try {
    const map = loadSnapshot(runDir, manifest, new MapStore(storeDir));
    let index = indexes.get(map);
    if (!index) indexes.set(map, (index = snapshotIndex(map)));
    return index;
  } catch {
    if (unreadable.size >= UNREADABLE_MAX) unreadable.delete(unreadable.keys().next().value!);
    unreadable.set(key, now() + UNREADABLE_TTL_MS);
    return null;
  }
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
