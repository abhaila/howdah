# Orbital — functional spec, observed 2026-09-12

From the running server (`http://127.0.0.1:56347`), the 0.2.5 bundle, and
docs.beta.runorbital.dev. Screenshots in `screens/`, graph exports in `graphs/`.

## Graph model

One DOT file per workflow in `.orbital/`. Node type is the DOT **shape**.

| Shape | Type | Key attributes |
|---|---|---|
| `box` (default) | Agent | `prompt` \| `prompt_file`, `outputs="name:type"` (`choice\|text\|json\|work`) |
| `parallelogram` | Command | `bash -c`, 10min default, emits a final JSON line matching declared `facts` |
| `folder` | Worktree | `action="create"\|"remove"` |
| `component` / `tripleoctagon` | Fan-out / join | `max_parallel` default 4; join may synthesize with a prompt |
| `insulator` | Wait | duration, e.g. `15m` |
| `Msquare` | Terminal | `outcome="success\|failed\|aborted"` |

All nodes: `shape`, `label`, `class`, `max_visits`. **Unknown attributes are errors.**
Graph attrs: `version`, `description`, `entry`, `inputs="work,notes?"` (`?` = optional).

## Routing

Edges carry `condition` + `weight`; highest weight wins, unconditional edge is fallback.

```dot
"implementation.local_review" -> "implementation.plan_review" [ condition = "review_verdict == 'reject'", weight = "2" ]
"delivery.probe_pr" -> complete_ticket [ condition = "pr.state == 'MERGED'", weight = "6" ]
```

Conditions read validated agent outputs or machine facts from command nodes.

## Context

One store per run. Sources: declared inputs, agent outputs, command facts, stage outcomes.
Templating: `{{ inputs.goal }}` (original) vs `{{ context.work }}` (current) vs
`{{ context.<node>.<output> }}`. An internal namespace exists:
`{{ context.internal.visits.<node> }}`. Agents contribute only declared keys; undeclared
rejected. The validator statically checks a value is produced on **every** path reaching a
node that reads it.

## Engine

Harness per node: claude / codex / opencode, via official SDKs. Resolution order is browser
run choice → graph profile → node setting. `settingSources` defaults to
`["user","project","local"]`, so Claude Code skills load (`Skill ×4` observed in a live run).
State in `~/.orbital/run-history.db`. Resume continues; Retry starts a new visit. Steering
messages injected whole into the next turn. Failure edges recover; no failure edge means the
step waits for an operator.

## HTTP API (all under `/api`)

`projects`, `projects/:id/folders` · `graphs?project=<id>`, `graphs/:name`, `/clone`, `/doc`,
`/draft`, `/drafts`, `/drafts/:id`, `/export` (returns DOT), `/import`, `/layout`, `/validate`
· `runs`, `runs/:id`, `/events` (SSE), `/logs`, `/logs/stream`, `/controls`, `/commands`,
`/graph`, `/history`, `/metadata`, `/pull-requests`, `/restart`, `/source`, `/start`, `/title`,
`/export` · `worktrees`, `settings`, `mcp`, `host/folders`, `health`

## UI

Sidebar: Runs, Attention, Graphs, Projects, Settings (keyboard R/A/G/P/S).
Run detail tabs: Overview, Steps, Events, Graph, Tokens, Logs.
Step detail sub-tabs: Thread, Context, Debug. Thread has a type filter, search, an event
ribbon, and a "Message the agent" box at the bottom.

Overview is strong: Steps / Turns / Tool calls / Tokens / Cost / Duration, a "Where it stands"
line naming the current node and visit (`delivery.wait@25`), an identity block
(work item, graph, harness, repo, branch, worktree, run id) and a pull-requests section.

---

# Findings that matter for our design

## 1. Everything needed for prompt improvement is already captured, and not surfaced

The event stream for one run held **12,114 events**, including 19 `PromptRendered` events:

```json
{"_tag":"PromptRendered","node":"implementation.plan","prompt":"<the full 1950-char rendered prompt>"}
```

The Debug tab lists the event name and shows no payload. So the rendered prompt, the agent
output, the failures, the operator interventions and the routing decisions all exist as data
and none of it is reachable in the UI. **Capture is solved. Surfacing and the improvement loop
are not.**

## 2. The Context tab answers the wrong question

It shows what a step **wrote** to context. `delivery.address_reviews` declares no outputs, so
it renders "This step wrote nothing to the context." — permanently, by design. The useful
question is what the step **read** and what the prompt rendered to. Nothing answers it.

## 3. Improving one prompt costs a full graph fork

`implement-ticket-areeb` differs from stock `implement-ticket` by exactly one node's prompt
(`delivery.publish`: an added Why/What/Notes PR structure, plus an appended
`{{ context.internal.visits.delivery.publish }}`). That is a 20KB copy that will silently
drift from upstream, with no record of why the change was made or whether it helped.

## 4. "Needs you" is known to the system and invisible to the human

Observed: `delivery.address_reviews` sat in **Needs you for 4h 10m**. The cause is legible in
the thread:

```
AGENT     Feedback addressed and committed locally; nothing pushed.
FAILURE   TurnError: Error: Claude Code process exited with code 1
NOTICE    gave its run slot back
OPERATOR  Continue
NOTICE    no turn was running; queued for the next prompt
NOTICE    retrying delivery.address_reviews
```

The harness crashed, the run yielded its slot, the operator's "Continue" arrived when no turn
was running. Orbital knew its state the whole time. Nothing pushed it to the human.

## 5. TurnDelta is one row per streaming chunk

Nine consecutive `TurnDelta` rows, each with a timestamp and no content. That is the "noisy,
cuts text across many lines" complaint: streaming deltas are rendered as discrete log rows
rather than coalesced into the message they compose.

## 6. Model and cost are not recorded per turn

Turn panel shows `Model —`, `Effort —`, `Provider —`, `Session ThrowawaySession`. Overview
shows `Cost —` against 177.1k tokens. Nothing to warn on, nothing to attribute spend to,
and no basis for "you are out of tokens, switch model".
