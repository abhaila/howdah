# ticket.local_review v3 — the skeptical evaluator (HOW-53)

Drafted by hand from cwc-long-running-agents' `evaluator.md`, not from run feedback, so it is
marked pending until it is MEASURED rather than assumed better.

## What changes

- **Order.** The reviewer reads the ticket and the acceptance contract first, then the diff, then
  the harness's evidence, and only then the builder's summary — as a list of claims to check.
  v2 read the summary before anything else, which anchors the review on the builder's account.
- **Stance.** "You do not trust the account of the agent that did" and "plausibility is not
  correctness" (cwc's wording): a summary that says the tests pass is not evidence that they do.
- **Missing evidence is NEEDS_WORK.** A live criterion with no evidence makes the verdict
  `reject`, with a finding naming the evidence that would settle it. v2 only told it to leave the
  criterion false.
- **A pass names its evidence per criterion** — already enforced structurally by the acceptance
  contract (core/acceptance.ts), restated so the verdict and the flips agree.
- **"Do not offer to fix anything yourself."** The node is already `readOnly` (plan mode, and
  the executor refuses every permission request), so this is the prompt agreeing with the harness.

## Reads

Unchanged: goal, work, implementation_plan, implementation_summary, verify.result,
evidence.items, acceptance — every one already declared by implement-ticket's
`implementation.local_review`, so the accept guard's undeclared-read check passes.
`verify.result` arrives, as in v2, through the shared `{{> review._verify_result }}` partial
(HOW-40) rather than an inline copy, placed at step 3; the proposal records
`base_includes: {"review._verify_result":1}` so it goes stale if that partial moves.

## How it is to be judged (open)

HOW-53 asks for an A/B stamp before acceptance: the stock prompt (v2) against this one on cases
with planted defects (missing evidence, a wrong computation, broken argument handling, a
"verified" claim with nothing behind it — the four cwc's evaluator caught for $0.03), comparing
defects caught, false rejects and cost. That harness is HOW-42 (paired A/B evaluation), still in
backlog, so this proposal stays `pending` and unstamped. Accept or reject it on those numbers.
