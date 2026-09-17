# Howdah

Howdah is a local workflow runner for agentic engineering graphs. It creates a durable run log, gives each run a workspace, drives Claude Code or Codex through graph nodes, and exposes a web UI for watching, pausing, resuming, jumping, and replying when a run needs help.

The current development workflow runs Howdah directly from this repository with Bun.

## Requirements

- Bun
- Git
- `gh` authenticated with GitHub, for PR publication and PR probes
- Claude Code CLI and/or Codex CLI, depending on which harness your graph uses

Check your machine with:

```sh
bun cli/main.ts doctor
```

## First setup

Install dependencies:

```sh
bun install
```

Create the local Howdah home:

```sh
bun cli/main.ts setup
```

By default Howdah stores local state in `~/.howdah`. You can keep a separate development home by setting `HOWDAH_HOME` on every command:

```sh
export HOWDAH_HOME=~/.howdah-demo
bun cli/main.ts setup
```

Use the same `HOWDAH_HOME` for the CLI, supervisor, and web server. If a command says `unknown run`, it usually means that process is pointed at a different home.

## Persistence model

Howdah is intentionally local-first. A home directory contains the durable state:

```text
~/.howdah/
  config.json
  heartbeat.json
  attention/
  repos/
    <workspace>/
      worktrees/
        <run-id>/
  runs/
    <run-id>/
      run.jsonl
      runner.pid
      control.json
```

The important file is `runs/<run-id>/run.jsonl`. It is the append-only event log for the run and is what the UI, resume flow, timeline, thread, and logs views read.

## Register workspaces

Register a local repository:

```sh
bun cli/main.ts workspace add sequence-web /path/to/sequence-web
```

Register or clone from GitHub:

```sh
bun cli/main.ts workspace add-github owner/repo
```

List configured workspaces:

```sh
bun cli/main.ts workspace list
```

## Run the supervisor

The supervisor keeps `heartbeat.json` fresh and resumes unfinished runs when their runner process has died. Leave it running in one terminal:

```sh
bun cli/main.ts up
```

For a one-shot check:

```sh
bun cli/main.ts up --once
```

Parked runs that still need a reply and paused runs are not auto-resumed.

## Run the web UI

Start the UI:

```sh
bun run web
```

Then open:

```text
http://localhost:4711
```

Use another port when needed:

```sh
HOWDAH_PORT=4712 bun run web
```

The run page shows the active run, graph, thread, logs, persistence paths, and controls for pause, resume, abort, jump, reply, and opening the run folder.

## Start a run

List available graphs:

```sh
bun cli/main.ts graphs
```

Start a run against a registered workspace:

```sh
bun cli/main.ts run implement-ticket \
  --workspace sequence-web \
  -i goal="Implement the ticket requirements" \
  -i work="Describe the ticket, branch, issue, or desired change"
```

Useful run-level overrides:

```sh
bun cli/main.ts run implement-ticket \
  --workspace sequence-web \
  --id implement-ticket-example \
  --harness codex \
  --model gpt-5.6-sol \
  --effort medium \
  --permission-mode full-access \
  -i goal="..." \
  -i work="..."
```

If you later install or wrap the CLI as `howdah`, the same commands work without the `bun cli/main.ts` prefix.

## Control a run

Pause:

```sh
bun cli/main.ts pause <run-id>
```

Resume:

```sh
bun cli/main.ts resume <run-id>
```

Reply to a parked run:

```sh
bun cli/main.ts reply <run-id> "Continue; no extra input from me."
```

Jump to a node after pausing:

```sh
bun cli/main.ts jump <run-id> delivery.fix_ci "Focus on the failing required checks."
```

Abort:

```sh
bun cli/main.ts abort <run-id>
```

Show known runs:

```sh
bun cli/main.ts runs
```

## Create a graph

Scaffold a new graph:

```sh
bun cli/main.ts new-graph my-graph --kind custom
```

Other kinds:

```sh
bun cli/main.ts new-graph docs-pass --kind doc
bun cli/main.ts new-graph research-pass --kind research
bun cli/main.ts new-graph code-pass --kind code
```

The scaffolder creates the graph, creates prompt files, updates the graph catalog, regenerates prompt ids, and validates the result.

## Development checks

Run tests:

```sh
bun test
```

Run type and prompt checks:

```sh
bun run check
```

## Troubleshooting

`unknown run`: make sure the CLI command, supervisor, and web server are using the same `HOWDAH_HOME`. The run page shows its home and run folder in the right rail.

Run is stuck with no movement: check whether the run is parked, paused, or has no live runner. The UI persistence panel shows `runner alive`; the event log is at `runs/<run-id>/run.jsonl`.

PR probe does not see checks: verify `gh auth status` and confirm the PR was published. Probe nodes rely on GitHub state, including required checks.

Port is already in use: set `HOWDAH_PORT`, for example `HOWDAH_PORT=4712 bun run web`.

Claude or Codex limits are reached: use run-level harness/model overrides, or configure graph/node defaults so fallback nodes use the matching harness model family.
