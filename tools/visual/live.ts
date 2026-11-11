#!/usr/bin/env bun
/**
 * A genuinely LIVE run for the baseline: a real Engine holding the real runner lock
 * (runner.pid), parked inside `implementation.implement` and streaming a chunk every few
 * seconds. Start it after seed.ts and leave it running while shoot.mjs runs:
 *
 *   bun <scratch>/live.ts &
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, RUNS, WORK, ROOT, ok, scriptedAgent, streamTurn, text, tool } from "./lib";
import { ticketScripts } from "./content";
process.env.HOWDAH_HOME = HOME;
const { Engine } = await import("../../engine/run");
const { implementTicket } = await import("../../graphs/implement-ticket");
const { git } = await import("../../graphs/slice-fixture");

const ID = "implement-ticket-mhv6live";
const dir = join(RUNS, ID);
const API = join(WORK, "acme-api");
const wt = join(HOME, "repos", "acme-api", "worktrees", ID);
if (existsSync(wt)) { try { git(API, "worktree", "remove", "--force", wt); } catch {} }
try { git(API, "branch", "-D", `howdah/${ID}`); } catch {}
rmSync(dir, { recursive: true, force: true });

const scripted = scriptedAgent((node, visit) => ticketScripts[node]?.(visit));
const FILES = ["gateway/src/main/kotlin/com/example/gateway/Retry.kt", "gateway/src/main/kotlin/com/example/gateway/Backoff.kt", "gateway/src/test/kotlin/com/example/gateway/RetryTest.kt", "docs/webhooks.md"];
const engine = new Engine(implementTicket, {
  dir, promptsDir: join(ROOT, "prompts"), cwd: API, folderKind: "repo", name: "HOW-436 Idempotency keys for webhooks (live)",
  executors: {
    worktree: async (a) => {
      mkdirSync(join(wt, ".."), { recursive: true });
      git(API, "worktree", "add", "-q", "-b", `howdah/${ID}`, wt);
      writeFileSync(join(dir, "worktree.json"), JSON.stringify({ path: wt, branch: `howdah/${ID}`, repo: API, base: "HEAD", base_sha: git(API, "rev-parse", "HEAD") }) + "\n");
      a.log.append({ type: "reconciled", node: a.nodeId, git: { repo: true, branch: `howdah/${ID}`, head: git(API, "rev-parse", "HEAD").slice(0, 12), uncommitted: 0, unpushed: 0 }, disagreements: [] });
      return ok({ "worktree.verify_command": "./gradlew test && bun test", "worktree.preview_paths": "/" });
    },
    command: async () => ok({}),
    wait: async () => ok(),
    agent: async (a) => {
      if (a.nodeId !== "implementation.implement") return scripted(a);
      const { log, nodeId: node, visit } = a;
      let index = 0;
      const chunk = (kind: "text" | "thinking" | "tool_call" | "tool_result", content: string, extra: Record<string, unknown> = {}) =>
        log.append({ type: "chunk", node, visit, turn: 1, index: index++, kind, content, ...extra } as any);
      const todos = (done: number) => JSON.stringify({ todos: ["Add an Idempotency-Key column to webhook_deliveries", "Reject a replayed key with 409 and the original response", "Backoff: 1s, 5s, 30s, 5m, then park the delivery", "Tests for replay, backoff and the 24h key expiry", "Document the header in docs/webhooks.md"].map((c, i) => ({ content: c, activeForm: c, status: i < done ? "completed" : i === done ? "in_progress" : "pending" })) });
      chunk("thinking", "The delivery table has no uniqueness on (endpoint_id, idempotency_key). Add it first, then the handler can rely on the constraint rather than a read-then-write.");
      chunk("tool_call", todos(0), { tool_id: "live_0", tool_name: "TodoWrite" });
      chunk("tool_result", "Todos have been modified successfully.", { tool_id: "live_0", tool_name: "TodoWrite" });
      for (let i = 1; i <= 2000; i++) {
        await Bun.sleep(i < 4 ? 400 : 4000);
        const f = FILES[i % FILES.length]!;
        if (i % 3 === 1) chunk("text", `Working through ${f.split("/").at(-1)} — step ${i}. `);
        else if (i % 3 === 2) { chunk("tool_call", JSON.stringify({ file_path: f }), { tool_id: `live_${i}`, tool_name: "Read" }); chunk("tool_result", `     1\t// ${f}\n     2\t…`, { tool_id: `live_${i}`, tool_name: "Read" }); }
        else { chunk("tool_call", JSON.stringify({ command: `./gradlew :gateway:test --tests '*Retry*' 2>&1 | tail -5` }), { tool_id: `live_${i}`, tool_name: "Bash" }); writeFileSync(join(wt, "LIVE.md"), `edit ${i}\n`); if (i % 12 === 0) chunk("tool_call", todos(Math.min(4, i / 12)), { tool_id: `live_t${i}`, tool_name: "TodoWrite" }); }
        if (i > 150) await Bun.sleep(60_000); // stop growing the log; stay alive
      }
      return new Promise(() => {});
    },
  },
});
console.log("live run:", ID, "pid", process.pid);
await engine.start({ goal: "Add idempotency keys to outgoing webhooks so a retried delivery is never processed twice", work: "HOW-436: receivers report duplicate events after our retries. Send an Idempotency-Key header, persist it, and refuse a replay." });
