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
const { SLICE_FIXTURE_DIR, git, commitAll, GHOSTS_V1, GHOSTS_V2, COMMENT_V1, DELETE_USER_TS, SLICE_GOAL, SLICE_WORK } = await import("../../graphs/slice-fixture");
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
  viewerBase: `http://localhost:${PORT}`, theme: "system", // `chime` deliberately absent: the default is silent, and the Settings capture must show that
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
  /** false = no preview registered (not-checked); "failed" = the preview command died */
  evidence?: boolean | "failed";
  /** a step that leaves the worktree exactly as it found it (HOW-54's no-progress park) */
  noChange?: (node: string, visit: number) => boolean;
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
    if (wt && wt !== a.cwd && existsSync(join(wt, ".git")) && !d.readOnly && d.changesFiles !== false && !o.noChange?.(a.nodeId, a.visit)) {
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
          if (o.evidence === "failed") {
            writeFileSync(join(dir, rel, "preview.log"), "$ bun run dev --port 51877\nerror: Cannot find module '@acme/design-tokens' from 'web/src/theme.ts'\nerror: script \"dev\" exited with code 1\n");
            say("preview command exited (code 1) after 1.4s\n");
            return ok({ "evidence.items": { outcome: "failed", items: [], console_file: `${rel}/preview.log`, console_abs_path: join(dir, rel, "preview.log"), command: "bun run dev --port 51877", commit: "8c41f0e2b7aa", dirty: false, reason: "the preview command exited (code 1) before it served http://127.0.0.1:51877/ — see preview.log" } });
          }
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
  // a pin on the round that is standing, so "Send feedback" is offered (it needs one comment on THIS round)
  pinComment(join(RUNS, id), DELETE_USER_TS, "name this the way web/src/api.ts names getUser — `deleteUser(id)`, not `removeUser`");
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

// O. HOW-68: the states the design review could not check, each produced the way a real run reaches it
// (where a seam is used instead, it says so) -----------------------------------------------------------

// O1. more park codes ------------------------------------------------------------------------------------
await run("quick-task-mhv6t1mo", {
  graph: quickTask, cwd: API, name: "Backfill tenant_id on audit_log", inputs: { goal: "Backfill tenant_id on audit_log (41M rows) in batches of 10k, behind the existing maintenance flag" },
  script: () => ({
    steps: [text("Running the backfill against the staging snapshot first."), tool("Bash", { command: "bun scripts/backfill-tenant-id.ts --batch 10000 --snapshot staging 2>&1 | tail -3" }, "batch 2871/4100 … 28,710,000 rows")],
    fail: { code: "turn-timeout", reason: "the turn ran for 45m 0s without finishing — past this step's 45m limit (turnTimeoutMs). The harness's process group was stopped. Its last tool call was Bash {\"command\":\"bun scripts/backfill-tenant-id.ts --batch 10000 --snapshot staging 2>&1 | tail -3\"}, still running." },
  }),
}, [95, 47], "parked turn-timeout", "parked");

// no-progress, by the engine's own rule: the review rejects, and the repair's second visit leaves the tree as it found it
await run("implement-ticket-mhv5np0g", {
  name: "HOW-434 Normalise phone numbers at signup", inputs: { goal: "Store phone numbers in E.164 at signup", work: "HOW-434: numbers are stored as typed; normalise to E.164 and reject what cannot be parsed." }, evidence: false,
  noChange: (node, visit) => node === "implementation.implement_review" && visit >= 2,
  script: (node, visit) => (node === "implementation.local_review" ? { steps: [text("The Belgian trunk-prefix case is still wrong.")], say: "Rejecting: `+32 (0)470 12 34 56` is stored with the trunk zero.", writes: { review_verdict: "reject", review_findings: [{ severity: "blocker", note: `visit ${visit}: PhoneTest > strips a trunk prefix in brackets — expected +32470123456 but was +320470123456` }], acceptance: ACCEPTANCE_OPEN } } : undefined),
}, [4 * 60, 3 * 60 + 20], "parked no-progress (the repair's second visit changed nothing)", "no-progress");

// repair-stalled: the probe's own park (core/repair-stall.ts). SEAM: probe:pr is a stub here, so it returns the park the real one decides.
{
  const id = "implement-ticket-mhv3rs7l";
  const url = "https://github.com/acme/acme-api/pull/4144";
  await run(id, {
    name: "HOW-432 Cache the tenant lookup", inputs: { goal: "Cache the tenant lookup in the request context", work: "HOW-432: every handler resolves the tenant twice; cache it per request." }, prUrl: url, evidence: false,
    pr: () => "CHANGES_REQUIRED",
    command: (a) => {
      if (a.nodeId === "delivery.repair_check") return ok({ "repair.changed": false });
      if (a.nodeId === "delivery.probe_pr" && a.visit >= 2)
        return { status: "failed", writes: {}, code: "repair-stalled", reason: `${url} still reads CHANGES_REQUIRED (GitHub's review decision is still CHANGES_REQUESTED), but delivery.address_reviews@1 made no change and nothing new has arrived on the PR since. To go on: reply on the PR, or re-request review or dismiss the stale review, then Retry this step (\`resume ${id}\`); or \`jump ${id} delivery.address_reviews "<what to change>"\` to make a change; or \`abort ${id}\`.` } as AttemptResult;
      return undefined;
    },
    script: (node) => (node === "delivery.address_reviews" ? { steps: [tool("Bash", { command: "gh pr view 4144 --json reviews,comments | jq '.reviews[-1].body'" }, "\"Should the cache key include the region? Two regions can share a tenant slug.\"")], say: "The reviewer asked a question rather than requesting a change: the cache key already includes the region (TenantKey.kt:12). I replied on the thread and changed no code.", writes: { repair_summary: "Answered on the thread: the key is (region, slug) already. No code changed." } } : undefined),
  }, [7 * 60, 6 * 60 + 10], "parked repair-stalled (probe asks again for a repair that changed nothing)", "repair-stalled");
}

// failed evidence: the preview command died, so the reviewer had nothing to look at
await run("implement-ticket-mhs2ev1d", {
  name: "HOW-420 Empty state for the invoices table", inputs: { goal: "Show an empty state on the invoices table", work: "HOW-420: a tenant with no invoices sees a blank table." }, cwd: WEB, evidence: "failed",
  prUrl: "https://github.com/acme/acme-web/pull/830", pr: () => "MERGED",
}, [9 * 24 * 60, 9 * 24 * 60 - 70], "finished, with evidence that FAILED to capture", "finished success");

// O2. mid-turn asks that are not questions: a permission, and an MCP server asking to be connected ---------
{
  const id = "quick-task-mhv6pm3x";
  const h = hang();
  await runUntilHang(id, {
    graph: quickTask, cwd: API, name: "Rotate the staging signing key", inputs: { goal: "Rotate the JWT signing key in staging and restart the auth service" },
    script: () => ({
      steps: [text("The new key is generated. Restarting the service needs a command outside this worktree."), tool("Bash", { command: "openssl genpkey -algorithm ed25519 -out /tmp/staging-jwt.pem" }, "")],
      then: async (a) => {
        const input = { command: "kubectl --context staging -n auth rollout restart deployment/auth-api", description: "Restart auth-api so it picks up the new signing key" };
        a.log.append({ type: "chunk", node: a.nodeId, visit: a.visit, turn: 1, index: 90, kind: "tool_call", content: JSON.stringify(input), tool_id: "toolu_perm_0001", tool_name: "Bash" });
        a.log.append({ type: "attention-raised", node: a.nodeId, visit: a.visit, reason: "Bash needs permission", ask: { kind: "can_use_tool", request_id: "req_01PERM", tool_name: "Bash", input, suggestions: [] } });
        h.fire();
        return never();
      },
    }),
  }, h.p, [22, 18], "parked needs-input on a harness PERMISSION ask (runner gone)");
  await ring(id);
}
{
  const id = "research-mhv6el1c";
  const h = hang();
  const url = "https://chatgpt.com/connectors/linear/reconnect?state=9f2c1a77d0b4";
  const message = "The Linear connector's access expired. Reconnect it to continue.";
  await runUntilHang(id, {
    graph: research, cwd: NOTES, name: "Which tickets mention the redirect loop?", inputs: { goal: "List every Linear ticket from the last quarter that mentions the SSO redirect loop, with its status" },
    script: (node) => (node === "research.plan" ? {
      harness: "codex",
      steps: [text("I'll search Linear for the tickets first.")],
      then: async (a) => {
        a.log.append({ type: "chunk", node: a.nodeId, visit: a.visit, turn: 1, index: 90, kind: "tool_call", content: JSON.stringify({ server: "linear", tool: "search_issues", arguments: { query: "redirect loop", updatedAfter: "-P90D" } }), tool_id: "call_el_0001", tool_name: "mcp__linear__search_issues" });
        a.log.append({ type: "attention-raised", node: a.nodeId, visit: a.visit, reason: `linear needs you: ${message} ${url}`, ask: { kind: "mcp-elicitation", request_id: "7", server: "linear", mode: "url", message, url } });
        h.fire();
        return never();
      },
    } : undefined),
  }, h.p, [12, 9], "parked needs-input on an MCP elicitation (codex; runner gone)");
  await ring(id);
}

// O3. a turn the operator stopped softly: requested → delivered → honored, then the park (HOW-48).
// SEAM: the executor is scripted, so it appends the three events claude.ts appends and returns its result.
await run("quick-task-mhv6ss0p", {
  graph: quickTask, cwd: WEB, name: "Migrate date-fns to Temporal", inputs: { goal: "Replace date-fns with Temporal across acme-web" },
  script: (_n, _v, a) => ({
    steps: [text("Starting with the formatting helpers, since everything else calls them."), tool("Grep", { pattern: "from \"date-fns\"", path: "web/src" }, "web/src/lib/format.ts:1\nweb/src/pages/Invoices.tsx:3\n… 41 files"), tool("Edit", { file_path: "web/src/lib/format.ts", old_string: "format(d, \"PP\")", new_string: "d.toLocaleString(\"en\", { dateStyle: \"medium\" })" }, "The file web/src/lib/format.ts has been updated.")],
    then: async () => {
      const last = "Stopping here as asked. Done: web/src/lib/format.ts is on Temporal and its 12 tests pass. Not started: the 40 call sites under web/src/pages. Nothing is half-edited; the tree builds.";
      a.log.append({ type: "soft-stop-requested", node: a.nodeId, visit: a.visit, by: "operator" });
      a.log.append({ type: "soft-stop-delivered", node: a.nodeId, visit: a.visit });
      a.log.append({ type: "chunk", node: a.nodeId, visit: a.visit, turn: 1, index: 80, kind: "text", content: last });
      a.log.append({ type: "turn-finalized", node: a.nodeId, visit: a.visit, turn: 1, usage: { input_tokens: 2210, cache_read_input_tokens: 180_400, output_tokens: 1930, cost_usd: 0.31, cost_source: "reported" } });
      a.log.append({ type: "soft-stop-honored", node: a.nodeId, visit: a.visit, last_message: last });
      return { status: "failed", writes: {}, code: "paused-by-operator", reason: `paused by the operator at a tool boundary — the agent said: "${last}"` } as AttemptResult;
    },
  }),
}, [31, 26], "parked paused-by-operator after a delivered soft stop", "paused-by-operator");

// O4. queued, and failed-recoverable. SEAMS: a queued run is a run folder whose log has no run-started yet
// (the instant between the launcher making it and the runner's first append); failed-recoverable is a
// failed attempt with no park after it — what kill -9 between the two appends leaves, so the park line is cut.
mkdirSync(join(RUNS, "quick-task-mhv7q0ue"), { recursive: true });
writeFileSync(join(RUNS, "quick-task-mhv7q0ue", "run.jsonl"), "");
note("quick-task-mhv7q0ue", "queued (a run folder with an empty log)");
{
  const id = "quick-task-mhv6fr2k";
  await run(id, {
    graph: quickTask, cwd: API, name: "Upgrade ktlint to 1.5", inputs: { goal: "Upgrade ktlint to 1.5 and fix the new findings" },
    script: () => ({ steps: [tool("Bash", { command: "./gradlew ktlintCheck 2>&1 | tail -4" }, "> Task :api:ktlintMainSourceSetCheck FAILED\n214 findings", true)], fail: { reason: "the agent stopped with 214 findings left and no outputs line" } }),
  }, [44, 40], "failed attempt (park cut below)", "parked");
  const path = join(RUNS, id, "run.jsonl");
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const cut = lines.findLastIndex((l) => JSON.parse(l).type === "node-finished");
  writeFileSync(path, lines.slice(0, cut + 1).join("\n") + "\n");
  rmSync(join(ATTENTION, `${id}.json`), { force: true });
  note(id, "failed-recoverable (the attempt failed and the runner died before it parked)");
}

// O5. UNVERIFIED: the pinned prompt was edited after the run, so the render no longer reconstructs to its hash
{
  const pinned = join(RUNS, "quick-task-mho1k3p1", "prompts", "quick-task.work.md");
  if (existsSync(pinned)) { writeFileSync(pinned, readFileSync(pinned, "utf8") + "\nAlways run the linter before you finish.\n"); note("quick-task-mho1k3p1", "pinned prompt edited after the run → its render reads UNVERIFIED"); }
}

// O6. implement-slice past its approval: one run to the Drift pane, one stopped at the stale-base gate ----
const sliceEngine = (id: string, name: string, o: { script?: ScriptFor; afterApproval?: () => void } = {}) => () => new Engine(implementSlice, {
  dir: join(RUNS, id), cwd: API, folderKind: "repo", promptsDir: PROMPTS, name,
  executors: {
    worktree: worktreeExecutor({ reposDir: join(HOME, "repos"), repoName: () => "acme-api" } as any),
    command: commandExecutor({ map: { workers: 0 } } as any),
    agent: scriptedAgent((node, visit, a) => o.script?.(node, visit, a) ?? (node === "slice.propose" ? { steps: [text("Designing on the map: the route, its handler, and where app() mounts it.")], say: "Proposed design below.", writes: { "slice.ghosts": GHOSTS_V2 } } : undefined)),
    approval: async (a) => { const r = await approvalExecutor(a); if (r.status === "succeeded") o.afterApproval?.(); return r; },
    wait: async () => ok(),
  },
});
try {
  // approved, built (the scripted agent changes no code), and judged: the drift view shows what the code lacks
  const id = "implement-slice-mhv1dr1f";
  // the review stops on what drift found, so the run parks HERE with the Drift pane to read — a
  // pass would go on to the shared delivery half, whose forge probes this demo cannot answer
  const mk = sliceEngine(id, "Delete account (built; drift against the approved design)", {
    script: (node) => node === "implementation.implement" ? { steps: [text("Adding the route next to getUser."), tool("Read", { file_path: "api/src/main/kotlin/com/example/api/App.kt" }, "     1\tpackage com.example.api\n     2\t…")], say: "Implemented the DELETE route and its handler.", writes: { implementation_summary: "Added `DELETE /api/users/{id}` and `deleteUser(Request)`; mounted in app()." } }
      : node === "implementation.local_review" ? { steps: [text("Reading the drift report against the approved design before anything else.")], fail: { reason: "the reviewer stopped without a verdict: \"slice.drift says the designed route and its handler are missing from the code, but implementation_summary says they were added — the two disagree, and I cannot tell which is wrong from here. Did implementation.implement commit its work?\"" } } : undefined,
  });
  await mk().start({ goal: SLICE_GOAL, work: SLICE_WORK });
  approve(join(RUNS, id));
  const r = await mk().resume();
  retime(join(RUNS, id), 11 * 60, 10 * 60);
  if (r.state === "parked") await ring(id);
  note(id, `implement-slice after approval → ${JSON.stringify({ state: r.state, code: (r as any).code, node: (r as any).node, outcome: (r as any).outcome })}`);
} catch (e) { console.error("implement-slice (drift) failed:", e); note("implement-slice-drift", "FAILED to seed: " + String(e)); }
try {
  // approved, then the worktree changed under the approval: the pre-start gate re-checks the fingerprint
  const id = "implement-slice-mhv2st4b";
  const wt = join(HOME, "repos", "acme-api", "worktrees", id);
  const mk = sliceEngine(id, "Delete account (code changed after approval)", {
    // the edit lands between the approval step succeeding and the next step's `requires` gate
    afterApproval: () => { if (existsSync(wt)) writeFileSync(join(wt, "api/src/main/kotlin/com/example/api/App.kt"), readFileSync(join(wt, "api/src/main/kotlin/com/example/api/App.kt"), "utf8") + "\n// a hand edit made after the design was approved\n"); },
  });
  await mk().start({ goal: SLICE_GOAL, work: SLICE_WORK });
  approve(join(RUNS, id));
  const r = await mk().resume();
  retime(join(RUNS, id), 70, 58);
  if (r.state === "parked") await ring(id);
  note(id, `implement-slice with the tree edited after approval → ${JSON.stringify({ state: r.state, code: (r as any).code, node: (r as any).node })}`);
} catch (e) { console.error("implement-slice (stale-base) failed:", e); note("implement-slice-stale", "FAILED to seed: " + String(e)); }

// P. HOW-68 confirming review: one long, hostile transcript — 600+ items, a 6,000-character single line,
// a large JSON tool result and a 300-character token with nowhere to break. It exists so the run view's
// overflow and scrolling are checked on content shaped like a real day of tool output.
{
  const UNBROKEN = "sha512-" + "A1b2C3d4E5f6G7h8".repeat(19).slice(0, 293);
  const LONG_LINE = "WARN " + Array.from({ length: 400 }, (_, i) => `field_${i}=value_${i * 7}`).join(" ");
  const BIG_JSON = JSON.stringify({ tenants: Array.from({ length: 220 }, (_, i) => ({ id: `tenant_${String(i).padStart(4, "0")}`, plan: i % 3 ? "team" : "enterprise", limits: { per_minute: 600 + i, burst: 40 + (i % 9), overrides: [`gateway/limits/tenant_${i}.yaml`] }, checksum: UNBROKEN.slice(0, 64) })) }, null, 2);
  const steps: NodeScript["steps"] = [];
  for (let i = 0; i < 300; i++) {
    if (i % 3 === 0) steps.push(text(i === 150 ? `The lockfile pins one integrity hash I cannot shorten: ${UNBROKEN} — it is carried through unchanged.` : `Pass ${i / 3 + 1}: reading module ${i} and checking its limits against the tenant table.`));
    steps.push(tool(i % 2 ? "Read" : "Bash", i % 2 ? { file_path: `gateway/src/main/kotlin/com/example/gateway/limits/Module${i}.kt` } : { command: `./gradlew :gateway:test --tests 'Module${i}Test' 2>&1 | tail -5` },
      i === 10 ? BIG_JSON : i === 20 ? LONG_LINE : i === 30 ? UNBROKEN : `Module${i}: 14 tests completed, 0 failed\nBUILD SUCCESSFUL in ${3 + (i % 5)}s`, i % 41 === 40));
  }
  await run("quick-task-mhv7long", {
    graph: quickTask, cwd: API, name: "Audit every limiter module", inputs: { goal: "Audit every limiter module against the tenant table and report what disagrees" },
    script: () => ({ steps, say: "All 300 modules agree with the tenant table." }),
  }, [8 * 60, 7 * 60], "finished quick-task with a 600+ item transcript (long line, big JSON, unbroken token)", "finished success");
}

// Q. HOW-68 final pass: states the feedback work and the `is_error` fix need to be SEEN on ---------------
// Q1. a run that polled its PR fourteen times before it merged: probe ↔ wait, the fold in Details AND in Steps
await run("implement-ticket-mhv8poll", {
  name: "HOW-447 Paginate the invoices export", inputs: { goal: "Paginate the invoices export so a tenant with 200k rows does not time out", work: "HOW-447: GET /api/invoices/export times out past ~60k rows. Cursor-paginate it and stream the CSV." },
  prUrl: "https://github.com/acme/acme-api/pull/4171", evidence: false,
  pr: (v) => (v <= 14 ? "OPEN" : "MERGED"),
}, [30 * 60, 27 * 60], "finished implement-ticket after 14 polls of an open PR (the fold)", "finished success");

// Q2. a PR known ONLY from publication_summary: the probe never reached the forge, so no `reconciled` carries
// one. SEAM: probe:pr is a stub; it parks the way the real one does once its unreachable-forge retries are spent.
await run("implement-ticket-mhv8nofg", {
  name: "HOW-448 Trim trailing whitespace in tenant names", inputs: { goal: "Trim trailing whitespace in tenant names on write", work: "HOW-448: two tenants differ only by a trailing space." },
  evidence: false,
  script: (node) => (node === "delivery.publish" ? { say: "Opened the pull request.", writes: { publication_summary: "PR https://github.com/acme/acme-api/pull/4174 — \"Trim tenant names on write (HOW-448)\". Nothing is left unproven." } } : undefined),
  command: (a) => (a.nodeId === "delivery.probe_pr" ? { status: "failed", writes: {}, reason: "executor threw: the forge was unreachable after 3 retries (30s, 2m, 5m): gh: Post \"https://api.github.com/graphql\": dial tcp: lookup api.github.com: no such host", code: "executor-threw" } as AttemptResult : undefined),
}, [95, 80], "parked at probe_pr with the forge unreachable — the PR is known from publication_summary alone", "parked");

// Q3. a stacked run with TWO pull requests of its own (an api one and a web one), probed with different states.
// SEAMS: runs:await and git:restack are stubs (as in L); the probe appends the `reconciled` a real probe:pr
// appends once per PR it reads.
{
  const id = "plan-feature-mhu7d3k2--two-prs";
  const prs = ["https://github.com/acme/acme-api/pull/4181", "https://github.com/acme/acme-web/pull/977"];
  const deps = [{ slice: "api-route", until: "merged", run_id: "plan-feature-mhu7d3k2--api-route", workspace: "acme-api" }];
  try {
    await run(id, {
      graph: implementStacked, parent: "plan-feature-mhu7d3k2", name: "HOW-445 Show the deletion date in the admin console", evidence: false,
      inputs: { goal: "Show an account's deletion date in the admin console", work: "HOW-445: the API returns `deleted_at`; the console shows it beside the account.", deps: JSON.stringify(deps) },
      script: (node) => (node === "delivery.publish" ? { say: "Opened both pull requests.", writes: { publication_summary: { prs, note: "The API change and the console change are separate PRs; the console one depends on the API one." } } } : undefined),
      command: (a) => {
        const d: any = a.def;
        const keys = Object.keys(d.writes ?? {});
        if (d.run === "runs:await") return ok(Object.fromEntries(keys.map((k) => [k, k === "deps.ready" ? true : k === "deps.base_merged" ? true : k === "deps.restack" ? false : k === "deps.prs" ? ["https://github.com/acme/acme-api/pull/4160"] : ""])));
        if (d.run === "git:restack") return ok(Object.fromEntries(keys.map((k) => [k, ""])));
        if (a.nodeId !== "delivery.probe_pr") return undefined;
        const merged = a.visit >= 3;
        reconciled(a, { branch: `howdah/${id}`, head: "5a0e77c1d2b3", forge: { kind: "pr", state: merged ? "MERGED" : "OPEN", url: prs[0]! } });
        reconciled(a, { branch: `howdah/${id}`, head: "5a0e77c1d2b3", forge: { kind: "pr", state: merged ? "MERGED" : a.visit === 1 ? "OPEN" : "CHANGES_REQUESTED", url: prs[1]! } });
        return ok(Object.fromEntries(keys.map((k) => [k, k === "pr.state" ? (merged ? "MERGED" : "OPEN") : k === "pr.approved" ? merged : k === "pr.review_activity" ? [] : ""])));
      },
    }, [14 * 60, 12 * 60], "finished implement-stacked with two PRs of its own", "finished success");
  } catch (e) { console.error("two-PR stacked run failed:", e); }
}

// Q4. what the harness SAID about a tool call, against what its output happens to say (HOW-38's `is_error`):
// one call the harness failed whose output looks fine, one it passed whose output says "0 failed", and one
// written the way a log from before HOW-38 is — no verdict at all, and an output that starts like a failure.
await run("quick-task-mhv8tool", {
  graph: quickTask, cwd: API, name: "Run the gateway suite and report", inputs: { goal: "Run the gateway test suite and report what fails" },
  script: () => ({
    steps: [
      text("Running the suite first."),
      { t: "tool", name: "Bash", input: { command: "./gradlew :gateway:test 2>&1 | tail -3" }, result: "14 tests completed, 0 failed\nBUILD SUCCESSFUL in 6s", error: false },
      text("Green. Now the limits check, which needs the tenant table."),
      { t: "tool", name: "Bash", input: { command: "bun scripts/check-limits.ts --tenant-table" }, result: "limits table: 220 tenants read\n(the process was killed after 120s)", error: true },
      text("That one timed out. An older check, the way a run from before the harness reported a verdict recorded it:"),
      { t: "tool", name: "Bash", input: { command: "git -C ../acme-web status --short" }, result: "fatal: cannot change to '../acme-web': No such file or directory" },
      { t: "tool", name: "Read", input: { file_path: "gateway/README.md" }, result: "# Gateway\n\nHandles errors from upstream; a failed upstream is retried twice." },
    ],
    say: "The suite passes (14 tests, 0 failed). The limits check timed out after 120s and needs a faster tenant-table read.",
  }),
}, [3 * 60, 3 * 60 - 4], "finished quick-task: is_error true / false / absent on its tool results", "finished success");

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
    // HOW-68 final pass: a title long enough to wrap past three lines on the read-only card
    { id: "triage-bug.review", kind: "agent", title: "Review the fix against the original report, the reproduction notes and the failing test that proved it", prompt: "triage-bug.review", reads: ["goal", "fix_summary"], writes: ["review_verdict"], readOnly: true, position: { x: 760, y: 60 } },
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

// HOW-68: two more local graphs, for states no built-in reaches — a `parallel` step (HOW-73) and an
// opted-in acceptance GATE (HOW-72: `requiresAcceptance`, which is what makes the Waive controls show).
const reviewChange = {
  version: 1, name: "review-change", description: "Summarise a change, review it three ways at once, then give one verdict",
  defaults: { permissionMode: "auto" }, entry: "review-change.summarise", inputs: ["goal"],
  fields: [
    { key: "goal", kind: "text", scope: "sticky" },
    { key: "change_summary", kind: "text", scope: "sticky" },
    { key: "security_notes", kind: "text", scope: "sticky" },
    { key: "style_notes", kind: "text", scope: "sticky" },
    { key: "test_notes", kind: "text", scope: "sticky" },
    { key: "verdict", kind: "choice", scope: "cleared", choices: ["approve", "request-changes"] },
  ],
  nodes: [
    { id: "review-change.summarise", kind: "agent", prompt: "review-change.summarise", reads: ["goal"], writes: ["change_summary"], readOnly: true, position: { x: 300, y: 40 } },
    { id: "review-change.reviews", kind: "parallel", branches: ["review-change.security", "review-change.style", "review-change.tests"], join: "review-change.verdict", position: { x: 300, y: 180 } },
    { id: "review-change.security", kind: "agent", prompt: "review-change.security", reads: ["goal", "change_summary"], writes: ["security_notes"], readOnly: true, position: { x: 20, y: 330 } },
    { id: "review-change.style", kind: "agent", prompt: "review-change.style", reads: ["goal", "change_summary"], writes: ["style_notes"], readOnly: true, position: { x: 300, y: 330 } },
    { id: "review-change.tests", kind: "agent", prompt: "review-change.tests", reads: ["goal", "change_summary"], writes: ["test_notes"], readOnly: true, position: { x: 580, y: 330 } },
    { id: "review-change.verdict", kind: "agent", prompt: "review-change.verdict", reads: ["goal", "security_notes", "style_notes", "test_notes"], writes: ["verdict"], readOnly: true, position: { x: 300, y: 480 } },
    { id: "reviewed", kind: "terminal", outcome: "success", position: { x: 300, y: 620 } },
  ],
  edges: [
    { from: "review-change.summarise", to: "review-change.reviews" },
    { from: "review-change.verdict", to: "reviewed" },
  ],
};
const gatedPublish = {
  version: 1, name: "gated-publish", description: "Do the work, and hold the announcement until every acceptance criterion is met or waived",
  defaults: { permissionMode: "auto" }, entry: "gated-publish.criteria", inputs: ["goal"],
  fields: [
    { key: "goal", kind: "text", scope: "sticky" },
    { key: "acceptance", kind: "json", scope: "sticky" },
    { key: "work_summary", kind: "text", scope: "sticky" },
    { key: "announcement", kind: "text", scope: "sticky" },
  ],
  nodes: [
    { id: "gated-publish.criteria", kind: "agent", prompt: "gated-publish.criteria", reads: ["goal"], writes: ["acceptance"], readOnly: true, position: { x: 40, y: 60 } },
    { id: "gated-publish.work", kind: "agent", prompt: "gated-publish.work", reads: ["goal"], writes: ["work_summary"], position: { x: 40, y: 200 } },
    { id: "gated-publish.announce", kind: "agent", prompt: "gated-publish.announce", reads: ["goal", "work_summary", "acceptance"], writes: ["announcement"], requiresAcceptance: true, changesFiles: false, position: { x: 40, y: 340 } },
    { id: "announced", kind: "terminal", outcome: "success", position: { x: 40, y: 480 } },
  ],
  edges: [
    { from: "gated-publish.criteria", to: "gated-publish.work" },
    { from: "gated-publish.work", to: "gated-publish.announce" },
    { from: "gated-publish.announce", to: "announced" },
  ],
};
const stepBody = (what: string, reads: string[]) => `${what}\n\n${reads.map((r) => `## ${r}\n{{ context.${r} }}`).join("\n\n")}\n`;
const promptsFor = (spec: any, what: Record<string, string>) => Object.fromEntries(spec.nodes.filter((n: any) => n.kind === "agent").map((n: any) => [n.id, stepBody(what[n.id] ?? "Do this step.", n.reads)]));
for (const [spec, what] of [
  [reviewChange, { "review-change.summarise": "Summarise the change under review in five lines.", "review-change.security": "Review the change for security problems only.", "review-change.style": "Review the change against the repository's conventions only.", "review-change.tests": "Say what the change's tests cover and what they do not.", "review-change.verdict": "Give one verdict from the three reviews." }],
  [gatedPublish, { "gated-publish.criteria": "Write the acceptance criteria for this goal. Every row starts failing.", "gated-publish.work": "Do the work.", "gated-publish.announce": "Write the announcement of what was done." }],
] as Array<[any, Record<string, string>]>) {
  const res = await send("PUT", `/api/graphs/${spec.name}/builder`, { intent: "create", spec, prompts: promptsFor(spec, what) });
  note(`builder save ${spec.name}`, JSON.stringify(res).slice(0, 400));
}
try {
  const { loadLocalGraph } = await import(join(ROOT, "graphs/local.ts"));
  const localEngine = async (graph: string, id: string, name: string, cwd: string, script: ScriptFor) => {
    const g = await loadLocalGraph(HOME, graph, ROOT);
    return new Engine(g, { dir: join(RUNS, id), promptsDir: [join(HOME, "prompts"), PROMPTS], cwd, folderKind: "repo", name, executors: { agent: scriptedAgent(script) } });
  };
  const reviews: Record<string, NodeScript> = {
    "review-change.summarise": { steps: [tool("Bash", { command: "git diff main...HEAD --stat | tail -4" }, " api/src/main/kotlin/com/example/api/auth/Callback.kt | 41 ++++--\n api/src/test/kotlin/com/example/api/auth/CallbackTest.kt | 88 +++++\n 2 files changed, 121 insertions(+), 8 deletions(-)")], say: "The change caps the SSO redirect loop.", writes: { change_summary: "Caps the SSO callback at two redirects and renders a failure page on the third; adds CallbackTest (6 cases)." } },
    "review-change.security": { steps: [think("The counter rides in the state parameter. Is it signed?"), tool("Grep", { pattern: "rt=", path: "api/src" }, "api/src/main/kotlin/com/example/api/auth/Callback.kt:61")], say: "One finding.", writes: { security_notes: "The redirect counter `rt` is read from the unsigned state parameter: a hand-edited `rt=-1` buys an extra lap. Cap it server-side." } },
    "review-change.style": { steps: [tool("Read", { file_path: "api/src/main/kotlin/com/example/api/auth/Callback.kt" }, "     1\tpackage com.example.api.auth\n…")], say: "Follows the conventions.", writes: { style_notes: "Matches the handler conventions; one magic number (2) should be the existing MAX_REDIRECTS constant." } },
    "review-change.tests": { steps: [tool("Bash", { command: "./gradlew :api:test --tests '*CallbackTest*' 2>&1 | tail -3" }, "6 tests completed, 0 failed\nBUILD SUCCESSFUL in 18s")], say: "Covered, with one gap.", writes: { test_notes: "Six cases pass. Not covered: a state parameter with no `rt` at all (the pre-change clients)." } },
    "review-change.verdict": { say: "Request changes: the unsigned counter is a real hole.", writes: { verdict: "request-changes" } },
  };
  {
    const id = "review-change-mhv5pa7l";
    const r = await (await localEngine("review-change", id, "Review: cap the SSO redirect loop", API, (node) => reviews[node])).start({ goal: "Review the change on howdah/implement-ticket-mhs8q2lf before it merges" });
    retime(join(RUNS, id), 3 * 60, 3 * 60 - 14);
    note(id, `parallel run, finished → ${JSON.stringify(r)}`);
  }
  {
    // one branch fails: its siblings finish and keep what they published, then the run parks ONCE on it
    const id = "review-change-mhv6pb2x";
    const r = await (await localEngine("review-change", id, "Review: paginate /v2/invoices", API, (node) => node === "review-change.tests"
      ? { steps: [tool("Bash", { command: "./gradlew :api:test --tests '*InvoicesPageTest*' 2>&1 | tail -3" }, "error: no tests matched the filter '*InvoicesPageTest*'", true)], fail: { reason: "the agent stopped without its notes: \"there is no InvoicesPageTest on this branch — which tests is this change meant to be covered by?\"" } }
      : reviews[node])).start({ goal: "Review the pagination change on howdah/implement-ticket-mhv4d2e8" });
    retime(join(RUNS, id), 52, 44);
    if (r.state === "parked") await ring(id);
    note(id, `parallel run, one branch failed → ${JSON.stringify({ state: r.state, code: (r as any).code, node: (r as any).node })}`);
  }
  {
    const id = "gated-publish-mhv4ga9t";
    const rows = [
      { id: "ac-1", text: "The changelog entry names the breaking change to the pagination cursor", source: "goal", passes: false, evidence: null, check: "command" },
      { id: "ac-2", text: "The migration note has been read by the two teams that call /v2/invoices", source: "goal", passes: false, evidence: null, check: "human" },
      { id: "ac-3", text: "The 2.4.0 package is on the registry", source: "goal", passes: false, evidence: null, check: "after-publish" },
    ];
    const r = await (await localEngine("gated-publish", id, "Announce the invoices pagination change", API, (node) => node === "gated-publish.criteria"
      ? { say: "Three criteria.", writes: { acceptance: rows } }
      : node === "gated-publish.work" ? { steps: [tool("Edit", { file_path: "CHANGELOG.md", old_string: "## Unreleased", new_string: "## Unreleased\n\n- BREAKING: /v2/invoices is cursor-paginated" }, "The file CHANGELOG.md has been updated.")], say: "Changelog written.", writes: { work_summary: "Added the changelog entry and the migration note." } } : undefined)).start({ goal: "Announce the /v2/invoices pagination change to its two consumers" });
    retime(join(RUNS, id), 2 * 60, 105);
    if (r.state === "parked") await ring(id);
    note(id, `gated acceptance park → ${JSON.stringify({ state: r.state, code: (r as any).code, node: (r as any).node })}`);
  }
} catch (e) { console.error("local graph states failed", e); note("local-graph-states", "FAILED to seed: " + String(e)); }

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
  // HOW-68: a STALE proposal (drafted against a version the prompt has since left) and an ORPHANED
  // one (its prompt no longer exists) — the two states where Accept must be refused and say why
  writeFileSync(join(dir, "ticket.local_review.v3.proposal.md"), `---\nid: ticket.local_review\nbase_version: 2\nproposed_version: 3\nstatus: pending\ncreated: ${new Date(Date.now() - 6 * 24 * 3600_000).toISOString()}\n---\nReview the change against the ticket. Require a fix, or say nothing: never pass a change while listing a nit you could have required.\n`);
  writeFileSync(join(dir, "ticket.local_review.v3.reflection.md"), "One rejection on record: the reviewer passed a change while leaving a nit it could have required. Drafted against v2; the prompt has moved on to v4 since.\n");
  writeFileSync(join(dir, "ticket.local_review.v3.diff"), "--- ticket.local_review v2\n+++ ticket.local_review v3\n@@ end of template @@\n+Require a fix, or say nothing: never pass a change while listing a nit you could have required.\n");
  writeFileSync(join(dir, "ticket.triage.v2.proposal.md"), `---\nid: ticket.triage\nbase_version: 1\nproposed_version: 2\nstatus: pending\ncreated: ${new Date(Date.now() - 20 * 24 * 3600_000).toISOString()}\n---\nDecide whether this ticket is ready to be worked on. If it is not, say exactly what is missing.\n`);
  writeFileSync(join(dir, "ticket.triage.v2.reflection.md"), "Drafted when implement-ticket still had a triage step.\n");
  writeFileSync(join(dir, "ticket.triage.v2.diff"), "--- ticket.triage v1\n+++ ticket.triage v2\n@@ end of template @@\n+If it is not, say exactly what is missing.\n");
  const ps = (await get("/api/proposals")) as any[];
  note("pending proposals", JSON.stringify(ps.filter((x) => x.status === "pending").map((x) => [x.file, x.stale ? "stale" : "", x.stale_reason ?? ""])));
}
server.stop(true);

// ---- 4. HOW-68: an EMPTY home, so every empty state can be shot ------------------------------------
// `<scratch>/home-empty` has no runs, no workspaces and no local graphs; `<scratch>/repo-empty` is the
// repo copy with no proposals and no feedback. serve.sh starts a second viewer over the pair on PORT+1.
{
  const EMPTY_HOME = join(SCRATCH, "home-empty");
  const EMPTY_ROOT = join(SCRATCH, "repo-empty");
  for (const d of [EMPTY_HOME, EMPTY_ROOT]) rmSync(d, { recursive: true, force: true });
  mkdirSync(join(EMPTY_HOME, "runs"), { recursive: true });
  mkdirSync(join(EMPTY_HOME, "attention"), { recursive: true });
  saveConfig({ repos: {}, folders: {}, viewerBase: `http://localhost:${PORT + 1}` } as any, EMPTY_HOME);
  cpSync(ROOT, EMPTY_ROOT, { recursive: true, filter: (src) => !/\/node_modules(\/|$)/.test(src) && !/web\/public\/app\.(js|css)$/.test(src) && !/\/reviser\/proposals\/.+/.test(src) && !/\/feedback\/.+/.test(src) });
  symlinkSync(join(REPO, "node_modules"), join(EMPTY_ROOT, "node_modules"));
  note("empty home", `${EMPTY_HOME} (viewer on :${PORT + 1})`);
}

writeFileSync(join(SCRATCH, "seed-report.txt"), report.join("\n") + "\n");
console.log(`\nseeded ${report.length} items into ${HOME}${planOk ? "" : " (plan-feature had failures — see above)"}`);
process.exit(0);
