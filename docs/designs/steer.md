# Steering a running agent (HOW-47) — spike result and mechanism

## The question

HOW-47 offered two ways to say something to a running agent turn without pausing it:

- **A. A stdin user message** on the claude executor's existing stream-json channel.
- **B. A PreToolUse hook** passed via `--settings`, which blocks the next tool call with the
  note as its reason (cwc-long-running-agents' `steer.sh`). Proven, but it costs the blocked
  call, which the agent must reissue.

The recommendation was A if a spike showed the agent treats the message as authoritative.

## The spike (2026-10-12, claude 2.1.296, haiku)

A headless `claude -p --input-format stream-json --output-format stream-json
--replay-user-messages --setting-sources project,local` session was asked to run three
`sleep 2 && echo …` commands one at a time. As soon as the first `tool_use` appeared on stdout, a
second stream-json user message was written to stdin:

> [OPERATOR STEERING — from the human operator running this session, not from a tool] Change of
> plan: skip the remaining commands, and end your final reply with the single word PINEAPPLE.

The wire, pinned in `adapter/fixtures/claude-steer.jsonl` (stream deltas dropped):

1. `assistant` — `tool_use` Bash `sleep 2 && echo one`. **The steer was written here.**
2. `user` — `tool_result` "one". The tool call was **not lost**.
3. `user { isReplay: true }` — the steer, echoed back. It arrived **after** the tool result, as
   its own user message rather than inside the result, even though it was written ~4s earlier.
4. `assistant` — "Only the first command ran … Per your steering message, I skipped … PINEAPPLE".
5. One `result` — the agent adopted the steer **in the same turn**; no extra turn.

So A works, and the agent treated the labelled message as the operator's. **Mechanism A is the
one built.** B stays undone: it would cost a tool call per steer and needs a second channel
from the engine to a hook.

## How Howdah uses it

- **Recording.** `POST /api/runs/:id/steer` and `howdah steer <run> <text>` both call
  `engine/steer.ts steer()`. It refuses a run that is finished, paused, parked (use reply), on a
  dead runner, between steps, or on a harness whose `core/harnesses.ts` `steer` is null. It
  re-checks inside the log lock and appends `operator-steered`.
- **Delivery.** The claude executor polls the log for this node@visit's steers. It writes one to
  stdin **only while a tool call is in flight**, so the CLI delivers it at that tool's result
  boundary. Writing while the model is only producing text could queue it behind the turn's
  end, where the CLI would run it as a fresh turn nobody is reading.
- **Proof.** `--replay-user-messages` echoes every consumed stdin message. When the echo of a
  steer arrives, the executor appends `steer-delivered` with `after_tool_id`, the tool call it
  rode in after. The transcript draws the steer exactly there.
- **The race.** If the turn ends before another tool call, the steer was never written. The
  engine carries it into the run's next agent render (suffix v6 `steerInstruction`), logs the
  seqs as `prompt-rendered.steers_carried`, and reconstruction reads the same texts, so the
  render stays VERIFIED. If a steer was written but never echoed (a millisecond-wide window
  where the tool finished just as it was written), the executor kills the CLI rather than let
  it run the queued steer as an unread turn, and skips the outputs-repair turn.
- **Not a trust boundary in the worktree.** cwc's `STEER.md` lives where the agent can write
  it. Howdah's channel is the run's own log, appended by the operator's server or CLI.

## Not covered

codex, cursor and opencode-through-codex have no verified channel. `steer: null` reads "steer:
not supported" in the route and the composer. codex's app-server has steer-shaped methods. Pin
one in a fixture before turning it on.
