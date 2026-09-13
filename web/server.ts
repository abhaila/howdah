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
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { EventLog, readLog } from "../log/write";
import { deriveDetail, deriveSummary, sortRuns } from "./derive";
import { AttentionCenter } from "../engine/attention";
import { graphCatalog } from "../graphs/index";
import { loadConfig, saveConfig } from "../config/config";
import { effectiveCwd } from "../engine/executors/worktree";

export interface ServerOpts {
  runsDir: string;
  attentionDir: string;
  port?: number;
  /** SSE poll interval; small in tests */
  pollMs?: number;
}

const logPath = (runsDir: string, id: string) => join(runsDir, id, "run.jsonl");

function listRunIds(runsDir: string): string[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).filter((d) => existsSync(logPath(runsDir, d)));
}

export function createHowdahServer(opts: ServerOpts) {
  const pollMs = opts.pollMs ?? 500;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  return Bun.serve({
    port: opts.port ?? 4711,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/graphs") return json(graphCatalog());
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
      if (url.pathname === "/api/workspaces") {
        const c = loadConfig();
        return json({
          repos: Object.entries(c.repos).map(([name, r]) => ({ name, ...r })),
          folders: Object.entries(c.folders).map(([name, f]) => ({ name, ...f })),
        });
      }
      if (url.pathname === "/api/runs" && req.method === "POST") {
        // launch: hand off to the CLI, detached — the viewer never owns an engine loop
        const body = (await req.json()) as { graph?: string; inputs?: Record<string, string>; workspace?: string; dir?: string };
        if (!body.graph) return json({ error: "graph required" }, 400);
        const runId = `${body.graph}-${Date.now().toString(36)}`;
        const args = ["run", body.graph, "--id", runId];
        for (const [k, v] of Object.entries(body.inputs ?? {})) args.push("-i", `${k}=${v}`);
        if (body.workspace) args.push("--workspace", body.workspace);
        if (body.dir) args.push("--dir", body.dir);
        Bun.spawn(["bun", join(import.meta.dir, "..", "cli", "main.ts"), ...args], {
          stdout: "ignore", stderr: "ignore", env: { ...process.env },
        }).unref();
        return json({ id: runId }, 202);
      }

      const m = url.pathname.match(/^\/api\/runs(?:\/([^/]+)(?:\/(events|reply|open-ide))?)?$/);
      if (!m) {
        // static: /public assets by name, everything else → the app shell
        const asset = url.pathname.replace(/^\//, "");
        const file = Bun.file(join(import.meta.dir, "public", asset));
        if (asset && (await file.exists())) return new Response(file);
        return new Response(Bun.file(join(import.meta.dir, "public", "index.html")));
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
        return json({ ok: true });
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

      const detail = deriveDetail(id, readLog(path));
      const target = effectiveCwd(path, detail.identity.cwd ?? undefined);
      return json({
        ...detail,
        cwd_exists: target ? existsSync(target) : false,
        editor_configured: Boolean(loadConfig().editorCommand),
      });
    },
  });
}

/** bundle the React app to public/app.js — run at server start, no separate toolchain */
export async function buildApp(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "app", "main.tsx")],
    outdir: join(import.meta.dir, "public"),
    naming: "app.js",
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
