/**
 * The launch form (screen 6), out of main.tsx (HOW-16 P1). It borrows two pieces rather than
 * copying them: `AddWorkspace` from Settings (a repo graph with no repo registered has to be
 * able to register one here) and `ConfigFields` from Graphs (run overrides and node tuning
 * are the same six fields, and two copies is how they drift).
 *
 * The run-overrides disclosure was a `.linkish` span with an onClick — no role, no tabIndex,
 * no key handler (P2.8). It is a `Button variant="link"` carrying `aria-expanded`.
 *
 * The run name (HOW-18) is an optional display label; the server validates it with the same
 * core/run-name.ts rule the CLI uses, and its refusal shows here like any launch error.
 *
 * HOW-66 (HOW-56 D-1B): "Draft a graph" is not a form of the graph's inputs. draft-graph is
 * picked like any graph, and the generic input loop becomes ONE intent box, an optional base
 * ("Let the agent choose", or any graph the builder can open — the drafter's catalog) and the
 * optional workspace. The body is core/draft-launch.ts draftLaunchRequest, the same builder a
 * redraft goes through, so what a draft run is told cannot depend on where it was started.
 *
 * HOW-71: the Graphs page's "Draft a graph" lands here as `?graph=draft-graph[&base=<name>]`.
 * A `?base=` that is not one of `bases` reads as "Let the agent choose" AND is never sent: a
 * native select shown an invalid value must not hide what gets POSTed.
 *
 * HOW-68 put the form on the shared frame as a 720px reading column:
 *
 *   A real label above every field, and what is still missing said IN WORDS beside the one
 *   primary action ("Still needed: goal, a repo workspace") — the button used to go grey with
 *   no reason given.
 *   The command this form will run, in mono, with a copy button: the same argv
 *   core/launch-args.ts builds for the server, so what is previewed is what is spawned, and a
 *   run can be taken to a terminal exactly as configured.
 *   Run overrides behind an "Advanced options" disclosure — six fields most runs never touch.
 *   ⌘↵ / Ctrl ↵ launches from anywhere on the form, text fields included. The launch bar is the
 *   frame's foot, so it is on screen at 1024×640 however long the graph's inputs are.
 */
import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Play } from "lucide-react";
import type { GraphCatalog, GraphInfo, Workspaces } from "@/lib/types";
import { getJSON } from "@/lib/net";
import { useShortcuts } from "@/lib/shortcuts";
import { DRAFT_GRAPH } from "../../../core/catalog";
import { draftLaunchRequest } from "../../../core/draft-launch";
import { launchArgs, type LaunchRequest } from "../../../core/launch-args";
import type { AgentConfigDto } from "../graph-dag";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { AddWorkspace } from "./settings";
import { ConfigFields } from "./graphs";
import { FieldError, Hint, Screen, Section } from "./frame";
import { LINK } from "./prompts";

/** one argv word, quoted for a POSIX shell only when it needs to be */
const shellWord = (w: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

/**
 * The command the form will run, as the operator would type it. Built from the SAME argv the
 * launch route spawns (core/launch-args.ts) minus the `--id` the server mints, so the preview
 * cannot drift from the launch. Pure, for the test.
 */
export function launchCommand(request: LaunchRequest): string {
  const args = launchArgs(request, "");
  const at = args.indexOf("--id");
  if (at !== -1) args.splice(at, 2);
  return ["bun", "cli/main.ts", ...args].map(shellWord).join(" ");
}

export function StartRun() {
  const [catalog, setCatalog] = useState<GraphInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspaces>({ repos: [], folders: [] });
  // HOW-65: a just-saved draft's receipt says "Run it" and lands here with the graph picked
  const [graph, setGraph] = useState<string>(() => new URLSearchParams(location.search).get("graph") ?? "");
  const [name, setName] = useState<string>("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [workspace, setWorkspace] = useState<string>("");
  // draft-graph only (D-1B): the request, and the graph to start from ("" = the agent chooses)
  const [intent, setIntent] = useState<string>("");
  const [base, setBase] = useState<string>(() => new URLSearchParams(location.search).get("base") ?? "");
  const [overrides, setOverrides] = useState<AgentConfigDto>({});
  const [showOverrides, setShowOverrides] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const loadWorkspaces = () => getJSON<Workspaces>("/api/workspaces").then(setWorkspaces).catch(() => {});
  useEffect(() => {
    // a graph another graph starts takes inputs only its parent can fill (implement-stacked's
    // `deps` names sibling runs), so it is not offered here — the Graphs page says who starts it
    getJSON<GraphCatalog>("/api/graphs").then((c) => setCatalog(c.graphs)).catch(() => {});
    loadWorkspaces();
  }, []);
  const graphs = catalog.filter((g) => !g.launched_by);
  // a base is anything the drafter's catalog offers: every graph the builder can open
  const bases = catalog.filter((g) => g.builder);
  const chosenBase = bases.some((g) => g.name === base) ? base : "";
  const selected = graphs.find((g) => g.name === graph);
  const drafting = graph === DRAFT_GRAPH;
  const options = selected?.kind === "repo" ? workspaces.repos : [...workspaces.repos, ...workspaces.folders];

  // what is still missing, in the form's own words — the reason the button is not ready
  const missing: string[] = !selected ? ["a graph"] : [
    ...(drafting ? (intent.trim() ? [] : ["what the graph should do"]) : selected.inputs.filter((k) => !(inputs[k] ?? "").trim())),
    ...(selected.kind === "repo" && !workspace ? ["a repo workspace"] : []),
  ];
  const request: LaunchRequest | null = !selected ? null : drafting
    ? draftLaunchRequest({ intent, base: chosenBase || undefined, workspace: workspace || undefined, name: name.trim() || undefined, overrides })
    : { graph, name: name.trim() || undefined, inputs, workspace: workspace || undefined, overrides };
  const command = request ? launchCommand(request) : "";

  const launch = async () => {
    if (busy || missing.length > 0 || !request) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!r.ok) throw new Error((await r.json() as any).error ?? "launch failed");
      const { id } = (await r.json()) as { id: string };
      toast(name.trim() ? `launched "${name.trim()}" as ${id}` : `launched ${graph} as ${id}`);
      location.assign(`/run/${id}`);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setError(why);
      toast(why, "error");
      setBusy(false);
    }
  };
  // not a single key, so it works from inside a field — which is where the operator's hands are
  useShortcuts([{ id: "launch.submit", scope: "New run", label: "Launch the run", keys: "mod+enter", palette: false, disabled: missing.length > 0 || busy, run: () => void launch() }]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <Screen
      name="new-run"
      title="New run"
      width="form"
      footer={
        <footer data-slot="launch-bar" className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-6 py-2">
          <Button disabled={busy ? false : missing.length > 0} loading={busy} onClick={launch}>
            {!busy && <Play />}{busy ? "Launching" : "Launch run"} <Kbd keys="mod+enter" decorative />
          </Button>
          {/* the reason the button is not ready, said in words and announced when it changes */}
          <p role="status" data-slot="launch-missing" className="m-0 min-w-0 flex-1 text-sm text-muted-foreground">
            {missing.length > 0 ? `Still needed: ${missing.join(", ")}.` : selected?.kind === "repo" ? "It will create a worktree and a branch in the workspace." : ""}
          </p>
        </footer>
      }
    >
      <Section title="What to run">
        <Label>
          Graph
          <Select value={graph} onChange={(e) => { setGraph(e.target.value); setInputs({}); }}>
            <option value="">Choose a graph…</option>
            {graphs.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
          </Select>
        </Label>
        {selected ? <Hint>{selected.description}</Hint> : <Hint>A graph is the shape of the work: its steps, and what each hands to the next. <a className={LINK} href="/graphs">See what each one does</a>.</Hint>}
        {selected && (
          <Label>
            Run name (optional)
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Shown in the runs list instead of the goal" />
          </Label>
        )}
      </Section>

      {selected && (
        <Section title={drafting ? "The graph to draft" : "Inputs"}>
          {drafting && (
            <>
              <Label>
                What should the graph do?
                <Textarea value={intent} onChange={(e) => setIntent(e.target.value)} rows={4} placeholder="like quick-task, but with a review step before it finishes" />
              </Label>
              <Label>
                Base (optional)
                <Select value={chosenBase} onChange={(e) => setBase(e.target.value)}>
                  <option value="">Let the agent choose</option>
                  {bases.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
                </Select>
              </Label>
            </>
          )}
          {!drafting && selected.inputs.length === 0 && <Hint>This graph takes no inputs.</Hint>}
          {!drafting && selected.inputs.map((k) => (
            <Label key={k}>
              {k}
              <Input value={inputs[k] ?? ""} onChange={(e) => setInputs({ ...inputs, [k]: e.target.value })} />
            </Label>
          ))}
          <Label>
            Workspace {selected.kind === "repo" ? "(repo required)" : drafting ? "(optional)" : ""}
            <Select value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
              <option value="">{selected.kind === "repo" ? (options.length ? "Choose a repo…" : "No repos registered") : "None (log only)"}</option>
              {options.map((w) => <option key={w.name} value={w.name}>{w.name} — {w.path}</option>)}
            </Select>
          </Label>
          {selected.kind === "repo" && options.length === 0 && (
            <AddWorkspace hint="This graph creates worktrees and pull requests, so it needs a registered git repository." onAdded={loadWorkspaces} />
          )}
        </Section>
      )}

      {selected && (
        <div className="flex flex-col gap-3">
          <Button variant="ghost" size="sm" className="-ml-2 self-start" aria-expanded={showOverrides} aria-controls="run-overrides" onClick={() => setShowOverrides(!showOverrides)}>
            {showOverrides ? <ChevronDown /> : <ChevronRight />}Advanced options
          </Button>
          {showOverrides && (
            <div id="run-overrides" className="flex flex-col gap-3">
              <Hint>Run overrides beat every step and graph setting, for this run only.</Hint>
              <ConfigFields value={overrides} onChange={setOverrides} />
            </div>
          )}
        </div>
      )}

      {selected && (
        <Section title="Command" description="What this form runs. Copy it to launch the same run from a terminal.">
          <div className="flex items-start gap-1 rounded-[var(--radius-sm)] border border-border bg-muted py-1.5 pl-3 pr-1.5">
            <code data-slot="launch-command" className="min-w-0 flex-1 whitespace-pre-wrap py-0.5 font-mono text-code leading-5 text-foreground [overflow-wrap:anywhere]">{command}</code>
            <Tooltip content={copied ? "Copied the command" : "Copy the command"} side="left" align="center">
              <Button variant="ghost" size="icon-sm" aria-label={copied ? "Copied the command" : "Copy the command"} onClick={() => { void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => setCopied(false)); }}>
                {copied ? <Check /> : <Copy />}
              </Button>
            </Tooltip>
          </div>
        </Section>
      )}

      {error && <FieldError pre>{error}</FieldError>}
    </Screen>
  );
}
