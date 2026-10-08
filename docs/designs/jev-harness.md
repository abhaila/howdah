---
shaping: true
---

# Jev in Howdah — the harness's own classifier — Shaping

Opened 2026-09-26. Scope chosen by the operator: **the dangerous-action classifier plus model
routing** — the two patterns LangChain ships as middleware
([Building a Harness with Jev](https://www.langchain.com/blog/building-a-harness-with-jev)).

Background research: `docs/notes/2026-09-26-typesafe-jev-research.md`. Teaching workspace:
`docs/teaching/`. Entry point: **S** (shapes first, requirements extracted from them).

## Source

> Coding harnesses like claude, codex, cursor have shipped some kind of way to classify
> dangerous actions before they're taken which has slowly helped to build trust in agents.
> Up until now, this classifier step has been locked away in the closed source parts of the
> harness. Now that a cheap and performant classifier model exists, we can take the same
> pattern and adopt it to all agents!
>
> — LangChain, *Building a Harness with Jev*, 2026-09-17

> `AutoModeMiddleware` uses Jev to check tool calls for risky decisions it may take, and
> block calls before the tool executes.

---

## CURRENT: the classifier is three vendors', not Howdah's

| Part | Mechanism | Flag |
|------|-----------|:----:|
| **CUR1** | Each harness runs at its own forced permission level: claude `forcedPermissionMode: "auto"` (`core/harnesses.ts:81`), codex a full-access sandbox, cursor `--force` | |
| **CUR2** | Claude can ask mid-turn: `can_use_tool` → `answerPermission()` (`engine/executors/claude.ts:157-167`) parks the run, relays the operator's allow/deny down stdin | |
| **CUR3** | 🟡 **CURSOR** cannot ask: it decides approvals from a SPAWN-TIME flag (`engine/executors/cursor.ts:17`: *"There is no approval round-trip on the wire"*). **Codex CAN** — `item/<kind>/requestApproval` → `answerApproval()` (`engine/executors/codex.ts:104`), `approvalPolicy: "on-request"` (:186), *"routed through the same attention round-trip as claude"* (:7-9). Corrected 2026-09-26 after review; the original entry generalised cursor's comment to both | |
| **CUR4** | Howdah's only safety lever is `readOnly: true` — all-or-nothing, applied last, beating every layer | |
| **CUR5** | WHICH actions are dangerous is decided inside each vendor's closed classifier. No Howdah policy, no visibility, no record | ⚠️ |
| **CUR6** | Model/harness resolution is a 7-layer first-wins chain (`resolveAgentConfig`, `engine/run.ts`): fallback → run override → UI node tuning → TS node → UI graph tuning → TS graph default → `config.json` | |
| **CUR7** | 🟡 The fallback chain can hop a node from an asking harness to cursor mid-run (HOW-17). The HARNESS change IS logged (`prompt-rendered.harness`, `log/events.ts:281`); what is not logged is the **resolved `permissionMode` for the attempt** — `run-started` carries only run-level overrides. Corrected 2026-09-26: the original claim ("no record that the governing policy changed") is disprovable in one grep | ⚠️ |

---

## Requirements (R) — extracted from the shapes

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | Howdah has its OWN policy on what an agent may do, expressed once and applied whatever harness runs the node | Core goal |
| R1 | The policy is uniform across claude, codex and cursor — a node is governed the same way wherever it lands, including after a fallback hop | Must-have |
| R2 | A policy decision is a fact in the log, with the question asked, the probabilities returned and the thresholds in force | Must-have |
| R3 | Uncertainty reaches a human rather than resolving itself — a low-confidence judgement parks, it does not guess in either direction | Must-have |
| R4 | The engine never blocks on the network: an unreachable or slow classifier degrades to today's behaviour, not to a failed run | Must-have |
| R5 | Thresholds that gate an action are set from recorded evidence, not from intuition | Must-have |
| R6 | State sent to the classifier is treated as hostile — an injected instruction in a diff or a repo file cannot widen what the agent may do | Must-have |
| R7 | The model a node runs on can be chosen from what the node is actually trying to do, without overriding a choice a human made explicitly | Nice-to-have |
| R8 | Nothing added here can make a run less safe than it is today | Must-have |

### Where each requirement comes from

| R | Evidence |
|---|----------|
| R0 | CUR5 — the classifier is closed and per-vendor |
| R1 | CUR3 + CUR7 — two of three harnesses cannot be asked, and a hop changes the governing policy silently |
| R2 | "The log is the only storage" (CLAUDE.md); a park needs its evidence |
| R3 | "Nothing dead-ends silently… parking is normal control flow" |
| R4 | Howdah runs offline against local CLIs on subscription auth |
| R5 | Research note §10: Tier A had NO corpus; §11: the first candidate was unfalsifiable on real data |
| R6 | jev-1.13 jaggedness #6: *"State is data, and jev-1.13 does not treat it as hostile by default"* |
| R7 | LangChain `ModelRouterMiddleware`; CUR6 already has the layer chain to slot into |
| R8 | The floor for any safety change |

---

## A: At the wire — classify the tool call

| Part | Mechanism | Flag |
|------|-----------|:----:|
| **A1** | In `answerPermission` (`claude.ts:157`), before parking: send `{tool_name, input, cwd, node, goal}` as state to Jev with a risk Choice + companion Nouls (writes outside the worktree? network egress? destroys unrecoverable work?) | |
| **A2** | Thresholds in one file decide: high-confidence safe → auto-allow and log; high-confidence dangerous → deny with the reason; anything else → today's park | |
| **A3** | `policy-judged` event carries question ids, probabilities, model version, thresholds | |
| **A4** | 🟡 Cursor only is unreachable. Claude and codex both already hand `tool_name` + `input` to an attention round-trip, which IS A1's payload. Cursor is `optional` in `core/harnesses.ts` and has **never executed a node here** (384/384 `prompt-rendered` events are claude), so A covers 2 of 3 harnesses and 100% of runs to date | |

## B: At the gate — classify the node, not the call

| Part | Mechanism | Flag |
|------|-----------|:----:|
| **B1** | Before a node spawns, Jev scores the node's INTENT (rendered prompt, declared writes, cwd, worktree-or-not) on a blast-radius rubric | |
| **B2** | The score picks a permission mode / `readOnly`, fed into `resolveAgentConfig` as a new layer; spawn-time, so it works identically for all three harnesses | |
| **B3** | `policy-judged` as A3, plus the resolved mode, before the first token | |
| **B4** | Coarse: one decision per node. Cannot catch an action the agent decides on halfway through a turn | |

## C: Both, over one policy module

| Part | Mechanism | Flag |
|------|-----------|:----:|
| **C1** | `systemone/policy.ts` — every question and threshold in ONE node-free module, the `core/harnesses.ts` pattern. The only place the vocabulary is written | |
| **C2** | Pre-flight enforcement for every harness (= B1+B2), the uniform floor | |
| **C3** | Wire enforcement where the harness supports it (= A1+A2), the precise ceiling; absence is recorded, never silently skipped | |
| **C4** | One `policy-judged` event type serves both call sites, carrying which one produced it | |
| **C5** | A fallback hop re-runs the pre-flight for the harness it lands on, so CUR7's silent policy change becomes an explicit, logged one | |

## D: Observe only — judge everything, enforce nothing

| Part | Mechanism | Flag |
|------|-----------|:----:|
| **D1** | C1's policy module and both call sites, but the verdict is written to the log and the viewer and changes no behaviour | |
| **D2** | Produces the labelled corpus R5 demands: every judgement paired with what actually happened | |
| **D3** | Promotion to enforcement is a threshold config change, once the corpus says where the thresholds go | |

---

## Fit Check

| Req | Requirement | Status | A | B | C | D |
|-----|-------------|--------|---|---|---|---|
| R0 | Howdah has its OWN policy on what an agent may do, expressed once and applied whatever harness runs the node | Core goal | ❌ | ✅ | ✅ | ❌ |
| R1 | The policy is uniform across claude, codex and cursor — a node is governed the same way wherever it lands, including after a fallback hop | Must-have | ❌ | ✅ | ✅ | ❌ |
| R2 | A policy decision is a fact in the log, with the question asked, the probabilities returned and the thresholds in force | Must-have | ✅ | ✅ | ✅ | ✅ |
| R3 | Uncertainty reaches a human rather than resolving itself — a low-confidence judgement parks, it does not guess in either direction | Must-have | ✅ | ✅ | ✅ | ❌ |
| R4 | The engine never blocks on the network: an unreachable or slow classifier degrades to today's behaviour, not to a failed run | Must-have | ✅ | ✅ | ✅ | ✅ |
| R5 | Thresholds that gate an action are set from recorded evidence, not from intuition | Must-have | ❌ | ❌ | ❌ | ✅ |
| R6 | State sent to the classifier is treated as hostile — an injected instruction in a diff or a repo file cannot widen what the agent may do | Must-have | ❌ | ❌ | ✅ | ✅ |
| R7 | The model a node runs on can be chosen from what the node is actually trying to do, without overriding a choice a human made explicitly | Nice-to-have | ❌ | ✅ | ✅ | ❌ |
| R8 | Nothing added here can make a run less safe than it is today | Must-have | ❌ | ❌ | ✅ | ✅ |

**Notes:**
- 🟡 A still fails R0/R1, but NARROWLY and for one reason only: cursor. The original note ("claude only, two of three ungoverned") was wrong — codex has the same round-trip. R1 says *all three*, and a fallback hop can still land on cursor, so the binary check stays ❌; but the gap is one `optional` harness that has never run, not two thirds of the system. **This changes the ordering, not the verdict**: it makes C3 (wire enforcement where supported) worth far more than it looked, since "where supported" is 2 of 3 rather than 1 of 3.
- A and B fail R8: both can AUTO-ALLOW, so a false negative permits something today's flow would have shown a human. C passes only if auto-allow is opt-in and off by default.
- A, B, C fail R5: no corpus exists. Only D produces one. **This is the finding that orders the work.**
- A and B fail R6: neither constrains the direction of error. C passes by construction — a judgement may only ever NARROW what is permitted, never widen it, so an injection can cause a park but never an allow.
- D fails R0/R1/R3/R7: it enforces nothing. That is the point, not a defect.

---

## Where this lands

D and C are not rivals — **D is C with enforcement switched off**, which is exactly the
sequencing R5 demands and the sequencing the last research pass learned the hard way.
Shape = **D then C**: build C1's policy module and both call sites, run them in observe-only
mode until the corpus says where the thresholds go, then promote.

## Open

| # | Question |
|---|----------|
| O1 | Which layer of the 7-layer `resolveAgentConfig` chain does a Jev-chosen model enter at? It must lose to a run override and to node tuning, but beat the graph default — otherwise a human's explicit choice is overridden by a guess (R7) |
| O2 | Does auto-allow ever get built, or is the ceiling "park less often, never allow more"? R8 is only satisfiable if the answer is the latter |
| O3 | What is the pre-flight's state, concretely, given 32k and jaggedness #5 (context rot)? The rendered prompt alone may already be too big |
| O4 | Can a `policy-judged` event be replayed? `engine/replay.ts` derives state from the log; a judgement that changed a permission mode must reconstruct, or a resumed run is governed differently from the original |


---

## Review corrections (2026-09-26)

An adversarial review of the companion decision doc found one load-bearing factual error and
two overstatements in this file. All three are fixed above and marked 🟡.

| # | Was | Is |
|---|-----|-----|
| 1 | "Codex and cursor cannot ask" (CUR3, A4) | **Codex can.** `engine/executors/codex.ts:104` `answerApproval`, :163 the call, :186 `approvalPolicy: "on-request"`, :7-9 the header saying so. Only cursor cannot. |
| 2 | Shape A is "claude only", A4 fatal | A covers claude + codex: both `core` harnesses, and 100% of the 384 rendered attempts on record. Cursor is `optional` and has never run. |
| 3 | "no record that the governing policy changed" (CUR7) | The harness change IS logged. The resolved per-attempt `permissionMode` is not. Narrower and more useful: it points at a two-field event change. |

One correction does NOT follow from this. `engine/executors/codex.ts:35` defaults the sandbox
to `danger-full-access`, but :186 sets `approvalPolicy: "on-request"` — codex is sandboxed
permissively **and asks anyway**. Listing it beside claude's forced `auto` as evidence of
ungoverned autonomy was misleading.
