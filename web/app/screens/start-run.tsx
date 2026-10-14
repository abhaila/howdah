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
 */
import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import type { GraphCatalog, GraphInfo, Workspaces } from "@/lib/types";
import { getJSON } from "@/lib/net";
import type { AgentConfigDto } from "../graph-dag";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { AddWorkspace } from "./settings";
import { ConfigFields } from "./graphs";
import { DepsPicker } from "./deps-picker";
import { DEPS_KEY } from "../../../core/stack";

export function StartRun() {
  const [graphs, setGraphs] = useState<GraphInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspaces>({ repos: [], folders: [] });
  const [graph, setGraph] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [workspace, setWorkspace] = useState<string>("");
  const [overrides, setOverrides] = useState<AgentConfigDto>({});
  const [showOverrides, setShowOverrides] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const loadWorkspaces = () => getJSON<Workspaces>("/api/workspaces").then(setWorkspaces).catch(() => {});
  useEffect(() => {
    getJSON<GraphCatalog>("/api/graphs").then((c) => setGraphs(c.graphs)).catch(() => {});
    loadWorkspaces();
  }, []);
  const selected = graphs.find((g) => g.name === graph);
  const options = selected?.kind === "repo" ? workspaces.repos : [...workspaces.repos, ...workspaces.folders];

  const launch = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ graph, name: name.trim() || undefined, inputs, workspace: workspace || undefined, overrides }),
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
          {selected?.inputs.map((k) =>
            // HOW-57: a stacked run's `deps` is picked from existing runs, never typed as JSON
            k === DEPS_KEY ? (
              <div key={k} className="deps-field">
                <span className="deps-title">Waits for</span>
                <DepsPicker key={graph} onChange={(v) => setInputs((prev) => ({ ...prev, [k]: v }))} />
              </div>
            ) : (
              <Label key={k}>
                {k}
                <Input value={inputs[k] ?? ""} onChange={(e) => setInputs({ ...inputs, [k]: e.target.value })} placeholder={k} />
              </Label>
            ))}
          {selected && (
            <Label>
              Workspace {selected.kind === "repo" ? "(repo required)" : ""}
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
            disabled={busy || !selected || selected.inputs.some((k) => !(inputs[k] ?? "").trim()) || (selected.kind === "repo" && !workspace)}
            onClick={launch}
          >
            <Play />{busy ? "Launching…" : "Launch run"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
