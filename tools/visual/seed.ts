#!/usr/bin/env bun
/**
 * HOW-68 baseline seed: builds a fresh HOWDAH_HOME at <scratch>/home with a varied set of runs.
 *
 *   bun <scratch>/seed.ts
 *
 * Nothing inside the repo is written: the viewer is served from a private COPY of the
 * repo at <scratch>/repo (node_modules symlinked), so the bundle output, feedback/ and
 * reviser/proposals/ writes land there.
 *
 * Every run is produced by the REAL engine (engine/run.ts) with scripted in-process executors,
 * so logs, pinned prompts and rendered hashes are genuine. The seams, stated:
 *   - the model's words/tool calls are scripted (lib.ts streamTurn mirrors claude.ts's events);
 *   - worktree / verify / evidence / probe:pr steps are stubs publishing the facts a real one would;
 *   - timestamps are spread out after the fact (lib.ts retime) — `ts` only;
 *   - "mid-flight" runs are engines whose executor never returns; the seed process then exits,
 *     which is exactly what a kill -9'd runner leaves behind.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ATTENTION, HOME, REPO, ROOT, RUNS, SCRATCH, WORK, PORT, never, ok, retime, scriptedAgent, lastPark, text, think, tool, type NodeScript, type ScriptFor } from "./lib";
import { ACCEPTANCE_OPEN, CHANGE_MAP, LONG_FAIL_REASON, LONG_PUBLISH_REASON, PLAN_MD, QUESTIONS, RESEARCH_REPORT, VERIFY_FAIL, VERIFY_PASS, ticketScripts } from "./content";

process.env.HOWDAH_HOME = HOME;
delete process.env.HOWDAH_STUB;

// ---- 0. clean slate ---------------------------------------------------------------------
for (const d of [HOME, ROOT, WORK]) rmSync(d, { recursive: true, force: true });
mkdirSync(RUNS, { recursive: true });
cpSync(REPO, ROOT, { recursive: true, filter: (src) => !/\/(node_modules|\.git|\.gstack)(\/|$)/.test(src) && !/web\/public\/app\.(js|css)$/.test(src) });
symlinkSync(join(REPO, "node_modules"), join(ROOT, "node_modules"));

const { Engine } = await import("../../engine/run");
type EngineT = InstanceType<typeof Engine>;
import type { Executor, EngineOpts, ExecArgs, AttemptResult } from "../../engine/run";
const { implementTicket } = await import("../../graphs/implement-ticket");
const { implementStacked } = await import("../../graphs/implement-stacked");
const { quickTask } = await import("../../graphs/quick-task");
const { writeDoc } = await import("../../graphs/write-doc");
const { research } = await import("../../graphs/research");
const { planFeature } = await import("../../graphs/plan-feature");
const { implementSlice } = await import("../../graphs/implement-slice");
const { draftGraph } = await import("../../graphs/draft-graph");
const { CATALOG, cleanDraft } = await import("../../core/fixtures/graph-draft");
const { SLICE_FIXTURE_DIR, git, commitAll, GHOSTS_V1, GHOSTS_V2, COMMENT_V1, SLICE_GOAL, SLICE_WORK } = await import("../../graphs/slice-fixture");
const { saveConfig } = await import("../../config/config");
const { saveTuning } = await import("../../config/tuning");
const { AttentionCenter } = await import("../../engine/attention");
const { approve, sendFeedback, pinComment, markPaused } = await import("../../engine/control");
const { worktreeExecutor, commandExecutor } = await import("../../engine/executors/worktree");
const { approvalExecutor } = await import("../../engine/executors/approval");
const { createHowdahServer, buildApp: _b } = (await import(join(ROOT, "web/server.ts"))) as any;
const { askReason } = await import("../../core/ask");
const { effectiveCwd } = await import("../../engine/executors/worktree-record");

const PROMPTS = join(ROOT, "prompts");
const report: string[] = [];
const note = (id: string, what: string) => { report.push(`${id.padEnd(40)} ${what}`); console.log(`  ${id}: ${what}`); };

// ---- 1. workspaces + config -------------------------------------------------------------
function demoRepo(name: string): string {
  const dir = join(WORK, name);
  cpSync(SLICE_FIXTURE_DIR, dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), `# ${name}\n\nDemo workspace for the Howdah HOW-68 baseline.\n`);
  git(dir, "init", "-q", "-b", "main");
  commitAll(dir, "Initial commit");
  return dir;
}
const API = demoRepo("acme-api");
const WEB = demoRepo("acme-web");
const NOTES = join(WORK, "notes");
mkdirSync(NOTES, { recursive: true });
writeFileSync(join(NOTES, "README.md"), "# notes\n");
saveConfig({
  repos: {
    "acme-api": { path: API, verifyCommand: "./gradlew test && bun test", diagnosticsCommand: "./gradlew detekt -q", preview: { command: "bun run dev --port $PORT", paths: ["/", "/login", "/sign-in-failed"] } as any },
    "acme-web": { path: WEB, verifyCommand: "bun test", inheritUserSettings: true },
    "a-workspace-with-a-deliberately-long-name-to-expose-truncation": { path: WEB },
  },
  folders: { notes: { path: NOTES } },
  editorCommand: "code", defaultHarness: "claude", fallbackChain: ["claude", "codex", "cursor"],
  viewerBase: `http://localhost:${PORT}`, theme: "system", chime: true,
} as any, HOME);
saveTuning({ graphs: { "implement-ticket": { defaults: { model: "claude-fable-5", effort: "high" }, nodes: { "implementation.local_review": { harness: "codex", effort: "medium" } } } } } as any, HOME);
writeFileSync(join(HOME, "heartbeat.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n");

// ---- 2. the scripted engine -------------------------------------------------------------
type Pr = "OPEN" | "MERGED" | "CLOSED" | "CONFLICTS" | "CI_FAILED" | "CHANGES_REQUIRED";
interface TicketOpts {
  graph?: any;
  cwd?: string;
  name?: string;
  parent?: string;
  inputs: Record<string, unknown>;
  /** per-node overrides of the default ticket script */
  script?: ScriptFor;
  pr?: (probeVisit: number) => Pr;
  prUrl?: string;
  verify?: (visit: number) => typeof VERIFY_PASS | typeof VERIFY_FAIL;
  clean?: boolean;
  command?: (a: ExecArgs) => Promise<AttemptResult | undefined> | AttemptResult | undefined;
  wait?: Executor;
  probe?: "happened" | "not-happened" | "unknown";
  overrides?: EngineOpts["overrides"];
  evidence?: boolean;
}

const PNG = join(import.meta.dir, "evidence-fixture.png");
function makeEvidencePng(): void {
  if (existsSync(PNG)) return;
  const html = `<body style="margin:0;font:16px system-ui;background:#f6f5f2;display:grid;place-items:center;height:100vh"><div style="background:#fff;border:1px solid #ddd;border-radius:12px;padding:48px;max-width:420px;text-align:center"><h1 style="font-size:22px">We could not sign you in</h1><p style="color:#555">Something went wrong while signing you in with your company account. Your session was not changed.</p><p><a style="display:inline-block;background:#1f3a5f;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Try again</a></p><p style="font-size:13px;color:#888">Still stuck? Contact support and quote reference AUTH-LOOP.</p></div></body>`;
  const js = `const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1600,height:1000}});await p.setContent(${JSON.stringify(html)});await p.screenshot({path:${JSON.stringify(PNG)}});await b.close();})()`;
  Bun.spawnSync(["node", "-e", js], { stdout: "inherit", stderr: "inherit" });
}
makeEvidencePng();

function reconciled(a: ExecArgs, o: { branch: string; head: string; uncommitted?: number; unpushed?: number | null; forge?: any; disagreements?: string[] }): void {
  a.log.append({ type: "reconciled", node: a.nodeId, git: { repo: true, branch: o.branch, head: o.head, uncommitted: o.uncommitted ?? 0, unpushed: o.unpushed ?? 0 }, ...(o.forge !== undefined ? { forge: o.forge } : {}), disagreements: o.disagreements ?? [] });
}

function engineFor(id: string, o: TicketOpts): EngineT {
  const dir = join(RUNS, id);
  const branch = `howdah/${id}`;
  const prUrl = o.prUrl ?? "https://github.com/acme/acme-api/pull/4127";
  const scripted = scriptedAgent((node, visit, a) => o.script?.(node, visit, a) ?? ticketScripts[node]?.(visit));
  // a step that may change files really does: one line in the worktree, committed, so the
  // engine's own progress check (HOW-54, node-finished.tree) sees a different tree each visit
  const agent: Executor = async (a) => {
    const d: any = a.def;
    const wt = effectiveCwd(a.log.path, a.cwd);
    if (wt && wt !== a.cwd && existsSync(join(wt, ".git")) && !d.readOnly && d.changesFiles !== false) {
      writeFileSync(join(wt, "HOWDAH-DEMO.md"), `${a.nodeId}@${a.visit}\n`, { flag: "a" });
      try { commitAll(wt, `${a.nodeId} visit ${a.visit}`); } catch {}
    }
    return scripted(a);
  };
  return new Engine(o.graph ?? implementTicket, {
    dir, promptsDir: PROMPTS, cwd: o.cwd ?? API, folderKind: "repo",
    ...(o.name ? { name: o.name } : {}), ...(o.parent ? { parent: o.parent } : {}), ...(o.overrides ? { overrides: o.overrides } : {}),
    probe: async () => o.probe ?? "unknown",
    executors: {
      agent,
      worktree: async (a) => {
        if (a.nodeId.startsWith("cleanup")) {
          a.log.append({ type: "chunk", node: a.nodeId, visit: a.visit, turn: 1, index: 0, kind: "text", content: o.clean === false ? "worktree has 3 uncommitted files — refusing to remove it\n" : `removed worktree ${HOME}/repos/acme-api/worktrees/${id}\n` });
          const wt = join(HOME, "repos", (o.cwd ?? API) === WEB ? "acme-web" : "acme-api", "worktrees", id);
          if (o.clean !== false && existsSync(wt)) { git(o.cwd ?? API, "worktree", "remove", "--force", wt); rmSync(join(dir, "worktree.json"), { force: true }); }
          return ok({ "worktree.clean": o.clean !== false });
        }
        a.log.append({ type: "chunk", node: a.nodeId, visit: a.visit, turn: 1, index: 0, kind: "text", content: `fetched origin; branching ${branch} from origin/main at 4e0c7d1\nyour local main is 2 commits ahead; not used\n` });
        const repo = o.cwd ?? API;
        const wt = join(HOME, "repos", repo === WEB ? "acme-web" : "acme-api", "worktrees", id);
        if (!existsSync(wt)) { mkdirSync(join(wt, ".."), { recursive: true }); git(repo, "worktree", "add", "-q", "-b", branch, wt); }
        writeFileSync(join(dir, "worktree.json"), JSON.stringify({ path: wt, branch, repo, base: "HEAD", base_sha: git(repo, "rev-parse", "HEAD") }) + "\n");
        reconciled(a, { branch, head: "4e0c7d19aa02" });
        const d: any = a.def;
        const w: Record<string, unknown> = {};
        if (d.writes && "worktree.verify_command" in d.writes) w["worktree.verify_command"] = "./gradlew test && bun test";
        if (d.writes && "worktree.preview_paths" in d.writes) w["worktree.preview_paths"] = "/, /login, /sign-in-failed";
        return ok(w);
      },
      command: async (a) => {
        const custom = await o.command?.(a);
        if (custom) return custom;
        const say = (s: string) => a.log.append({ type: "chunk", node: a.nodeId, visit: a.visit, turn: 1, index: 0, kind: "text", content: s });
        if (a.nodeId === "verify.run") {
          const v = o.verify?.(a.visit) ?? VERIFY_PASS;
          say(`$ ${v.command}\n${v.output_tail}\n`);
          return ok({ "verify.result": v });
        }
        if (a.nodeId === "implementation.evidence") {
          if (o.evidence === false) return ok({ "evidence.items": { outcome: "not-checked", items: [], reason: "this workspace has no preview command — register one with `howdah workspace preview <name> \"<cmd>\" --paths /`" } });
          const rel = `evidence/${a.nodeId}@${a.visit}`;
          mkdirSync(join(dir, rel), { recursive: true });
          const items = ["/", "/sign-in-failed"].map((p, i) => {
            const file = `${rel}/${i === 0 ? "root" : "sign-in-failed"}.png`;
            if (existsSync(PNG)) cpSync(PNG, join(dir, file));
            return { path: p, url: `http://127.0.0.1:51877${p}`, file, abs_path: join(dir, file), captured_at: new Date().toISOString(), console_errors: i, console_sample: i ? ["Warning: Each child in a list should have a unique \"key\" prop."] : [] };
          });
          writeFileSync(join(dir, rel, "console.txt"), "Warning: Each child in a list should have a unique \"key\" prop.\n");
          say(`preview up on :51877 after 3.2s; captured ${items.length} paths\n`);
          return ok({ "evidence.items": { outcome: "captured", items, console_file: `${rel}/console.txt`, command: "bun run dev --port 51877", commit: "8c41f0e2b7aa", dirty: false } });
        }
        if (a.nodeId === "delivery.repair_check") return ok({ "repair.changed": true });
        // probe:pr
        const state = o.pr?.(a.visit) ?? "OPEN";
        reconciled(a, { branch, head: a.visit > 1 ? "b77d1c4e90f1" : "8c41f0e2b7aa", forge: { kind: "pr", state, url: prUrl } });
        say(`${prUrl}: ${state}\n`);
        return ok({
          "pr.state": state,
          "pr.review_activity": state === "CHANGES_REQUIRED" ? [{ pr: prUrl, kind: "thread", author: "priya-raman", at: new Date().toISOString(), url: `${prUrl}#discussion_r1`, body: "Should `rt` be capped server-side as well? A hand-edited state with rt=-1 would get an extra lap.", path: "api/src/main/kotlin/com/example/api/auth/Callback.kt", line: 61 }] : [],
        });
      },
      wait: o.wait ?? (async () => ok()),
      approval: approvalExecutor,
    },
  });
}

/** raise the durable attention record a parked run's CLI would have raised (cli/main.ts:231) */
async function ring(id: string): Promise<void> {
  const park = lastPark(join(RUNS, id));
  if (!park) return;
  const center = new AttentionCenter(ATTENTION, [], { viewerBase: `http://localhost:${PORT}`, clock: () => new Date(park.ts) });
  await center.raise({ run: id, node: park.node, visit: park.visit, reason: park.reason });
}

async function run(id: string, o: TicketOpts, when: [number, number], label: string, expect?: string): Promise<void> {
  const r = await engineFor(id, o).start(o.inputs);
  retime(join(RUNS, id), when[0], when[1]);
  if (r.state === "parked") await ring(id);
  const got = r.state === "parked" ? `parked ${(r as any).code ?? ""} @${(r as any).node}` : `${r.state} ${(r as any).outcome ?? ""}`;
  note(id, `${label} → ${got}`);
  if (expect && !got.includes(expect)) throw new Error(`${id}: expected ${expect}, got ${got}: ${JSON.stringify(r)}`);
}

/** start a run whose executor hangs at `signal` — the engine promise is abandoned on purpose */
async function runUntilHang(id: string, o: TicketOpts, hung: Promise<void>, when: [number, number], label: string): Promise<void> {
  void engineFor(id, o).start(o.inputs).catch((e: unknown) => console.error(id, e));
  await hung;
  await Bun.sleep(30);
  retime(join(RUNS, id), when[0], when[1]);
  note(id, label);
}
const hang = () => { let fire!: () => void; const p = new Promise<void>((r) => (fire = r)); return { p, fire }; };

const TICKET_412 = { goal: "Stop the login redirect loop for SSO users", work: "HOW-412: SSO users get ERR_TOO_MANY_REDIRECTS after the refresh cookie expires. See https://linear.app/howdah/issue/HOW-412" };
const TICKET_431 = { goal: "Add rate-limit headers to the public API gateway and document them", work: "HOW-431: every public response should carry X-RateLimit-Limit, X-RateLimit-Remaining and X-RateLimit-Reset; 429s also carry Retry-After. Document in the OpenAPI spec." };

console.log("seeding runs…");

// A. finished, the rich one ---------------------------------------------------------------
const A = "implement-ticket-mhs8q2lf";
await run(A, {
  name: "HOW-412 SSO redirect loop", inputs: TICKET_412,
  pr: (v) => (v === 1 ? "CHANGES_REQUIRED" : v === 2 ? "OPEN" : "MERGED"),
}, [26 * 60, 22 * 60], "finished implement-ticket (acceptance, evidence, PR, plan, change map, review repair)", "finished success");

// B. parked: the long acceptance prose ask --------------------------------------------------
const B = "implement-ticket-mhv2k9qd";
await run(B, {
  name: "HOW-431 Rate-limit headers", inputs: TICKET_431, prUrl: "https://github.com/acme/acme-api/pull/4140",
  script: (node) => (node === "delivery.publish" ? { steps: [text("Checking the acceptance contract before publishing.")], fail: { reason: LONG_PUBLISH_REASON, code: "acceptance-unmet" } } : undefined),
}, [190, 172], "parked needs-input, long prose ask (acceptance-unmet at delivery.publish)", "parked");

// C. parked: long id + long name + replyable prose ask, failing tests on the way ------------
const C = "implement-ticket-how-431-add-rate-limit-headers-to-the-public-api-gateway-and-document-them-mhv3a7xw";
await run(C, {
  name: "HOW-431 Add rate-limit headers to the public API gateway and document them in the OpenAPI spec (second attempt after the sliding-window question)",
  inputs: { ...TICKET_431, goal: TICKET_431.goal + " — second attempt: the first one stopped on the sliding-window question. Keep the limiter as it is unless the ticket says otherwise, and do not touch tenant-specific overrides in gateway/limits/*.yaml." },
  script: (node, visit) => (node === "implementation.implement" ? {
    steps: [
      tool("TodoWrite", { todos: [
        { content: "Find where the gateway decides a request is over the limit", status: "completed", activeForm: "Finding the limiter" },
        { content: "Add X-RateLimit-Limit / -Remaining / -Reset to every public response", status: "completed", activeForm: "Adding headers" },
        { content: "Decide Retry-After semantics for the sliding window (blocked: needs the operator)", status: "in_progress", activeForm: "Deciding Retry-After semantics" },
        { content: "Document the headers in openapi.yaml", status: "pending", activeForm: "Documenting headers" },
        { content: "Run the suite and commit", status: "pending", activeForm: "Running the suite" },
      ] }, "Todos have been modified successfully."),
      tool("Grep", { pattern: "class SlidingWindowLimiter", path: "gateway/src" }, "gateway/src/main/kotlin/com/example/gateway/limits/SlidingWindowLimiter.kt:14:class SlidingWindowLimiter(private val redis: Redis, private val windowMs: Long = 60_000) {"),
      tool("Bash", { command: "./gradlew :gateway:test 2>&1 | tail -30" }, VERIFY_FAIL.output_tail, true),
      text("I have made the rate-limit middleware change but I am not confident about the Retry-After semantics for burst tenants."),
    ],
    fail: { reason: LONG_FAIL_REASON },
  } satisfies NodeScript : undefined),
}, [75, 41], "parked needs-input, long id + long name, replyable attempt-failed with a long reason", "parked");

// D. parked mid-turn on a harness AskUserQuestion -------------------------------------------
{
  const id = "quick-task-mhv41c0p";
  const h = hang();
  await runUntilHang(id, {
    graph: quickTask, cwd: API, name: "Rate-limit header semantics", inputs: { goal: "Work out the Retry-After semantics for the public API rate limiter and make the change" },
    script: () => ({
      steps: [
        think("The limiter is a sliding window. The ticket's wording assumes fixed windows. This is a product decision, not mine."),
        text("I've read the limiter. Before I change anything I need one decision from you."),
        tool("Read", { file_path: "gateway/src/main/kotlin/com/example/gateway/limits/SlidingWindowLimiter.kt" }, "     1\tpackage com.example.gateway.limits\n     2\t\n     3\tclass SlidingWindowLimiter(private val redis: Redis, private val windowMs: Long = 60_000) {\n     4\t    fun allow(key: String, limit: Int): Decision { /* ZREMRANGEBYSCORE, ZCARD, ZADD */ }\n     5\t}"),
      ],
      then: async (a) => {
        const tid = "toolu_ask_0001";
        a.log.append({ type: "chunk", node: a.nodeId, visit: a.visit, turn: 1, index: 90, kind: "tool_call", content: JSON.stringify({ questions: QUESTIONS.map(({ id: _i, ...q }) => q) }).slice(0, 400) + "…", tool_id: tid, tool_name: "AskUserQuestion" });
        const reason = askReason(QUESTIONS);
        a.log.append({ type: "attention-raised", node: a.nodeId, visit: a.visit, reason, ask: { kind: "user-question", request_id: "req_01HZX", tool_name: "AskUserQuestion", tool_use_id: tid, questions: QUESTIONS } });
        h.fire();
        return never();
      },
    }),
  }, h.p, [38, 33], "parked needs-input on a harness AskUserQuestion (2 questions, options; runner gone)");
  await ring(id);
}

// E. parked on an ambiguous side effect ------------------------------------------------------
{
  const id = "implement-ticket-mhv4d2e8";
  const o: TicketOpts = {
    name: "HOW-433 Paginate /v2/invoices", inputs: { goal: "Paginate GET /v2/invoices with cursor-based paging", work: "HOW-433: the endpoint returns up to 40k rows for large tenants; add `cursor` + `limit` (max 200) and a `next_cursor` in the body." },
    prUrl: "https://github.com/acme/acme-api/pull/4151", evidence: false,
    script: (node, _v, a) => (node === "delivery.publish" ? {
      steps: [tool("Bash", { command: "git push -u origin HEAD 2>&1 | tail -2" }, "Branch 'howdah/implement-ticket-mhv4d2e8' set up to track remote branch.")],
      then: async () => { a.effects.claim("create-pr"); throw new Error("harness exited with signal SIGKILL while `gh pr create` was running"); },
    } : undefined),
  };
  await engineFor(id, o).start(o.inputs);
  const r = await engineFor(id, o).resume();
  retime(join(RUNS, id), 310, 262);
  await ring(id);
  note(id, `parked on an ambiguous side effect → ${JSON.stringify({ state: r.state, code: (r as any).code })}`);
}

// F. failed terminal (merged, but the worktree could not be removed) ------------------------
await run("implement-ticket-mhq17zzb", {
  name: "HOW-398 Audit log export", inputs: { goal: "Export the audit log as CSV", work: "HOW-398: admins need a CSV export of the audit log, filtered by date range." },
  prUrl: "https://github.com/acme/acme-api/pull/4098", pr: () => "MERGED", clean: false,
}, [3 * 24 * 60, 3 * 24 * 60 - 95], "failed run (terminal outcome failed: worktree retained)", "finished failed");

// G. aborted (PR closed) -----------------------------------------------------------------------
await run("implement-ticket-mhp90aa1", {
  name: "HOW-377 Dark-launch new pricing", inputs: { goal: "Dark-launch the new pricing table behind a flag", work: "HOW-377" },
  prUrl: "https://github.com/acme/acme-web/pull/812", pr: () => "CLOSED", cwd: WEB, evidence: false,
}, [5 * 24 * 60, 5 * 24 * 60 - 140], "aborted run (PR closed)", "finished aborted");

// H. harness-dead: an open step, nobody running it -------------------------------------------
{
  const h = hang();
  await runUntilHang("write-doc-mhv5t0c3", {
    graph: writeDoc, cwd: NOTES, name: "Q4 on-call handbook", inputs: { goal: "Write the Q4 on-call handbook", work: "Audience: new on-call engineers. Cover paging policy, the first 15 minutes, and escalation." },
    script: (node) => (node === "doc.draft" ? { steps: [text("Drafting section 2, \"The first 15 minutes\"…"), tool("Write", { file_path: "handbook.md", content: "# On-call handbook\n\n## 1. Paging policy\n…" }, "File created successfully at: handbook.md")], then: async () => { h.fire(); return never(); } } : undefined),
  }, h.p, [130, 118], "open step with a dead runner (reads harness-dead)");
}

// I. more parks: one per card kind / code -----------------------------------------------------
await run("implement-ticket-mhv0b1ne", {
  name: "HOW-429 Migrate cron to Temporal", inputs: { goal: "Move the nightly reconciliation cron to a Temporal workflow", work: "HOW-429" }, evidence: false,
  verify: () => VERIFY_FAIL,
  script: (node, visit) => (node === "implementation.local_review" ? { steps: [text("The suite is red on the same test.")], say: "Rejecting: `CallbackTest > third redirect` still fails; the revision did not touch it.", writes: { review_verdict: "reject", review_findings: [{ severity: "blocker", note: `verify.result is fail (visit ${visit}): expected 200 but was 302` }], acceptance: ACCEPTANCE_OPEN } } : undefined),
}, [9 * 60, 8 * 60], "parked max-visits (reviewer rejects 3x; failing verify) — reply refused", "parked");

await run("research-mhuz6r4k", {
  graph: research, cwd: NOTES, name: "Notification UX survey", inputs: { goal: "Survey how comparable agent harnesses notify the operator when a run needs input" },
  script: (node) => (node === "research.investigate" ? { harness: "codex", steps: [tool("exec", { cmd: "curl -s https://example.com/docs/notifications | head -50" }, "<html>…</html>")], fail: { code: "harness-unauthenticated", reason: "codex is not logged in: `codex login status` → \"Not logged in\". stderr tail: Error: 401 Unauthorized: token expired at 2026-11-10T22:14:03Z. Log in with `codex login`, then resume." } } : undefined),
}, [14 * 60, 13.5 * 60], "parked harness-unauthenticated (codex)", "parked");

await run("quick-task-mhv5c8aa", {
  graph: quickTask, cwd: WEB, name: "Rename Button variants", inputs: { goal: "Rename the Button `primary`/`secondary` variants to `solid`/`outline` across acme-web" },
  script: () => ({
    steps: Array.from({ length: 8 }, () => tool("Bash", { command: "bun test web/src/components/Button.test.tsx" }, "error: Cannot find module './Button.variants' from 'web/src/components/Button.tsx'", true)),
    fail: { code: "stuck", reason: "stuck: the agent made the same failing call 8 times in a row — Bash {\"command\":\"bun test web/src/components/Button.test.tsx\"} → \"error: Cannot find module './Button.variants'\". The turn was stopped." },
  }),
}, [55, 49], "parked stuck (8 identical failing calls)", "parked");

await run("quick-task-mhu1x0d7", {
  graph: quickTask, cwd: API, name: "Bump Kotlin to 2.2", inputs: { goal: "Bump Kotlin to 2.2 and fix what breaks" },
  script: () => ({ steps: [tool("Bash", { command: "./gradlew build 2>&1 | tail -200" }, "e: 212 errors…", true)], fail: { code: "context-exhausted", reason: "the context window filled (claude: \"Prompt is too long\") after the engine had already continued once; the retry made no progress (HEAD unchanged at 4e0c7d1)." } }),
}, [20 * 60, 19 * 60], "parked context-exhausted", "parked");

// J. finished small runs: fill the list -------------------------------------------------------
await run("research-mht4n8s2", {
  graph: research, cwd: NOTES, name: "Notification UX survey (first pass)", inputs: { goal: "Survey how comparable agent harnesses notify the operator when a run needs input, and recommend what Howdah should do" },
  script: (node) => node === "research.synthesize" ? { harness: "codex", steps: [text("Writing the report from the findings.")], say: "Report written.", writes: { report_summary: RESEARCH_REPORT } }
    : node === "research.review" ? { say: "Clear, sourced, and it answers the question.", writes: { review_verdict: "pass", review_findings: [] } }
    : node === "research.plan" ? { say: "Three questions.", writes: { research_questions: "1. What channel carries the notification?\n2. Is there a sound, and can it be muted?\n3. Does the notification deep-link to the ask?" } }
    : node === "research.investigate" ? { harness: "codex", steps: [tool("webSearch", { query: "agent harness desktop notification needs input" }, "12 results")], say: "Findings gathered.", writes: { findings_summary: "Native notifications with deep links are the norm; sounds are short and opt-in." } } : undefined,
}, [2 * 24 * 60, 2 * 24 * 60 - 48], "finished research (codex turns → unpriced/partial cost, long markdown document)", "finished success");

await run("write-doc-mhr2c5b9", {
  graph: writeDoc, cwd: NOTES, name: "ADR-014: one primitives library", inputs: { goal: "Write ADR-014 explaining why the viewer sits on one primitives library", work: "Base UI in, Radix out, three controls stay native." },
  script: (node, visit) => node === "doc.review" ? { say: visit === 1 ? "The consequences section is missing." : "Complete now.", writes: { review_verdict: visit === 1 ? "reject" : "pass", review_findings: visit === 1 ? ["No 'Consequences' section", "The decision is stated twice"] : [] } } : undefined,
}, [4 * 24 * 60, 4 * 24 * 60 - 31], "finished write-doc (one reject → revise loop)", "finished success");

for (const [i, g] of ["Fix flaky InvoiceRepositoryTest", "Regenerate the OpenAPI client", "Delete the unused feature flag `checkout_v1`"].entries())
  await run(`quick-task-mho${i}k3p${i}`, { graph: quickTask, cwd: i === 1 ? WEB : API, inputs: { goal: g }, ...(i === 2 ? {} : { name: g }) }, [(6 + i) * 24 * 60, (6 + i) * 24 * 60 - 9], "finished quick-task", "finished success");

// K. a paused run -------------------------------------------------------------------------------
{
  const id = "implement-ticket-mhv1p4uz";
  let n = 0;
  const e = engineFor(id, { name: "HOW-430 Webhook retries", inputs: { goal: "Retry failed webhooks with exponential backoff", work: "HOW-430" }, prUrl: "https://github.com/acme/acme-api/pull/4133", evidence: false, pr: () => "OPEN" });
  // pause at the wait: the engine reads control at every node boundary
  (e as any).opts.control = () => (n++ > 12 ? "pause" : null);
  const r = await e.start({ goal: "Retry failed webhooks with exponential backoff", work: "HOW-430" });
  markPaused(join(RUNS, id));
  retime(join(RUNS, id), 6 * 60, 5 * 60);
  note(id, `paused by the operator → ${JSON.stringify(r)}`);
}

// L. plan-feature: awaiting approval (with pinned comments), and an approved parent + children --
const slice = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, title, goal: `${title} works end to end`, work: `Scope: ${title}.\n\n- [ ] the happy path\n- [ ] the error path returns a typed problem\n\nTouch: api/src/main/kotlin/com/example/api/App.kt`, verify: `curl the endpoint; run the suite`, depends_on: [], ...over,
});
const PLAN_V1 = { feature: "Let users delete their account", slices: [slice("api-route", "DELETE /api/users/{id}"), slice("api-handler", "Soft-delete handler with a 30-day grace period", { depends_on: [{ slice: "api-route", until: "published" }] })], out_of_scope: ["the admin UI"], risks: ["the delete is not reversible after 30 days"] };
const PLAN_V2 = { ...PLAN_V1, slices: [...PLAN_V1.slices, slice("web-client", "Delete-account button in settings", { workspace: "acme-web", depends_on: [{ slice: "api-handler", until: "merged" }] })], risks: [...PLAN_V1.risks, "the web slice waits on the API being merged"] };
const tickets = (plan: typeof PLAN_V2) => ({ tickets: plan.slices.map((s, i) => ({ slice_id: s.id, identifier: `HOW-${441 + i}`, url: `https://linear.app/howdah/issue/HOW-${441 + i}`, title: s.title })) });

function planEngine(id: string, plans: unknown[], spawned: string[][]): EngineT {
  let round = 0;
  return new Engine(planFeature, {
    dir: join(RUNS, id), cwd: API, folderKind: "repo", promptsDir: PROMPTS, name: "Account deletion",
    executors: {
      worktree: worktreeExecutor({ reposDir: join(HOME, "repos"), repoName: () => "acme-api" } as any),
      command: commandExecutor({ map: { workers: 0 }, launch: { runsDir: RUNS, workspaces: { repoNames: () => ["acme-api", "acme-web"], nameFor: (p: string) => (p === API ? "acme-api" : p === WEB ? "acme-web" : null) }, spawn: (argv: string[]) => void spawned.push(argv) } } as any),
      agent: scriptedAgent((node) => node === "plan.propose"
        ? { steps: [think("Two repos are registered. The API half can be split into the route and the handler; the web half depends on the API being merged."), text("Reading the neighbourhood of `getUser` to see where a DELETE route would mount.")], say: "Proposed plan below.", writes: { "plan.slices": plans[Math.min(round++, plans.length - 1)] } }
        : node === "tickets.create" ? { steps: [tool("mcp__linear__create_issue", { team: "Howdah", title: "DELETE /api/users/{id}" }, "{\"identifier\":\"HOW-441\"}")], say: "Raised one ticket per slice.", writes: { tickets: tickets(PLAN_V2) } } : undefined),
      approval: approvalExecutor,
      wait: async () => ok(),
    },
  });
}
let planOk = true;
try {
  // awaiting approval, round 2, with a comment history
  const id = "plan-feature-mhv3zz10";
  const sp: string[][] = [];
  let r = await planEngine(id, [PLAN_V1, PLAN_V2], sp).start({ goal: SLICE_GOAL, work: SLICE_WORK });
  pinComment(join(RUNS, id), "api-handler", "the web client needs a slice of its own — settings page, behind the same flag");
  pinComment(join(RUNS, id), "api-route", "name the route in the plan the way the OpenAPI spec does");
  sendFeedback(join(RUNS, id));
  r = await planEngine(id, [PLAN_V2], sp).resume();
  pinComment(join(RUNS, id), "web-client", "should this wait on `package` rather than `merged`? the client is generated from the published spec");
  retime(join(RUNS, id), 150, 96);
  await ring(id);
  note(id, `plan-feature awaiting approval, round 2 with pinned comments → ${JSON.stringify({ state: r.state, code: (r as any).code })}`);
} catch (e) { planOk = false; console.error("plan-feature (awaiting) failed:", e); }

const PARENT = "plan-feature-mhu7d3k2";
try {
  const sp: string[][] = [];
  await planEngine(PARENT, [PLAN_V2], sp).start({ goal: SLICE_GOAL, work: SLICE_WORK });
  approve(join(RUNS, PARENT));
  const r = await planEngine(PARENT, [PLAN_V2], sp).resume();
  retime(join(RUNS, PARENT), 21 * 60, 20 * 60);
  note(PARENT, `plan-feature parent, approved and launched ${sp.length} children → ${JSON.stringify(r)}`);
  writeFileSync(join(SCRATCH, "spawned-argv.json"), JSON.stringify(sp, null, 2));

  // the children, each an ordinary independent run with `parent` lineage
  await run(`${PARENT}--api-route`, { parent: PARENT, name: "HOW-441 DELETE /api/users/{id}", inputs: { goal: PLAN_V2.slices[0]!.goal, work: "HOW-441: " + PLAN_V2.slices[0]!.work }, prUrl: "https://github.com/acme/acme-api/pull/4160", pr: (v) => (v < 2 ? "OPEN" : "MERGED") }, [19.5 * 60, 17 * 60], "child 1 (implement-ticket) finished, merged", "finished success");
  {
    const id = `${PARENT}--api-handler`;
    const h = hang();
    const deps = [{ slice: "api-route", until: "published", run_id: `${PARENT}--api-route`, workspace: "acme-api" }];
    await runUntilHang(id, {
      graph: implementStacked, parent: PARENT, name: "HOW-442 Soft-delete handler with a 30-day grace period", prUrl: "https://github.com/acme/acme-api/pull/4163",
      inputs: { goal: PLAN_V2.slices[1]!.goal, work: "HOW-442: " + PLAN_V2.slices[1]!.work, deps: JSON.stringify(deps) },
      command: (a) => {
        const d: any = a.def;
        if (d.run === "runs:await") return ok(Object.fromEntries(Object.keys(d.writes ?? {}).map((k) => [k, k === "deps.ready" ? true : k === "deps.waiting" ? "" : k === "deps.base" ? "howdah/" + deps[0]!.run_id : k === "deps.base_tip" ? "8c41f0e2b7aa" : k === "deps.prs" ? ["https://github.com/acme/acme-api/pull/4160"] : k === "deps.restack" ? false : ""])));
        if (d.run === "git:restack") return ok(Object.fromEntries(Object.keys(d.writes ?? {}).map((k) => [k, ""])));
        return undefined;
      },
      script: (node) => (node === "implementation.implement" ? {
        steps: [
          tool("TodoWrite", { todos: [{ content: "Add `deleted_at` to users and a migration", status: "completed", activeForm: "Adding deleted_at" }, { content: "Soft-delete in deleteUser(); hide soft-deleted users from getUser()", status: "in_progress", activeForm: "Soft-deleting in deleteUser()" }, { content: "Nightly purge job after 30 days", status: "pending", activeForm: "Writing the purge job" }, { content: "Tests + commit", status: "pending", activeForm: "Testing" }] }, "Todos have been modified successfully."),
          text("Migration is in. Now the handler."),
          tool("Edit", { file_path: "api/src/main/kotlin/com/example/api/App.kt", old_string: "users.remove(id)", new_string: "users.softDelete(id, clock.now())" }, "The file api/src/main/kotlin/com/example/api/App.kt has been updated."),
        ],
        then: async () => { h.fire(); return never(); },
      } : undefined),
    }, h.p, [17 * 60, 16.4 * 60], "child 2 (implement-stacked) mid-implement, runner gone");
  }
  await run(`${PARENT}--web-client`, {
    parent: PARENT, cwd: WEB, name: "HOW-443 Delete-account button in settings", inputs: { goal: PLAN_V2.slices[2]!.goal, work: "HOW-443: " + PLAN_V2.slices[2]!.work }, evidence: false,
    script: (node) => (node === "implementation.plan" ? { steps: [text("Looking for the settings page.")], fail: { reason: "the agent stopped without a plan: \"web/src has no settings page yet — is this slice meant to create one, or is it in a branch I cannot see?\"" } } : undefined),
  }, [16 * 60, 15.8 * 60], "child 3 parked at the plan with a short question", "parked");
} catch (e) { planOk = false; console.error("plan-feature (parent) failed:", e); }

// M. implement-slice awaiting approval: ghosts on the real extracted map -------------------------
try {
  const id = "implement-slice-mhv2ghst";
  let round = 0;
  const mk = () => new Engine(implementSlice, {
    dir: join(RUNS, id), cwd: API, folderKind: "repo", promptsDir: PROMPTS, name: "Delete account (designed on the map)",
    executors: {
      worktree: worktreeExecutor({ reposDir: join(HOME, "repos"), repoName: () => "acme-api" } as any),
      command: commandExecutor({ map: { workers: 0 } } as any),
      agent: scriptedAgent((node) => node === "slice.propose" ? { steps: [text("Designing on the map: the route, its handler, and where app() mounts it.")], say: "Proposed design below.", writes: { "slice.ghosts": [GHOSTS_V1, GHOSTS_V2][Math.min(round++, 1)] } } : undefined),
      approval: approvalExecutor, wait: async () => ok(),
    },
  });
  await mk().start({ goal: SLICE_GOAL, work: SLICE_WORK });
  const pinned = pinComment(join(RUNS, id), COMMENT_V1.entity_id, COMMENT_V1.text);
  sendFeedback(join(RUNS, id));
  const r = await mk().resume();
  retime(join(RUNS, id), 100, 80);
  await ring(id);
  note(id, `implement-slice awaiting approval (round 2, ghosts on a real tree-sitter map) → ${JSON.stringify({ state: r.state, code: (r as any).code, pinned: (pinned as any).ok })}`);
} catch (e) { console.error("implement-slice failed:", e); note("implement-slice", "FAILED to seed: " + String(e)); }

// N. draft-graph: one ready, one saved -----------------------------------------------------------
const draftRun = async (id: string, name: string, draft: any, when: [number, number]) => {
  const e = new Engine(draftGraph, {
    dir: join(RUNS, id), promptsDir: PROMPTS, cwd: NOTES, folderKind: "plain", name,
    executors: { command: async () => ok({ "graphs.catalog": CATALOG }), agent: scriptedAgent(() => ({ steps: [text("Starting from quick-task and adding a read-only review."), tool("Read", { file_path: "graphs/quick-task.ts" }, "export const spec: GraphSpec = { version: 1, name: \"quick-task\", … }")], say: draft.notes, writes: { "graph.draft": draft } })) },
  });
  const r = await e.start({ intent: "like quick-task but with a read-only review step before it finishes" });
  retime(join(RUNS, id), when[0], when[1]);
  note(id, `draft-graph → ${JSON.stringify(r)}`);
};
const d1 = cleanDraft();
await draftRun("draft-graph-mhv4r1aa", "Draft: quick-review", d1, [64, 61]);
const d2 = cleanDraft();
const rename = (s: string) => s.replace(/quick-review/g, "reviewed-task");
const d2r = JSON.parse(rename(JSON.stringify(d2)));
await draftRun("draft-graph-mhs0p7bb", "Draft: reviewed-task", d2r, [30 * 60, 30 * 60 - 4]);

// ---- 3. things that go through the viewer's own routes ------------------------------------------
const server = createHowdahServer({ runsDir: RUNS, attentionDir: ATTENTION, port: 0, repoRoot: ROOT, resumeRun: () => {}, spawnReviser: () => {}, openTerminal: () => {} } as any);
const base = `http://localhost:${server.port}`;
const send = async (method: string, p: string, body: unknown) => {
  const res = await fetch(base + p, { method, headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const get = async (p: string) => (await fetch(base + p)).json() as Promise<any>;

// the saved draft → a local graph carrying provenance
note("draft save", JSON.stringify(await send("POST", "/api/runs/draft-graph-mhs0p7bb/draft/save", { name: "reviewed-task" })));

// a local graph made in the builder (positions, a loop, a condition)
const triage = {
  version: 1, name: "triage-bug", description: "Reproduce a bug, fix it if it reproduces, and say why if it does not",
  defaults: { permissionMode: "auto" }, entry: "triage-bug.reproduce", inputs: ["goal"],
  fields: [
    { key: "goal", kind: "text", scope: "sticky" },
    { key: "reproduced", kind: "choice", scope: "cleared", choices: ["yes", "no"] },
    { key: "repro_notes", kind: "text", scope: "sticky" },
    { key: "fix_summary", kind: "text", scope: "sticky" },
    { key: "review_verdict", kind: "choice", scope: "cleared", choices: ["pass", "reject"] },
  ],
  nodes: [
    { id: "triage-bug.reproduce", kind: "agent", prompt: "triage-bug.reproduce", reads: ["goal"], writes: ["reproduced", "repro_notes"], readOnly: true, position: { x: 40, y: 160 } },
    { id: "triage-bug.fix", kind: "agent", prompt: "triage-bug.fix", reads: ["goal", "repro_notes"], writes: ["fix_summary"], maxVisits: 3, position: { x: 400, y: 60 } },
    { id: "triage-bug.review", kind: "agent", prompt: "triage-bug.review", reads: ["goal", "fix_summary"], writes: ["review_verdict"], readOnly: true, position: { x: 760, y: 60 } },
    { id: "fixed", kind: "terminal", outcome: "success", position: { x: 1120, y: 60 } },
    { id: "cannot-reproduce", kind: "terminal", outcome: "failed", label: "Could not reproduce", position: { x: 400, y: 320 } },
  ],
  edges: [
    { from: "triage-bug.reproduce", to: "triage-bug.fix", when: { op: "equals", key: "reproduced", value: "yes" } },
    { from: "triage-bug.reproduce", to: "cannot-reproduce" },
    { from: "triage-bug.fix", to: "triage-bug.review" },
    { from: "triage-bug.review", to: "triage-bug.fix", when: { op: "equals", key: "review_verdict", value: "reject" } },
    { from: "triage-bug.review", to: "fixed" },
  ],
};
note("builder save", JSON.stringify(await send("PUT", "/api/graphs/triage-bug/builder", {
  intent: "create", spec: triage,
  prompts: {
    "triage-bug.reproduce": "Reproduce this bug before anyone tries to fix it.\n\n## The report\n{{ context.goal }}\n\nFind the smallest set of steps that shows it. Say `yes` only if you saw it fail yourself.\n",
    "triage-bug.fix": "Fix the bug that was reproduced.\n\n## The report\n{{ context.goal }}\n\n## How it reproduces\n{{ context.repro_notes }}\n\nWrite a failing test first, then make it pass.\n",
    "triage-bug.review": "Review this fix against the report.\n\n## The report\n{{ context.goal }}\n\n## What was done\n{{ context.fix_summary }}\n",
  },
})));
// a broken local graph: the Graphs screen reports it rather than hiding it
writeFileSync(join(HOME, "graphs", "half-edited.ts"), "import { buildGraph } from \"../../core/graph-spec\";\nexport default buildGraph({ version: 1, name: \"half-edited\", nodes: [\n");

// a run of the local graph, so it has history
try {
  const { loadLocalGraph } = await import(join(ROOT, "graphs/local.ts"));
  const g = await loadLocalGraph(HOME, "triage-bug", ROOT);
  const id = "triage-bug-mhv4zq77";
  const e = new Engine(g, { dir: join(RUNS, id), promptsDir: [join(HOME, "prompts"), PROMPTS], cwd: API, folderKind: "repo", name: "Invoices total off by one cent", executors: { agent: scriptedAgent((node) => node === "triage-bug.reproduce" ? { steps: [tool("Bash", { command: "bun test invoices -t rounding" }, "1 pass")], say: "It does not reproduce on main: the rounding test passes with the reported inputs.", writes: { reproduced: "no", repro_notes: "Ran the reported inputs (3 × 33.335) through `Invoice.total()` on main at 4e0c7d1: 100.01, as expected. The report may be against v2.3.1." } } : undefined) } });
  const r = await e.start({ goal: "Invoice totals are off by one cent for three line items of 33.335" });
  retime(join(RUNS, id), 28, 25);
  note(id, `local-graph run → ${JSON.stringify(r)}`);
} catch (e) { console.error("local graph run failed", e); }

// feedback on real turns (the Prompts screen's evidence; the Proposals screen already has the repo's own drafts)
const detailA = await get(`/api/runs/${A}`);
const renders: any[] = detailA.renders ?? [];
for (const [node, verdict, noteText] of [
  ["delivery.publish", "reject", "The PR description buried the 'Not proven by this run' list under the testing notes. It should be the second section, directly after Why."],
  ["implementation.plan", "accept", "Good plan: named the files, the risks, and what is out of scope. Keep this shape."],
  ["implementation.local_review", "reject", "The reviewer passed the change while leaving a nit it could have required. Either require it or do not mention it."],
] as const) {
  const r = renders.find((x) => x.node === node);
  if (!r) continue;
  const res = await send("POST", `/api/prompts/${r.prompt}/feedback`, { run: A, node, visit: r.visit, note: noteText, verdict, rendered_hash: r.rendered_hash });
  note(`feedback ${r.prompt}`, String(res.status));
}

// a PENDING proposal (every proposal in the repo is already decided, so the Proposals screen's
// accept/reject controls and the nav badge would otherwise have nothing to show). Written into
// the COPY's reviser/proposals/, in the reviser's own file shape.
{
  const cur = readFileSync(join(ROOT, "prompts", "delivery.publish.md"), "utf8");
  const m = cur.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)!;
  const version = Number(m[1]!.match(/^version:\s*(\d+)/m)![1]);
  const added = `Put the "Not proven by this run" list directly after the Why section, before What. A reviewer deciding whether to approve needs to see what was NOT checked before reading what was.`;
  const body = m[2]!.replace(/\n*$/, "\n") + `\n${added}\n`;
  const dir = join(ROOT, "reviser", "proposals");
  const stem = `delivery.publish.v${version + 1}`;
  writeFileSync(join(dir, `${stem}.proposal.md`), `---\nid: delivery.publish\nbase_version: ${version}\nproposed_version: ${version + 1}\nstatus: pending\ncreated: ${new Date(Date.now() - 50 * 60_000).toISOString()}\neval_score: baseline 3/5 structure checks → proposed 5/5 (delivery-publish eval, 5 cases)\neval_verdict: better on structure; no regression on the Why/What/Notes sections\n---\n${body}`);
  writeFileSync(join(dir, `${stem}.reflection.md`), `The one rejection on record (HOW-412, delivery.publish@1) says the "Not proven by this run" list was buried under the testing notes. The template never says where that list goes — the suffix appends it and the model placed it last. One sentence fixes the placement; nothing else in the prompt is touched, so the accepted v2 structure (Why / What / Notes for testing) is preserved.\n`);
  writeFileSync(join(dir, `${stem}.diff`), `--- delivery.publish v${version}\n+++ delivery.publish v${version + 1}\n@@ end of template @@\n+\n+${added}\n`);
  const ps = (await get("/api/proposals")) as any[];
  note("pending proposal", JSON.stringify(ps.filter((x) => x.status === "pending").map((x) => x.file)));
}
server.stop(true);

writeFileSync(join(SCRATCH, "seed-report.txt"), report.join("\n") + "\n");
console.log(`\nseeded ${report.length} items into ${HOME}${planOk ? "" : " (plan-feature had failures — see above)"}`);
process.exit(0);
