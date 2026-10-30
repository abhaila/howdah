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
 */
import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import type { GraphCatalog, GraphInfo, Workspaces } from "@/lib/types";
import { getJSON } from "@/lib/net";
import { DRAFT_GRAPH } from "../../../core/catalog";
import { draftLaunchRequest } from "../../../core/draft-launch";
import type { AgentConfigDto } from "../graph-dag";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { AddWorkspace } from "./settings";
import { ConfigFields } from "./graphs";

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

  const launch = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(drafting
          ? draftLaunchRequest({ intent, base: chosenBase || undefined, workspace: workspace || undefined, name: name.trim() || undefined, overrides })
          : { graph, name: name.trim() || undefined, inputs, workspace: workspace || undefined, overrides }),
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

  return (
    <div className="runs">
      <h1>Start a run</h1>
      <Card className="max-w-[640px]">
        <CardContent className="pt-5">
          <Label>
            Graph
            <Select value={graph} onChange={(e) => { setGraph(e.target.value); setInputs({}); }}>
              <option value="">choose…</option>
              {graphs.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
            </Select>
          </Label>
          {selected && <div className="field-hint">{selected.description}</div>}
          {selected && (
            <Label>
              Run name (optional)
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="shown in the runs list instead of the goal" />
            </Label>
          )}
          {selected && drafting && (
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
          {!drafting && selected?.inputs.map((k) => (
            <Label key={k}>
              {k}
              <Input value={inputs[k] ?? ""} onChange={(e) => setInputs({ ...inputs, [k]: e.target.value })} placeholder={k} />
            </Label>
          ))}
          {selected && (
            <Label>
              Workspace {selected.kind === "repo" ? "(repo required)" : drafting ? "(optional)" : ""}
              <Select value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
                <option value="">{selected.kind === "repo" ? (options.length ? "choose a repo…" : "no repos registered") : "none (log-only)"}</option>
                {options.map((w) => <option key={w.name} value={w.name}>{w.name} — {w.path}</option>)}
              </Select>
            </Label>
          )}
          {selected?.kind === "repo" && options.length === 0 && (
            <AddWorkspace hint="This graph creates worktrees and PRs, so it needs a registered git repo:" onAdded={loadWorkspaces} />
          )}
          {selected && (
            <div className="field-hint">
              <Button variant="link" size="inline" aria-expanded={showOverrides} onClick={() => setShowOverrides(!showOverrides)}>
                Run overrides {showOverrides ? "▾" : "▸"}
              </Button>{" "}
              — beat every node and graph setting for this run only
            </div>
          )}
          {selected && showOverrides && <ConfigFields value={overrides} onChange={setOverrides} />}
          {error && <div className="field-error">{error}</div>}
          <Button
            disabled={busy || !selected || (drafting ? !intent.trim() : selected.inputs.some((k) => !(inputs[k] ?? "").trim())) || (selected.kind === "repo" && !workspace)}
            onClick={launch}
          >
            <Play />{busy ? "Launching…" : "Launch run"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
