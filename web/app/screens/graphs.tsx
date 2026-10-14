/**
 * The Graphs screen (T20 + D9): the catalog, the per-node tuning editor, and the source
 * editor for a local graph. Out of main.tsx (HOW-16 P1).
 *
 * Three HOW-16 fixes: the agent-node table repeated `border-b border-border py-2 pr-3` on
 * every one of its eighteen cells and is a `Table` now (P1.4); its rows and the graph list's
 * rows were `<div onClick>`s with no role, tabIndex or key handler and are `Row`s (P2.8);
 * and saving tuning reports through a toast rather than by relabelling the Save button for
 * 1.5s, which nothing but a sighted operator watching that button could perceive.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranch, FolderGit2, SlidersHorizontal, Pencil, Plus, RotateCcw as ResetIcon } from "lucide-react";
import type { GraphCatalog } from "@/lib/types";
import { navigate } from "@/lib/nav";
import { useTypedText } from "@/lib/hooks";
import { getJSON } from "@/lib/net";
import { GraphDag, useGraphShape, type GraphShapeDto, type AgentConfigDto } from "../graph-dag";
import { modelFitsHarness } from "../../../core/graph";
import { defaultHarness, effortFor, harnessNames, harnessSpec, isHarness } from "../../../core/harnesses";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Row } from "@/components/ui/row";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingBlock } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";

/**
 * HOW-17: the offered harnesses come from the harness table, not a literal here — adding a
 * fourth must never mean remembering to edit a UI list. `internal` harnesses (opencode runs
 * through claude's executor and binary) are not choices, so they are not offered.
 * The leading "" is the inherit option.
 */
const HARNESSES = ["", ...harnessNames().filter((h) => harnessSpec(h).status !== "internal")];
const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];
const PERMISSION_MODES = ["", "auto"];
const MODEL_SUGGESTIONS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-5", "gpt-5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const BULK_PRESETS: Array<{ id: string; label: string; target: string; cfg: AgentConfigDto }> = [
  { id: "codex-planning", label: "Planning: GPT-5", target: "role:planning", cfg: { harness: "codex", model: "gpt-5", effort: "high" } },
  { id: "claude-planning", label: "Planning: Opus 5", target: "role:planning", cfg: { harness: "claude", model: "claude-opus-5", effort: "high", permissionMode: "auto" } },
  { id: "delivery-cheap", label: "Delivery: cheap Codex", target: "class:delivery", cfg: { harness: "codex", model: "gpt-5.6-luna", effort: "low" } },
  { id: "delivery-balanced", label: "Delivery: balanced Codex", target: "class:delivery", cfg: { harness: "codex", model: "gpt-5.6-terra", effort: "medium" } },
];

export type GraphTuningDto = { defaults?: AgentConfigDto; nodes?: Record<string, AgentConfigDto> };

function cleanConfig(c: AgentConfigDto | undefined): AgentConfigDto | undefined {
  if (!c) return undefined;
  const out: AgentConfigDto = {};
  for (const [key, raw] of Object.entries(c) as [keyof AgentConfigDto, unknown][]) {
    if (raw === undefined || raw === null || raw === "") continue;
    if (Array.isArray(raw) && raw.length === 0) continue;
    (out as any)[key] = raw;
  }
  return Object.keys(out).length ? out : undefined;
}

function mergeConfig(a: AgentConfigDto | undefined, b: AgentConfigDto): AgentConfigDto {
  return cleanConfig({ ...(a ?? {}), ...cleanConfig(b) }) ?? {};
}

/**
 * The tuner's live preview of the engine's resolution. It stays a separate function from
 * core/graph.ts resolveAgentConfigLayers because it works on the UI's loose DTO (every field
 * a string) rather than the typed AgentConfig — but the RULES it applies are the shared
 * ones: modelFitsHarness and the harness table's own permission mode, imported, never
 * re-declared. (HOW-17: this file used to carry a verbatim copy of core's regex pair, which
 * would have needed cursor's family added a second time — and would have gone on answering
 * the old way if anyone forgot.)
 */
export function resolvePreview(layers: Array<AgentConfigDto | undefined>, configuredDefault?: string): AgentConfigDto {
  const pick = (k: keyof AgentConfigDto) => {
    for (const layer of layers) {
      const value = layer?.[k];
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const harness = String(pick("harness") ?? defaultHarness(configuredDefault));
  // a harness the table does not know can only come from a hand-edited tuning.json: preview
  // it as-is rather than filtering its model away on a rule we have no basis for
  const spec = isHarness(harness) ? harnessSpec(harness) : undefined;
  let model: string | undefined;
  for (const layer of layers) {
    if (layer?.model && (!spec || modelFitsHarness(spec.name, layer.model))) {
      model = layer.model;
      break;
    }
  }
  // HOW-33: the same verdict the engine reaches — an effort this harness cannot take is shown
  // as inert, not displayed as if a run would use it
  const effort = spec ? effortFor(spec.name, pick("effort") as string | undefined) : { effort: pick("effort") as string | undefined };
  return {
    harness,
    model,
    effort: effort.effort,
    ...("inert" in effort && effort.inert !== undefined ? { effortInert: effort.inert } : {}),
    permissionMode: spec?.forcedPermissionMode ?? (pick("permissionMode") as string | undefined),
    maxTurns: pick("maxTurns") as number | undefined,
    skills: pick("skills") as string[] | undefined,
    tools: pick("tools") as AgentConfigDto["tools"],
    diagnostics: pick("diagnostics") as boolean | undefined,
  };
}

export function previewShape(shape: GraphShapeDto, tuning: GraphTuningDto): GraphShapeDto {
  const tsDefaults = shape.defaults ?? {};
  return {
    ...shape,
    tuning,
    nodes: shape.nodes.map((n) => {
      if (n.kind !== "agent") return n;
      const nodeTuning = tuning.nodes?.[n.id];
      const effective = resolvePreview([nodeTuning, n.baseline, tuning.defaults, tsDefaults], shape.default_harness);
      return { ...n, node_tuning: nodeTuning, effective, harness: effective.harness, model: effective.model, effort: effective.effort };
    }),
  };
}

/** the tools setting from two lists — absent when both are empty, so "inherit" stays inherit */
function toolsOf(allow: string[] | undefined, deny: string[] | undefined): AgentConfigDto["tools"] {
  if (!allow?.length && !deny?.length) return undefined;
  return { ...(allow?.length ? { allow } : {}), ...(deny?.length ? { deny } : {}) };
}

const parseList = (typed: string) => typed.split(",").map((x) => x.trim()).filter(Boolean);

/**
 * A comma-separated list box that keeps what was TYPED while it still means the stored list —
 * so a trailing comma, or the space before the next name, survives the keystroke (the
 * useTypedText rule; a box fed straight back from `string[]` ate both).
 */
function ListInput({ value, placeholder, onChange }: { value: string[] | undefined; placeholder: string; onChange: (v: string[] | undefined) => void }) {
  const stored = (value ?? []).join(", ");
  const [shown, setShown] = useTypedText(stored, (typed) => parseList(typed).join(", "));
  return (
    <Input value={shown} placeholder={placeholder} onChange={(e) => {
      setShown(e.target.value);
      const list = parseList(e.target.value);
      onChange(list.length ? list : undefined);
    }} />
  );
}

export function ConfigFields(
  { value, baseline, onChange, inheritedHarness }:
  { value: AgentConfigDto; baseline?: AgentConfigDto; onChange: (v: AgentConfigDto) => void; inheritedHarness?: string },
) {
  const ph = (k: keyof AgentConfigDto, fallback: string) => {
    const b = baseline?.[k];
    return b !== undefined && b !== null && String(b) !== "" ? `inherits: ${Array.isArray(b) ? b.join(", ") : b}` : fallback;
  };
  return (
    <>
      <Label>
        Harness
        <Select value={value.harness ?? ""} onChange={(e) => onChange({ ...value, harness: (e.target.value || undefined) as any })}>
          {/* HOW-17: what "inherit" resolves to is the operator's configured default, not a hard-coded claude */}
          {HARNESSES.map((x) => <option key={x} value={x}>{x || ph("harness", `inherit (${inheritedHarness ?? defaultHarness()})`)}</option>)}
        </Select>
      </Label>
      <Label>
        Model
        <Input list="model-suggestions" value={value.model ?? ""} placeholder={ph("model", "harness default")} onChange={(e) => onChange({ ...value, model: e.target.value || undefined })} />
        <datalist id="model-suggestions">{MODEL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}</datalist>
      </Label>
      <Label>
        Effort
        <Select value={value.effort ?? ""} onChange={(e) => onChange({ ...value, effort: (e.target.value || undefined) as any })}>
          {EFFORTS.map((x) => <option key={x} value={x}>{x || ph("effort", "inherit")}</option>)}
        </Select>
      </Label>
      <Label>
        Permission mode
        <Select value={value.permissionMode ?? ""} onChange={(e) => onChange({ ...value, permissionMode: (e.target.value || undefined) as any })}>
          {PERMISSION_MODES.map((x) => <option key={x} value={x}>{x || ph("permissionMode", "inherit")}</option>)}
        </Select>
      </Label>
      <Label>
        Max turns
        <Input type="number" min="1" value={value.maxTurns ?? ""} placeholder={ph("maxTurns", "unlimited")} onChange={(e) => onChange({ ...value, maxTurns: e.target.value ? Number(e.target.value) : undefined })} />
      </Label>
      <Label>
        Skills (comma-separated)
        <ListInput value={value.skills} placeholder={ph("skills", "none")} onChange={(skills) => onChange({ ...value, skills })} />
      </Label>
      {/* HOW-41: the node's action space — a harness that cannot restrict tools refuses the node */}
      <Label>
        Tools allowed without asking (comma-separated)
        <ListInput value={value.tools?.allow} placeholder={baseline?.tools?.allow?.length ? `inherits: ${baseline.tools.allow.join(", ")}` : "harness default"} onChange={(allow) => onChange({ ...value, tools: toolsOf(allow, value.tools?.deny) })} />
      </Label>
      <Label>
        Tools denied (comma-separated, e.g. WebFetch, Bash(git push *))
        <ListInput value={value.tools?.deny} placeholder={baseline?.tools?.deny?.length ? `inherits: ${baseline.tools.deny.join(", ")}` : "none"} onChange={(deny) => onChange({ ...value, tools: toolsOf(value.tools?.allow, deny) })} />
      </Label>
      {/* HOW-39: opt-in; unticked means inherit, so a graph default still applies */}
      <Checkbox
        label={`Post-edit diagnostics (claude; runs the workspace's diagnostics command after every edit)${baseline?.diagnostics ? " — inherits: on" : ""}`}
        checked={value.diagnostics === true}
        onChange={(e) => onChange({ ...value, diagnostics: e.target.checked ? true : undefined })}
      />
    </>
  );
}

export function GraphTuner({ shape, onSaved }: { shape: GraphShapeDto; onSaved: () => void }) {
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [tuning, setTuning] = useState<GraphTuningDto>(shape.tuning ?? {});
  const [bulkTarget, setBulkTarget] = useState("class:delivery");
  const [bulkConfig, setBulkConfig] = useState<AgentConfigDto>({ harness: "codex", model: "gpt-5.6-luna", effort: "low" });
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const { toast } = useToast();
  useEffect(() => { setTuning(shape.tuning ?? {}); setDirty(false); setSelectedNode(null); }, [shape.name]);

  const preview = useMemo(() => previewShape(shape, tuning), [shape, tuning]);
  const agentNodes = preview.nodes.filter((n) => n.kind === "agent");
  const classes = Array.from(new Set(agentNodes.map((n) => n.class).filter(Boolean) as string[])).sort();
  const node = preview.nodes.find((n) => n.id === selectedNode);
  const idsForTarget = (target: string) => agentNodes
    .filter((n) =>
      target === "all" ||
      target === `class:${n.class ?? ""}` ||
      (target === "role:planning" && /\bplan|planning/i.test(n.id)),
    )
    .map((n) => n.id);
  const selectedIds = idsForTarget(bulkTarget);
  const setNodeCfg = (id: string, v: AgentConfigDto) => {
    const cleaned = cleanConfig(v);
    const nodes = { ...(tuning.nodes ?? {}) };
    if (cleaned) nodes[id] = cleaned;
    else delete nodes[id];
    setTuning({ ...tuning, nodes });
    setDirty(true);
  };
  const clearNodeCfg = (id: string) => {
    const nodes = { ...(tuning.nodes ?? {}) };
    delete nodes[id];
    setTuning({ ...tuning, nodes });
    setDirty(true);
  };
  const applyBulk = (cfg = bulkConfig, target = bulkTarget) => {
    const nodes = { ...(tuning.nodes ?? {}) };
    for (const id of idsForTarget(target)) nodes[id] = mergeConfig(nodes[id], cfg);
    setTuning({ ...tuning, nodes });
    setDirty(true);
  };
  const clearBulk = (target = bulkTarget) => {
    const nodes = { ...(tuning.nodes ?? {}) };
    for (const id of idsForTarget(target)) delete nodes[id];
    setTuning({ ...tuning, nodes });
    setDirty(true);
  };
  const save = async () => {
    setState("saving");
    try {
      const r = await fetch(`/api/graphs/${shape.name}/tuning`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(tuning) });
      if (!r.ok) throw new Error(((await r.json()) as any).error);
      setState("saved");
      setDirty(false);
      toast(`${shape.name} tuning saved — it applies to new runs`);
      onSaved();
      setTimeout(() => setState("idle"), 1500);
    } catch (e) {
      setState("failed");
      toast(e instanceof Error ? e.message : "could not save the tuning", "error");
    }
  };

  return (
    <div className="tuner">
      <GraphDag key={`${shape.name}:${JSON.stringify(tuning)}`} shape={preview} onSelect={setSelectedNode} selected={selectedNode ?? undefined} />
      <div className="tuner-panels">
        <Card>
          <CardHeader>
            <CardTitle>Graph defaults</CardTitle>
            <CardDescription>Applies to every agent node unless the node sets its own. Cleared fields fall back to the graph file.</CardDescription>
          </CardHeader>
          <CardContent>
            <ConfigFields value={tuning.defaults ?? {}} baseline={shape.defaults} inheritedHarness={shape.default_harness} onChange={(v) => { setTuning({ ...tuning, defaults: v }); setDirty(true); }} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Bulk update</CardTitle>
            <CardDescription>Apply a model level to a whole graph slice. Node overrides are saved to tuning.json.</CardDescription>
          </CardHeader>
          <CardContent>
            <Label>
              Target
              <Select value={bulkTarget} onChange={(e) => setBulkTarget(e.target.value)}>
                <option value="all">all agent nodes</option>
                <option value="role:planning">planning nodes</option>
                {classes.map((c) => <option key={c} value={`class:${c}`}>{c} class</option>)}
              </Select>
            </Label>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Label>
                Harness
                <Select value={bulkConfig.harness ?? ""} onChange={(e) => setBulkConfig({ ...bulkConfig, harness: e.target.value || undefined })}>
                  {HARNESSES.map((x) => <option key={x} value={x}>{x || "keep current"}</option>)}
                </Select>
              </Label>
              <Label>
                Model
                <Input list="model-suggestions" value={bulkConfig.model ?? ""} placeholder="keep current" onChange={(e) => setBulkConfig({ ...bulkConfig, model: e.target.value || undefined })} />
              </Label>
              <Label>
                Effort
                <Select value={bulkConfig.effort ?? ""} onChange={(e) => setBulkConfig({ ...bulkConfig, effort: e.target.value || undefined })}>
                  {EFFORTS.map((x) => <option key={x} value={x}>{x || "keep current"}</option>)}
                </Select>
              </Label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => applyBulk()}><SlidersHorizontal />Apply to {selectedIds.length}</Button>
              {BULK_PRESETS.map((p) => (
                <Button key={p.id} variant="outline" size="sm" onClick={() => { setBulkTarget(p.target); setBulkConfig(p.cfg); applyBulk(p.cfg, p.target); }}>{p.label}</Button>
              ))}
              <Button variant="ghost" size="sm" onClick={() => clearBulk()}><ResetIcon />Clear target overrides</Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          {node?.kind === "agent" ? (
            <>
              <CardHeader>
                <CardTitle className="font-mono">{node.id}</CardTitle>
                <CardDescription>prompt: {node.prompt} · effective now: {node.effective?.harness}{node.effective?.model ? ` · ${node.effective.model}` : ""}{node.effective?.effort ? ` · ${node.effective.effort}` : ""}{node.effective?.effortInert ? ` · ${node.effective.effortInert}` : ""}{node.effective?.permissionMode ? ` · ${node.effective.permissionMode}` : ""}</CardDescription>
              </CardHeader>
              <CardContent>
                <ConfigFields value={tuning.nodes?.[node.id] ?? {}} baseline={node.baseline} inheritedHarness={shape.default_harness} onChange={(v) => setNodeCfg(node.id, v)} />
                <Button variant="ghost" size="sm" className="self-start" onClick={() => clearNodeCfg(node.id)}><ResetIcon />Clear node override</Button>
              </CardContent>
            </>
          ) : (
            <CardContent className="pt-5"><div className="field-hint">Click an agent node (◆) in the graph to tune it.</div></CardContent>
          )}
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Agent nodes</CardTitle>
          <CardDescription>Scan the effective routing model and jump straight to a node override.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Node</TableHead>
                <TableHead>Class</TableHead>
                <TableHead>Harness</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Effort</TableHead>
                <TableHead>Override</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agentNodes.map((n) => (
                <TableRow key={n.id} className={selectedNode === n.id ? "bg-muted" : ""}>
                  {/* the whole row selects a node, but a table cell cannot BE a button and stay
                      a table — so the node name is the control and the row follows it */}
                  <TableCell className="font-mono">
                    <Button variant="link" size="inline" aria-pressed={selectedNode === n.id} onClick={() => setSelectedNode(n.id)}>{n.id}</Button>
                  </TableCell>
                  <TableCell>{n.class ?? "—"}</TableCell>
                  <TableCell className="font-mono">{n.effective?.harness ?? "claude"}</TableCell>
                  <TableCell className="font-mono">{n.effective?.model ?? "default"}</TableCell>
                  <TableCell className="font-mono">{n.effective?.effortInert ? `inert (${n.effective.effortInert})` : n.effective?.effort ?? "—"}</TableCell>
                  <TableCell>{n.node_tuning ? <Badge variant="attention">node</Badge> : <Badge variant="outline">inherit</Badge>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <div className="tuner-save">
        <Button onClick={save} disabled={!dirty || state === "saving"}>
          {state === "saving" ? "Saving…" : state === "saved" ? "Saved — applies to new runs" : state === "failed" ? "Failed — retry" : "Save tuning"}
        </Button>
        {dirty && <span className="field-hint">unsaved changes</span>}
      </div>
    </div>
  );
}

/**
 * Editing a local graph as what it is: TypeScript (D2). Save runs the same gate the launcher
 * trusts — import, `validate()`, and every agent node's prompt file must exist — and restores
 * the previous bytes when it fails, so what is on disk is always runnable.
 *
 * Typecheck is separate and explicit because it costs seconds, not milliseconds (D8). The
 * badge never claims more than was actually checked: passing Save is not passing tsc.
 */
export function GraphSource({ name, onSaved }: { name: string; onSaved: () => void }) {
  const [source, setSource] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "checking">("idle");
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ ok: boolean; diagnostics: string[]; unavailable?: string } | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    setSource(null); setDirty(false); setError(null); setChecked(null); setState("idle");
    getJSON<{ source: string | null }>(`/api/graphs/${name}/source`)
      .then((d) => setSource(d.source ?? ""))
      .catch(() => setSource(null));
  }, [name]);

  const save = async () => {
    setState("saving"); setError(null); setChecked(null);
    try {
      const r = await fetch(`/api/graphs/${name}/source`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) { setError(body.error ?? "save refused"); setState("idle"); toast(body.error ?? "save refused", "error"); return; }
      setDirty(false); setState("saved");
      toast(`${name}.ts saved and validated`);
      onSaved();
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setError(why);
      setState("idle");
      toast(why, "error");
    }
  };

  const typecheck = async () => {
    setState("checking"); setChecked(null);
    try {
      const r = await fetch(`/api/graphs/${name}/typecheck`, { method: "POST" });
      setChecked((await r.json()) as { ok: boolean; diagnostics: string[]; unavailable?: string });
    } catch (e) {
      setChecked({ ok: false, diagnostics: [e instanceof Error ? e.message : String(e)] });
    } finally {
      setState("idle");
    }
  };

  if (source === null) return <LoadingBlock label={`Reading ${name}.ts`} rows={6} />;

  return (
    <div className="graph-source">
      <Textarea
        className="graph-source-editor"
        aria-label={`${name}.ts source`}
        spellCheck={false}
        value={source}
        onChange={(e) => { setSource(e.target.value); setDirty(true); setState("idle"); }}
      />
      <div className="actions">
        <Button onClick={save} disabled={!dirty || state === "saving"}>{state === "saving" ? "Checking…" : "Save"}</Button>
        <Button variant="outline" onClick={typecheck} disabled={state === "checking" || dirty}>
          {state === "checking" ? "Typechecking…" : "Typecheck"}
        </Button>
        {state === "saved" && !dirty && <Badge variant="outline">validated</Badge>}
        {checked?.ok && <Badge variant="outline">typechecked</Badge>}
      </div>
      {dirty && <div className="field-hint">Unsaved. Typecheck runs against what is on disk, so save first.</div>}
      {error && <div className="field-error wrap-pre">{error}</div>}
      {checked?.unavailable && <div className="field-error">Could not run tsc, so nothing was checked: {checked.unavailable}</div>}
      {checked && !checked.ok && !checked.unavailable && (
        <div className="field-error wrap-pre">{checked.diagnostics.join("\n")}</div>
      )}
      <div className="field-hint">
        Save gates on <code>validate()</code> plus every prompt file existing. Typecheck is the
        compiler, and it is the only thing that catches a type error inside a node.
      </div>
    </div>
  );
}

export function GraphsList() {
  const [catalog, setCatalog] = useState<GraphCatalog | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => getJSON<GraphCatalog>("/api/graphs").then(setCatalog).catch(() => {}), []);
  useEffect(() => { load(); }, [load, reloadKey]);
  const shape = useGraphShape(selected ? `${selected}?v=${reloadKey}` as any : undefined);
  const graphs = catalog?.graphs ?? [];
  const current = graphs.find((g) => g.name === selected);
  const isLocal = current?.source === "local";
  // HOW-22: `builder` is true only for a local graph that still carries the spec it was
  // built from. A hand-written one — or a built one since hand-edited past recognition —
  // is false, and gets told so rather than opened half-understood.
  const isBuilder = current?.builder === true;

  return (
    <div className="runs">
      <h1>Graphs</h1>
      <div className="graphs-layout">
        <div>
          {graphs.map((g) => (
            <Row key={g.name} className="run-row" selected={selected === g.name} onClick={() => setSelected(g.name)} aria-label={`the ${g.name} graph`}>
              <span className="run-goal">{g.name}</span>
              {g.source === "local" && <Badge variant="outline">{g.builder ? "built here" : "local"}</Badge>}
              <Badge variant="outline" className="ml-auto">{g.kind === "repo" ? <GitBranch /> : <FolderGit2 />}{g.kind}</Badge>
            </Row>
          ))}
          {/* a local graph that will not load is named here rather than quietly missing */}
          {catalog?.problems.map((p) => (
            <Row as="div" key={p.name} className="run-row run-row-problem">
              <span className="run-goal">{p.name}</span>
              <Badge variant="outline" className="ml-auto">will not load</Badge>
              <div className="field-error problem-why">{p.error}</div>
            </Row>
          ))}
          <div className="actions">
            <Button onClick={() => navigate("/graphs/new")}><Plus />Build a graph</Button>
          </div>
          <div className="field-hint">
            Built graphs are saved under <code>$HOWDAH_HOME/graphs</code>, not in the Howdah
            repo, so updating Howdah never touches them.
          </div>
        </div>
        <div>
          {shape ? (
            <>
              <div className="field-hint graph-description">{shape.description}</div>
              {current?.launched_by && (
                <div className="field-hint">
                  Started by <code>{current.launched_by}</code>, not from New run: it launches this graph for each approved
                  slice that has <code>depends_on</code>, and fills in its <code>deps</code> input itself.
                </div>
              )}
              {isBuilder && (
                <div className="actions">
                  <Button onClick={() => navigate(`/graphs/${selected}/build`)}><Pencil />Edit in builder</Button>
                </div>
              )}
              {isLocal ? (
                <>
                  {/* HOW-22: the source editor is still here and still the escape hatch for a
                      graph the builder's vocabulary cannot say — but it is no longer the FIRST
                      thing a local graph offers, because reading TypeScript is now optional. */}
                  {!isBuilder && (
                    <div className="field-hint">
                      This graph was not built in the builder, so the builder cannot open it — it
                      never guesses a spec back out of TypeScript. Edit the source below.
                    </div>
                  )}
                  <details className="graph-advanced">
                    <summary>Advanced — source</summary>
                    <GraphSource name={selected!} onSaved={() => setReloadKey((k) => k + 1)} />
                  </details>
                </>
              ) : (
                <div className="field-hint">Built-in graph: edit it in the Howdah repo, where <code>bun run check</code> covers it.</div>
              )}
              <GraphTuner shape={shape} onSaved={() => setReloadKey((k) => k + 1)} />
            </>
          ) : <EmptyState>select a graph</EmptyState>}
        </div>
      </div>
    </div>
  );
}
