/**
 * Capability matrix per harness (OV-7 / A4.1): unsupported behaviour is DECLARED, not
 * discovered at runtime. The engine consults this before offering an affordance (resume
 * button, steer box, native review); the viewer greys out what a harness cannot do.
 *
 * Sources: agent-deck/spike-findings.md (claude 2.1.233, codex 0.137.0 — pin and re-verify
 * on upgrade), opencode entries are conservative until probed.
 */
import type { Harness } from "../core/graph";

export type Support = "yes" | "no" | "untested";

export interface HarnessCapabilities {
  /** resume a headlessly-created session interactively and back (S1) */
  resume: Support;
  /** fork a conversation as a protocol operation */
  fork: Support;
  /** answerable permission/approval round-trip over the protocol (S2) */
  permissions: Support;
  /** interrupt/cancel a running turn */
  interrupt: Support;
  /** steer a running turn with new input */
  steer: Support;
  /** per-turn token/cost usage reporting */
  usage: Support;
  /** rate-limit / allowance events on the wire */
  rate_limits: Support;
  /** server-pushed working diff (no git polling needed) */
  live_diff: Support;
  /** native code-review entrypoint */
  native_review: Support;
  /** CLI-supervised background sessions */
  background: Support;
  notes: string;
}

export const CAPABILITIES: Record<Harness, HarnessCapabilities> = {
  claude: {
    resume: "yes", // --session-id / --resume round-trips headless↔interactive (S1)
    fork: "yes", // --fork-session
    permissions: "yes", // --permission-prompt-tool stdio + can_use_tool/control_response (S2)
    interrupt: "yes", // control_request interrupt
    steer: "no", // no mid-turn steering; queue a follow-up turn instead
    usage: "yes", // result event: usage + total_cost_usd
    rate_limits: "yes", // rate_limit_event
    live_diff: "no", // git diff is the source on the claude side
    native_review: "no",
    background: "yes", // claude --bg / agents --json (S5)
    notes: "permission round-trip REQUIRES --permission-prompt-tool stdio; manual alone dead-ends",
  },
  codex: {
    resume: "yes", // thread/resume recovers prior turns (S1); resume by explicit id, not the picker
    fork: "yes", // thread/fork
    permissions: "yes", // item/*/requestApproval answered {decision} (S2)
    interrupt: "yes", // turn/interrupt
    steer: "yes", // turn/steer
    usage: "yes", // thread/tokenUsage/updated + turn/completed
    rate_limits: "yes", // account/rateLimits/updated
    live_diff: "yes", // turn/diff/updated
    native_review: "yes", // review/start
    background: "no", // no --bg equivalent; app-server hosts sessions instead
    notes: "pin version; stderr carries full system prompts — never surface it",
  },
  cursor: {
    // HOW-17: cursor-agent is not installed on this machine, so nothing here has been probed
    // against a live CLI. Everything the spike did not verify stays "untested" — a declared
    // unknown is the point of this matrix, and claiming support we have not seen would make
    // the viewer offer an affordance that dead-ends.
    resume: "untested", // --resume <chat-id> is documented; the round-trip is unverified
    fork: "untested",
    permissions: "no", // print mode has no approval round-trip on the wire: it is --force or nothing
    interrupt: "no",
    steer: "no",
    usage: "untested",
    rate_limits: "untested", // no allowance event observed; the fallback falls back on text
    live_diff: "no",
    native_review: "no",
    background: "untested",
    notes: "unprobed: cursor-agent is not installed here. Approvals are a spawn-time flag, not a wire round-trip",
  },
  opencode: {
    resume: "untested",
    fork: "untested",
    permissions: "untested",
    interrupt: "untested",
    steer: "no",
    usage: "untested",
    rate_limits: "no",
    live_diff: "no",
    native_review: "no",
    background: "no",
    notes: "placeholder adapter — probe before routing real work here",
  },
};
