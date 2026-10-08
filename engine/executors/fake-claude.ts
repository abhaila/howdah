#!/usr/bin/env bun
/**
 * A fake `claude` binary for executor tests: speaks the stream-json wire protocol
 * (verified shapes from agent-deck spikes) without spending tokens. Reads the user turn
 * from stdin, streams deltas, optionally demands a permission (FAKE_CLAUDE_ASK=1) and
 * honours the control_response, then emits the outputs contract and a result event.
 *
 * FAKE_CAPTURE=<file> appends the exact prompt text of EVERY user turn received on stdin
 * (one JSON string per line, in order) so tests can prove rendered_hash covers the bytes
 * of the first turn (system-map 0.1); an in-session repair turn lands on a later line.
 * FAKE_CLAUDE_DROP_OUTPUTS=1 ends the first turn in prose with no contract.
 * FAKE_CLAUDE_QUESTION asks the OPERATOR a question (HOW-25) — see the block below.
 * FAKE_CLAUDE_CONTEXT (HOW-14), shapes from claude 2.1.283's SDK types, not a captured turn:
 *   compact  emit a `compact_boundary` mid-turn, then finish normally
 *   exceed   end the first turn with `result { is_error: true, result: "Prompt is too long" }`
 *   exceed-once  as `exceed` for the first spawn only; FAKE_CLAUDE_CONTEXT_STATE=<file> remembers
 *                it across the one-process-per-attempt spawns
 *
 * FAKE_CLAUDE_SCRIPT=<file.json> scripts whole turns (system-map 1c E2E): a list of turns,
 * each `{ match, outputs?, edits?, commit? }`. A turn applies when `match` is one of the output
 * keys the contract demands; turns are consumed in order (a `<file>.state` file remembers which
 * ran, across the one-process-per-turn spawns), and the last matching turn repeats once the
 * others are used. `edits` ({path, content} | {path, delete: true}) are applied relative to the
 * cwd — the run's worktree — and `commit` commits everything with that message. Keys the turn
 * does not set get the usual fake values.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

const decoder = new TextDecoder();
let buffer = "";
const lines: string[] = [];
let wake: () => void = () => {};

(async () => {
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      lines.push(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      wake();
    }
  }
})();

async function nextLine(): Promise<string> {
  for (;;) {
    const line = lines.shift();
    if (line !== undefined) return line;
    await new Promise<void>((r) => (wake = r));
  }
}

const userTurn = JSON.parse(await nextLine()) as { message: { content: Array<{ text: string }> } };
const promptText = userTurn.message.content[0]?.text ?? "";
if (process.env.FAKE_CAPTURE) appendFileSync(process.env.FAKE_CAPTURE, JSON.stringify(promptText) + "\n");

out({ type: "system", subtype: "init", session_id: "fake-session-0001" });
out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Working on it — " } } });
out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "doing the thing. 🐘" } } });

const contextMode = process.env.FAKE_CLAUDE_CONTEXT;
if (contextMode === "compact")
  out({ type: "system", subtype: "compact_boundary", session_id: "fake-session-0001", compact_metadata: { trigger: "auto", pre_tokens: 167000 } });
const contextState = process.env.FAKE_CLAUDE_CONTEXT_STATE;
const exceedOnce = contextMode === "exceed-once" && contextState !== undefined && !existsSync(contextState);
if (exceedOnce) writeFileSync(contextState!, "exceeded");
if (contextMode === "exceed" || exceedOnce) {
  out({ type: "result", subtype: "success", is_error: true, usage: { input_tokens: 200000, output_tokens: 0 }, total_cost_usd: 0, result: "Prompt is too long" });
  process.exit(0);
}

if (process.env.FAKE_CLAUDE_ASK === "1") {
  out({
    type: "control_request",
    request_id: "req-42",
    request: {
      subtype: "can_use_tool", tool_name: "Write", display_name: "Write",
      input: { file_path: "out.txt", content: "hi" },
      permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    },
  });
  // wait for the control_response before continuing — the real CLI blocks here too
  for (;;) {
    const line = JSON.parse(await nextLine()) as any;
    if (line.type === "control_response" && line.response?.request_id === "req-42") {
      const behavior = line.response?.response?.behavior;
      out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: behavior === "allow" ? " Permission granted, wrote the file." : " Denied, skipping the write." } } });
      break;
    }
  }
}

/**
 * HOW-25: an AskUserQuestion, in the exact envelope the real CLI sends — captured into
 * adapter/fixtures/claude-ask-user-question.jsonl. It is a `can_use_tool` carrying
 * `requires_user_interaction`, NOT a permission, and the only channel back is the deny
 * `message`, so the fake asserts what the real one does: it blocks until answered, and it
 * echoes the message it was given so a test can prove the operator's words got through.
 *
 * FAKE_CLAUDE_QUESTION=1        one single-select question
 * FAKE_CLAUDE_QUESTION=multi    two questions, the second multi-select
 * FAKE_CLAUDE_QUESTION_DIE=1    exit while the question is still pending (the freeze case)
 */
if (process.env.FAKE_CLAUDE_QUESTION) {
  const multi = process.env.FAKE_CLAUDE_QUESTION === "multi";
  const questions = [
    {
      question: "Which approach should I take?",
      header: "Approach",
      options: [
        { label: "Approach A", description: "Take Approach A." },
        { label: "Approach B", description: "Take Approach B." },
      ],
      multiSelect: false,
    },
    ...(multi
      ? [{
          question: "Which files may I touch?",
          header: "Scope",
          options: [{ label: "src" }, { label: "tests" }],
          multiSelect: true,
        }]
      : []),
  ];
  const toolUseId = "toolu_fake_auq_01";
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: { questions } }] } });
  out({
    type: "control_request",
    request_id: "req-auq",
    request: {
      subtype: "can_use_tool", tool_name: "AskUserQuestion", display_name: "AskUserQuestion",
      input: { questions }, tool_use_id: toolUseId, requires_user_interaction: true,
    },
  });
  if (process.env.FAKE_CLAUDE_QUESTION_DIE === "1") process.exit(7); // nobody will ever answer
  for (;;) {
    const line = JSON.parse(await nextLine()) as any;
    if (line.type === "control_response" && line.response?.request_id === "req-auq") {
      const message = String(line.response?.response?.message ?? "");
      if (process.env.FAKE_CAPTURE_ANSWER) writeFileSync(process.env.FAKE_CAPTURE_ANSWER, message);
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: message, is_error: true }] } });
      out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: ` Got it: ${message}` } } });
      break;
    }
  }
}

if (process.env.FAKE_CLAUDE_RATELIMIT === "1")
  out({ type: "rate_limit_event", rate_limit: { status: "allowed", remaining: 0.31, resetsAt: "2026-09-13T18:00:00Z" } });

// derive the demanded output keys from the appended contract so tests exercise parsing
const demandedKeys = (text: string) => [...text.matchAll(/"([\w.]+)": <value>/g)].map((m) => m[1]!);
const fakeValue = (k: string) => (k === "review_verdict" ? (process.env.FAKE_CLAUDE_VERDICT ?? "pass") : `fake ${k}`);
const keys = demandedKeys(promptText);
const outputs: Record<string, unknown> = Object.fromEntries(keys.map((k) => [k, fakeValue(k)]));

interface ScriptTurn {
  match: string;
  outputs?: Record<string, unknown>;
  edits?: Array<{ path: string; content?: string; delete?: boolean }>;
  commit?: string;
}
const scriptPath = process.env.FAKE_CLAUDE_SCRIPT;
if (scriptPath) {
  const turns = (JSON.parse(readFileSync(scriptPath, "utf8")) as { turns: ScriptTurn[] }).turns;
  const statePath = `${scriptPath}.state`;
  const used: number[] = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : [];
  const candidates = turns.map((t, i) => [t, i] as const).filter(([t]) => keys.includes(t.match));
  const pick = candidates.find(([, i]) => !used.includes(i)) ?? candidates.at(-1);
  if (pick) {
    const [turn, i] = pick;
    writeFileSync(statePath, JSON.stringify([...used, i]));
    for (const edit of turn.edits ?? []) {
      const target = join(process.cwd(), edit.path);
      if (edit.delete) rmSync(target, { force: true });
      else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, edit.content ?? "");
      }
    }
    if (turn.commit) {
      const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=fake", "-c", "user.email=fake@fake", "-c", "commit.gpgsign=false", ...args], { cwd: process.cwd() });
      git("add", "-A");
      git("commit", "-q", "-m", turn.commit);
    }
    Object.assign(outputs, turn.outputs ?? {});
  }
}

const emitResult = (result: string) =>
  out({
    type: "result", subtype: "success", is_error: false,
    usage: { input_tokens: 321, output_tokens: 45 }, total_cost_usd: 0.0042,
    result,
  });

// FAKE_CLAUDE_DROP_OUTPUTS=1 reproduces the live failure (6a31486): a long turn ending in
// prose with no contract. The real CLI stays open for more stdin turns, so the executor's
// repair turn is answered on the same session — with the outputs this turn produced.
if (process.env.FAKE_CLAUDE_DROP_OUTPUTS === "1" && keys.length) {
  emitResult("Verified the shared renderer and the affected integration cases. No files modified.");
  const repair = JSON.parse(await nextLine()) as { message: { content: Array<{ text?: string }> } };
  const repairText = repair.message.content[0]?.text ?? "";
  if (process.env.FAKE_CAPTURE) appendFileSync(process.env.FAKE_CAPTURE, JSON.stringify(repairText) + "\n");
  const repaired = Object.fromEntries(demandedKeys(repairText).map((k) => [k, k in outputs ? outputs[k] : fakeValue(k)]));
  emitResult(`All done.\n{"outputs": ${JSON.stringify(repaired)}}`);
} else {
  emitResult(`All done.\n{"outputs": ${JSON.stringify(outputs)}}`);
}
process.exit(0);

