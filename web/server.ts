#!/usr/bin/env bun
/**
 * Howdah viewer server (T11, shaping A9.1): a Bun server over the SAME on-disk run logs
 * the engine writes — storage unchanged, the server is a read model plus one write: the
 * reply. SSE streams new events by tailing the log file.
 *
 *   GET  /api/runs                 run summaries, needs-input first
 *   GET  /api/runs/:id             full detail (thread, timeline, usage, allowance, ask)
 *   GET  /api/runs/:id/events?since=N   SSE of events with seq > N
 *   POST /api/runs/:id/reply       {text} → attention-resolved into the log + record cleared
 *
 * Run layout: <runsDir>/<run-id>/run.jsonl (the engine's dir option).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { EventLog, readLog } from "../log/write";
import { deriveDetail, deriveSummary, runDigest, sortRuns } from "./derive";
import { AttentionCenter } from "../engine/attention";
import { graphCatalog, GRAPHS } from "../graphs/index";
import { loadConfig, saveConfig } from "../config/config";
import { listGithubRepos, registerGithubRepo } from "../config/github";
import { loadTuning, saveTuning, pruneTuning } from "../config/tuning";
import { writeControl, clearControl } from "../engine/control";
import { EventLog as ControlLog } from "../log/write";
import { effectiveCwd } from "../engine/executors/worktree";
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
}

const logPath = (runsDir: string, id: string) => join(runsDir, id, "run.jsonl");

/** prompts/, feedback/ and reviser/proposals/ come from the repo; runs come from the server's dir */
const libraryPaths = (opts: ServerOpts): LibraryPaths => ({ root: opts.repoRoot ?? repoRoot(), runsDir: opts.runsDir });

function listRunIds(runsDir: string): string[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).filter((d) => existsSync(logPath(runsDir, d)));
}

export function createHowdahServer(opts: ServerOpts) {
  const pollMs = opts.pollMs ?? 500;
  const root = opts.repoRoot ?? repoRoot();
  const promptStore = new PromptStore(join(root, "prompts"));
  const spawnResume = (id: string) => {
    // a live runner is already polling the log for the reply — don't double-run
    const pidFile = join(opts.runsDir, id, "runner.pid");
    if (existsSync(pidFile)) {
      try {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        if (pid > 0) { process.kill(pid, 0); return; } // alive → it will pick the reply up
      } catch { /* dead pid → resume below */ }
    }
    Bun.spawn(["bun", join(import.meta.dir, "..", "cli", "main.ts"), "resume", id], {
      stdout: "ignore", stderr: "ignore", env: { ...process.env },
    }).unref();
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  return Bun.serve({
    port: opts.port ?? 4711,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/graphs") return json(graphCatalog());
      const gm = url.pathname.match(/^\/api\/graphs\/([^/]+)(\/tuning)?$/);
      if (gm) {
        const g = GRAPHS[gm[1]!];
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
        const effectiveOf = (id: string, n: (typeof g.def.nodes)[string]) => {
          if (n.kind !== "agent") return undefined;
          const base = { harness: n.harness, model: n.model, effort: n.effort, permissionMode: n.permissionMode, maxTurns: n.maxTurns, skills: n.skills };
          const tn = tuning.nodes?.[id] ?? {};
          const td = tuning.defaults ?? {};
          const pick = (k: keyof typeof base) => (tn as any)[k] ?? (base as any)[k] ?? (td as any)[k] ?? (tsDefaults as any)[k];
          return {
            harness: pick("harness") ?? "claude", model: pick("model"), effort: pick("effort"),
            permissionMode: pick("permissionMode"), maxTurns: pick("maxTurns"), skills: pick("skills"),
          };
        };
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

      const m = url.pathname.match(/^\/api\/runs(?:\/([^/]+)(?:\/(events|reply|open-ide|resume|pause|abort|jump|ask))?)?$/);
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
        const runs = listRunIds(opts.runsDir).map((rid) => deriveSummary(rid, readLog(logPath(opts.runsDir, rid))));
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

      if (sub === "reply" && req.method === "POST") {
        const body = (await req.json()) as { text?: string };
        const events = readLog(path);
        const ask = events.findLast((e) => e.type === "attention-raised");
        const resolved = events.some((e) => e.type === "attention-resolved" && ask && e.seq > ask.seq);
        if (!ask || resolved) return json({ error: "nothing awaiting a reply" }, 409);
        new EventLog(path).append({ type: "attention-resolved", node: ask.node, visit: ask.visit, reply: body.text ?? "" });
        new AttentionCenter(opts.attentionDir, []).resolve(`${id}:${ask.node}:${ask.visit}`);
        spawnResume(id); // the reply must MOVE the run, not just record the answer
        return json({ ok: true });
      }

      if (sub === "resume" && req.method === "POST") {
        clearControl(join(opts.runsDir, id));
        spawnResume(id);
        return json({ ok: true }, 202);
      }

      if (sub === "pause" && req.method === "POST") {
        writeControl(join(opts.runsDir, id), "pause");
        return json({ ok: true, note: "pause lands at the next node boundary" }, 202);
      }

      if (sub === "abort" && req.method === "POST") {
        const runDir = join(opts.runsDir, id);
        writeControl(runDir, "abort");
        // a live runner aborts at the boundary; a hung/mid-turn one is killed with its agents
        const pidFile = join(runDir, "runner.pid");
        if (existsSync(pidFile)) {
          const pid = Number(readFileSync(pidFile, "utf8").trim());
          if (pid > 0) {
            try { process.kill(pid, 0); } catch { pid_dead: {
              // dead already — fall through to sealing the log
            } }
            try {
              Bun.spawnSync(["pkill", "-TERM", "-P", String(pid)]); // the claude/codex child too
              process.kill(pid, "SIGTERM");
              await Bun.sleep(500);
              try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch { /* gone */ }
            } catch { /* already dead */ }
          }
        }
        const events = readLog(path);
        if (!events.some((e) => e.type === "run-finished"))
          new ControlLog(path).append({ type: "run-finished", outcome: "aborted" });
        return json({ ok: true });
      }

      if (sub === "jump" && req.method === "POST") {
        const body = (await req.json()) as { node?: string; message?: string };
        if (!body.node) return json({ error: "node required" }, 400);
        const cli = join(import.meta.dir, "..", "cli", "main.ts");
        const args = ["bun", cli, "jump", id, body.node, ...(body.message ? [body.message] : [])];
        const r = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
        if (r.exitCode !== 0) return json({ error: new TextDecoder().decode(r.stderr).trim().slice(0, 300) }, 400);
        return json({ ok: true }, 202);
      }

      if (sub === "ask" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { question?: string };
        const question = (body.question ?? "").trim();
        if (!question) return json({ error: "a question is required" }, 400);

        const events = readLog(path);
        const started = events.find((e) => e.type === "run-started");
        const graph = started?.type === "run-started" ? GRAPHS[started.graph] : undefined;
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
      const graph = started?.type === "run-started" ? GRAPHS[started.graph] : undefined;
      let declarations = {};
      try {
        declarations = graph ? graph.declarations() : {};
      } catch {
        /* a graph with conflicting scopes throws; the rest of the run view still renders */
      }
      const detail = deriveDetail(id, events, declarations);
      const target = effectiveCwd(path, detail.identity.cwd ?? undefined);
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
  const server = createHowdahServer({ runsDir: join(base, "runs"), attentionDir: join(base, "attention") });
  console.log(`howdah viewer: http://localhost:${server.port}`);
}
