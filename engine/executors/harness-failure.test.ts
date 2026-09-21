/**
 * A harness CLI that dies before it speaks.
 *
 * The case that drove this: `claude` was not logged in. It wrote "Please run /login" to
 * stderr and exited, and because nothing read the exit code the attempt fell through to the
 * outputs check and parked as `attempt-failed` with "[output contract violation]" — the model
 * blamed for a problem it never saw, while the CLI's own explanation sat in a stderr file the
 * viewer never reads.
 *
 * What is pinned here: an exit that produced no protocol output is diagnosed from the exit
 * code and stderr, an auth failure gets its own park code so the operator is told which verb
 * fixes it, an unrecognised failure still carries the CLI's words, and a CLI that DID speak
 * is left alone so the turn-error and outputs paths keep their better information.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../run";
import { claudeExecutor } from "./claude";
import { defineGraph } from "../../core/graph";
import { REPLY_RULES } from "../control";
import { classifyHarnessExit, looksUnauthenticated, probeAuth, stderrTail, type ProbeRun } from "./harness-failure";
import { harnessNames, harnessSpec } from "../../core/harnesses";

const exit = (over: Partial<Parameters<typeof classifyHarnessExit>[0]> = {}) =>
  classifyHarnessExit({ harness: "claude", exitCode: 1, stderr: "", sawOutput: false, ...over });

describe("classifying a harness exit", () => {
  test("an auth failure is named, with the CLI's own words and the verb that fixes it", () => {
    const c = exit({ stderr: "Invalid API key · Please run /login" });
    expect(c?.code).toBe("harness-unauthenticated");
    expect(c?.reason).toContain("not logged in");
    expect(c?.reason).toContain("claude auth login");
    expect(c?.reason).toContain("Please run /login"); // the operator sees what the CLI said
  });

  test("codex is told to run ITS login verb, not claude's", () => {
    const c = exit({ harness: "codex", stderr: "not logged in" });
    expect(c?.reason).toContain("codex login");
    expect(c?.reason).not.toContain("auth login");
  });

  test("an unrecognised startup failure still reaches the human intact", () => {
    const c = exit({ exitCode: 127, stderr: "dyld: Library not loaded: libfoo.dylib" });
    // no guess about auth, but no contract complaint either
    expect(c?.code).toBe("attempt-failed");
    expect(c?.reason).toContain("exited 127 before producing any output");
    expect(c?.reason).toContain("libfoo.dylib");
  });

  test("a silent non-zero exit says so rather than inventing a cause", () => {
    expect(exit({ exitCode: 3 })?.reason).toContain("Nothing was written to stderr");
  });

  test("a CLI that spoke the protocol is not this module's business", () => {
    // even with auth-shaped noise on stderr: it started, so the turn error knows more
    expect(exit({ sawOutput: true, stderr: "unauthorized" })).toBeNull();
  });

  test("a clean exit, and one WE killed, are both left alone", () => {
    expect(exit({ exitCode: 0 })).toBeNull();
    expect(exit({ exitCode: null, stderr: "please log in" })).toBeNull(); // null = we killed it
  });

  test("the stderr tail is trimmed from the END and stays bounded", () => {
    const long = "x".repeat(50) + "\n" + "y".repeat(2000);
    const tail = stderrTail(long, 100);
    expect(tail.length).toBeLessThanOrEqual(102);
    expect(tail.endsWith("y")).toBe(true);
    expect(stderrTail("   \n  \n ")).toBe("");
  });

  test("the auth patterns cover the wordings both CLIs actually use", () => {
    for (const s of [
      "Please run /login",
      "You are not logged in",
      "Invalid API key",
      "Authentication failed",
      "401 Unauthorized",
      "OAuth token has expired",
      "credentials are invalid",
    ])
      expect(looksUnauthenticated(s)).toBe(true);
    for (const s of ["rate limit exceeded", "ENOENT", "model overloaded"]) expect(looksUnauthenticated(s)).toBe(false);
  });
});

describe("probing whether a harness is logged in", () => {
  const fake = (out: string, code = 0): ProbeRun => () => ({ code, stdout: out, stderr: "" });

  test("claude's JSON is believed over the exit code", () => {
    expect(probeAuth("claude", fake('{"loggedIn": true, "email": "x@y.z"}'))).toBe("in");
    expect(probeAuth("claude", fake('{"loggedIn": false}'))).toBe("out");
    // exit 0 with loggedIn:false must still read as out — the boolean is the answer
    expect(probeAuth("claude", fake('{"loggedIn": false}', 0))).toBe("out");
  });

  test("codex's prose is read, in both directions", () => {
    expect(probeAuth("codex", fake("Logged in using an API key - sk-***"))).toBe("in");
    expect(probeAuth("codex", fake("Not logged in", 1))).toBe("out");
  });

  test("an absent CLI or an unknown harness is `unknown`, never `out`", () => {
    // an old CLI without the subcommand must not be reported as logged out
    expect(probeAuth("claude", () => null)).toBe("unknown");
    expect(probeAuth("nonesuch", fake("whatever"))).toBe("unknown");
    expect(probeAuth("claude", fake("some future wording", 0))).toBe("unknown");
  });

  test("what is spawned is the table's declared probe, for every harness", () => {
    // not a second list maintained here: cursor is probed because its entry says how to ask
    const spawnedFor = (name: string): string[] | undefined => {
      let spawned: string[] | undefined;
      probeAuth(name, (argv) => {
        spawned = argv;
        return { code: 0, stdout: "", stderr: "" };
      });
      return spawned;
    };
    expect(spawnedFor("cursor")).toEqual(["cursor-agent", "status"]);
    for (const name of harnessNames()) {
      const spec = harnessSpec(name);
      const expected = spec.status === "internal" ? undefined : (spec.authProbe as string[] | undefined);
      expect(spawnedFor(name)).toEqual(expected);
    }
  });

  test("a harness with no CLI of its own is never probed — opencode runs through claude's", () => {
    // probing it would spawn `claude auth status` and report the answer under opencode's name
    let spawned = false;
    expect(probeAuth("opencode", () => {
      spawned = true;
      return { code: 0, stdout: '{"loggedIn": true}', stderr: "" };
    })).toBe("unknown");
    expect(spawned).toBe(false);
  });
});

describe("the park it produces", () => {
  const rule = REPLY_RULES["harness-unauthenticated"];

  test("a reply rule exists for the code, and it accepts the retry on an agent node", () => {
    expect(rule).toBeDefined();
    expect(rule({ node: "draft", run: "r1", kind: "agent", retryOverBudget: undefined, requires: undefined })).toEqual({ accept: true });
  });

  test("a refusal leads with logging in, because that is what actually unblocks the run", () => {
    const r = rule({ node: "cmd", run: "r1", kind: "command", retryOverBudget: undefined, requires: undefined });
    expect(r.accept).toBe(false);
    expect(r.accept === false && r.message).toContain("log the harness in first");
  });
});

describe("end to end, against a CLI that is not logged in", () => {
  /** a `claude` that behaves exactly as a logged-out one does: stderr, no stdout, exit 1 */
  function loggedOutBinary(dir: string): string {
    const p = join(dir, "logged-out-claude");
    writeFileSync(p, "#!/bin/sh\necho 'Invalid API key · Please run /login' >&2\nexit 1\n");
    chmodSync(p, 0o755);
    return p;
  }

  test("the run parks on harness-unauthenticated, naming the cause instead of the contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-auth-"));
    const prompts = mkdtempSync(join(tmpdir(), "howdah-p-"));
    writeFileSync(join(prompts, "doc.draft.md"), `---\nid: doc.draft\nversion: 1\n---\nDraft toward {{ context.goal }}.\n`);
    const graph = defineGraph<{ goal: string; doc_summary: string }>({
      name: "mini-auth",
      entry: "draft",
      inputs: ["goal"],
      nodes: {
        draft: { kind: "agent", prompt: "doc.draft", reads: ["goal"], writes: { doc_summary: { scope: "sticky" } } },
        done: { kind: "terminal", outcome: "success" },
      },
      edges: [{ from: "draft", to: "done" }],
    });
    const engine = new Engine(graph, {
      dir,
      promptsDir: prompts,
      executors: { agent: claudeExecutor({ attentionDir: join(dir, "attn"), binary: loggedOutBinary(dir), askPollMs: 30, notifiers: [] }) },
    });

    const result = await engine.start({ goal: "anything" });
    expect(result).toMatchObject({ state: "parked", node: "draft", code: "harness-unauthenticated" });
    expect(result).toHaveProperty("reason");
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("not logged in");
    expect(reason).toContain("claude auth login");
    // the regression: this used to be an outputs-contract complaint about the model
    expect(reason).not.toContain("output contract");

    const events = engine.log.read();
    const park: any = events.findLast((e: any) => e.type === "attention-raised");
    expect(park.code).toBe("harness-unauthenticated");
    // and the CLI's own words are IN THE LOG, not only in a stderr file nothing reads
    const text = events.filter((e: any) => e.type === "chunk").map((e: any) => e.content).join("");
    expect(text).toContain("Please run /login");
  }, 20_000);
});
