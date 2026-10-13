/**
 * The one `cli/main.ts run` argv builder (HOW-18, moved here by HOW-23).
 *
 * Two callers start runs and neither of them owns an engine loop: the viewer's launch route
 * (`POST /api/runs`) and the `runs:launch` built-in, which fans a `plan-feature` decomposition
 * out into one run per approved slice (implement-ticket, or implement-stacked for a slice with
 * dependencies — HOW-57). They were one route and one
 * executor away from each other's flags — so a `--harness` the operator chose would have
 * reached the viewer's runs and silently not the fan-out's.
 *
 * Pure, so what either caller forwards can be tested without spawning a CLI, and node-free
 * like core/run-name.ts (the browser bundle may reach it through the launch form).
 *
 * `name` must already be normalized (core/run-name.ts) — this builds argv, it does not judge.
 */
export interface LaunchRequest {
  graph: string;
  inputs?: Record<string, string>;
  /** a registered workspace; `dir` is the unregistered escape hatch and forces a PLAIN run */
  workspace?: string;
  dir?: string;
  /** HOW-18: display label only */
  name?: string;
  /** HOW-23: the run that launched this one — lineage only */
  parent?: string;
  overrides?: { model?: string; effort?: string; permissionMode?: string; harness?: string; maxTurns?: number; skills?: string[] };
}

export function launchArgs(body: LaunchRequest, runId: string): string[] {
  const args = ["run", body.graph, "--id", runId];
  for (const [k, v] of Object.entries(body.inputs ?? {})) args.push("-i", `${k}=${v}`);
  if (body.workspace) args.push("--workspace", body.workspace);
  if (body.dir) args.push("--dir", body.dir);
  if (body.name) args.push("--name", body.name);
  if (body.parent) args.push("--parent", body.parent);
  const o = body.overrides ?? {};
  if (o.model) args.push("--model", o.model);
  if (o.effort) args.push("--effort", o.effort);
  if (o.permissionMode) args.push("--permission-mode", o.permissionMode);
  if (o.harness) args.push("--harness", o.harness);
  if (o.maxTurns) args.push("--max-turns", String(o.maxTurns));
  if (o.skills?.length) args.push("--skills", o.skills.join(","));
  return args;
}
