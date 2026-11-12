/**
 * The Graphs screen (T20 + D9): the catalog, the per-node tuning editor, and the source
 * editor for a local graph. Out of main.tsx (HOW-16 P1).
 *
 * Three HOW-16 fixes: the agent-node table repeated `border-b border-border py-2 pr-3` on
 * every one of its eighteen cells and is a `Table` now (P1.4); its rows and the graph list's
 * rows were `<div onClick>`s with no role, tabIndex or key handler and are `Row`s (P2.8);
 * and saving tuning reports through a toast rather than by relabelling the Save button for
 * 1.5s, which nothing but a sighted operator watching that button could perceive.
 *
 * HOW-71: the way in is "Draft a graph" (HOW-56 D-1B), not the hand builder. It opens New run
 * with draft-graph picked and, when the selected graph is one the builder can open, that graph
 * as the base — `builder === true` is the same rule New run's Base list applies, so the link
 * never names a base the form would not offer. "Build by hand" stays, secondary.
 *
 * HOW-68 put the screen on the shared split frame (screens/frame.tsx): the catalog on the
 * left, the selected graph on the right, each its own scroller; below 1100px the graph replaces
 * the catalog, with Back and Esc. What changed inside it:
 *
 *   A catalog row says what a graph IS — name, where it lives (built in, built here, local),
 *   what it needs (repo or plain), its description and how many steps — instead of a name and
 *   a chip. A local graph that will not load is listed under its own heading with the reason,
 *   whole and wrapped, never quietly missing.
 *   The graph's picture gets a container with a real height, so the DAG's own scroller has
 *   something to scroll in (it used to size to the graph and run off the page).
 *   The step table keeps its columns at any width and scrolls sideways INSIDE itself; it is
 *   the first thing after the picture, because it is the answer to "what will each step run
 *   on". The "override" marker was the amber attention badge on a row that needs nothing from
 *   anybody — it is a neutral chip (DESIGN.md: amber means waiting on you, and nothing else).
 *   The three tuning forms are sections, not cards in a column of cards.
 *   The source editor is mono, in its own bounded scroller, behind an "Edit the source"
 *   disclosure.
 *
 * ONE primary action on the screen: "Draft a graph", in the header. Saving tuning and saving
 * source are outline buttons beside the thing they save, each saying when there is something
 * unsaved.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranch, FolderGit2, SlidersHorizontal, Pencil, Play, Plus, Sparkles, ChevronDown, ChevronRight, RotateCcw as ResetIcon } from "lucide-react";
import type { GraphCatalog, GraphInfo } from "@/lib/types";
import { navigate } from "@/lib/nav";
import { useTypedText } from "@/lib/hooks";
import { useListNav } from "@/lib/list-nav";
import { getJSON } from "@/lib/net";
import { graphDescription } from "@/lib/format";
import { GraphDag, useGraphShape, type GraphShapeDto, type AgentConfigDto } from "../graph-dag";
import { modelFitsHarness } from "../../../core/graph";
import { DRAFT_GRAPH } from "../../../core/catalog";
import { defaultHarness, effortFor, harnessNames, harnessSpec, isHarness } from "../../../core/harnesses";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Row } from "@/components/ui/row";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionLabel } from "@/components/ui/section-label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Truncate } from "@/components/ui/truncate";
import { useToast } from "@/components/ui/toast";
import { CODE, FieldError, Hint, KeyHints, LIST_HINTS, LoadError, Section, SplitScreen } from "./frame";

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
        <Input mono list="model-suggestions" value={value.model ?? ""} placeholder={ph("model", "harness default")} onChange={(e) => onChange({ ...value, model: e.target.value || undefined })} />
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
      toast(e instanceof Error ? e.message : "Could not save the tuning", "error");
    }
  };

  const effective = (n: (typeof agentNodes)[number]) =>
    [n.effective?.harness, n.effective?.model, n.effective?.effort, n.effective?.effortInert && `effort inert (${n.effective.effortInert})`, n.effective?.permissionMode].filter(Boolean).join(" · ");
  return (
    <div data-slot="tuner" className="flex flex-col gap-6">
      <Section title="Shape" description="Select an agent step, here or in the table below, to override what it runs on.">
        {/* a real height: the canvas needs a box to pan in. Keyed on the graph alone — it used
            to remount on every tuning edit, which now would throw away where the operator had
            panned to. The page scrolls under the wheel here; ⌘/Ctrl + wheel zooms the picture. */}
        <div data-slot="graph-picture" className="flex h-[min(560px,64dvh)] min-h-[300px] flex-col">
          <GraphDag key={shape.name} shape={preview} onSelect={setSelectedNode} selected={selectedNode ?? undefined} wheel="page" />
        </div>
      </Section>

      <Section title="Agent steps" count={agentNodes.length} description="What each step will run on once the settings below are saved.">
        {agentNodes.length === 0 ? <Hint>This graph has no agent steps, so there is nothing to tune.</Hint> : (
          <Table className="whitespace-nowrap">
            <TableHeader>
              <TableRow>
                <TableHead>Step</TableHead>
                <TableHead>Class</TableHead>
                <TableHead>Harness</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Effort</TableHead>
                <TableHead>Settings</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agentNodes.map((n) => (
                <TableRow key={n.id} data-selected={selectedNode === n.id || undefined} className={selectedNode === n.id ? "bg-card" : ""}>
                  {/* the whole row selects a step, but a table cell cannot BE a button and stay
                      a table — so the step id is the control and the row follows it */}
                  <TableCell className="font-mono text-code">
                    <Button variant="link" size="inline" className="text-foreground" aria-pressed={selectedNode === n.id} onClick={() => setSelectedNode(n.id)}>{n.id}</Button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{n.class ?? "—"}</TableCell>
                  <TableCell>{n.effective?.harness ?? "claude"}</TableCell>
                  <TableCell className="font-mono text-code">{n.effective?.model ?? <span className="font-sans text-base text-muted-foreground">harness default</span>}</TableCell>
                  <TableCell>{n.effective?.effortInert ? `inert (${n.effective.effortInert})` : n.effective?.effort ?? "—"}</TableCell>
                  <TableCell>{n.node_tuning ? <Badge>overridden</Badge> : <Badge variant="outline">inherited</Badge>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <div className="grid items-start gap-x-8 gap-y-6 min-[1360px]:grid-cols-2">
        <Section
          title={node?.kind === "agent" ? "This step" : "A step's own settings"}
          description={node?.kind === "agent" ? undefined : "Select an agent step in the picture or the table to override its settings."}
        >
          {node?.kind === "agent" && (
            <>
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-code font-medium text-foreground [overflow-wrap:anywhere]">{node.id}</span>
                <Hint>Prompt <span className="font-mono text-code">{node.prompt}</span>. Runs now on: {effective(node) || "the harness default"}.</Hint>
              </div>
              <ConfigFields value={tuning.nodes?.[node.id] ?? {}} baseline={node.baseline} inheritedHarness={shape.default_harness} onChange={(v) => setNodeCfg(node.id, v)} />
              <Button variant="ghost" size="sm" className="-ml-2 self-start" onClick={() => clearNodeCfg(node.id)}><ResetIcon />Clear this step's override</Button>
            </>
          )}
        </Section>
        <Section title="Graph defaults" description="Applies to every agent step unless the step sets its own. A cleared field falls back to the graph file.">
          <ConfigFields value={tuning.defaults ?? {}} baseline={shape.defaults} inheritedHarness={shape.default_harness} onChange={(v) => { setTuning({ ...tuning, defaults: v }); setDirty(true); }} />
        </Section>
        <Section title="Bulk update" description="Set the harness, model and effort for a whole slice of the graph at once.">
          <Label>
            Target
            <Select value={bulkTarget} onChange={(e) => setBulkTarget(e.target.value)}>
              <option value="all">all agent steps</option>
              <option value="role:planning">planning steps</option>
              {classes.map((c) => <option key={c} value={`class:${c}`}>{c} class</option>)}
            </Select>
          </Label>
          <div className="grid grid-cols-1 gap-3 min-[720px]:grid-cols-3">
            <Label>
              Harness
              <Select value={bulkConfig.harness ?? ""} onChange={(e) => setBulkConfig({ ...bulkConfig, harness: e.target.value || undefined })}>
                {HARNESSES.map((x) => <option key={x} value={x}>{x || "keep current"}</option>)}
              </Select>
            </Label>
            <Label>
              Model
              <Input mono list="model-suggestions" value={bulkConfig.model ?? ""} placeholder="keep current" onChange={(e) => setBulkConfig({ ...bulkConfig, model: e.target.value || undefined })} />
            </Label>
            <Label>
              Effort
              <Select value={bulkConfig.effort ?? ""} onChange={(e) => setBulkConfig({ ...bulkConfig, effort: e.target.value || undefined })}>
                {EFFORTS.map((x) => <option key={x} value={x}>{x || "keep current"}</option>)}
              </Select>
            </Label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => applyBulk()}><SlidersHorizontal />Apply to {selectedIds.length}</Button>
            {BULK_PRESETS.map((p) => (
              <Button key={p.id} variant="outline" size="sm" onClick={() => { setBulkTarget(p.target); setBulkConfig(p.cfg); applyBulk(p.cfg, p.target); }}>{p.label}</Button>
            ))}
            <Button variant="ghost" size="sm" onClick={() => clearBulk()}><ResetIcon />Clear target overrides</Button>
          </div>
        </Section>
      </div>

      <div data-slot="tuner-save" className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={save} disabled={!dirty} loading={state === "saving"}>
          {state === "failed" ? "Save failed — retry" : "Save tuning"}
        </Button>
        <p role="status" className="m-0 text-sm text-muted-foreground">
          {dirty ? "Unsaved changes. They apply to new runs once saved." : state === "saved" ? "Saved. It applies to new runs." : "Tuning applies to new runs; a run in flight keeps what it started with."}
        </p>
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
      if (!r.ok) { setError(body.error ?? "The save was refused."); setState("idle"); toast(body.error ?? "The save was refused.", "error"); return; }
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

  if (source === null) {
    return <div role="status" aria-busy="true" className="flex flex-col gap-2"><span className="sr-only">Reading {name}.ts</span><Skeleton className="h-40 w-full" /></div>;
  }

  return (
    <div data-slot="graph-source" className="flex flex-col gap-3">
      {/* mono, unwrapped, in its own bounded scroller: the file is the artifact, and a wrapped line of TypeScript is a different line */}
      <Textarea
        mono
        wrap="off"
        className="h-[min(480px,60dvh)] min-h-[200px] resize-y overflow-auto whitespace-pre text-code leading-[1.55] [tab-size:2]"
        aria-label={`${name}.ts source`}
        spellCheck={false}
        value={source}
        onChange={(e) => { setSource(e.target.value); setDirty(true); setState("idle"); }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={save} disabled={!dirty} loading={state === "saving"}>{state === "saving" ? "Checking" : "Save"}</Button>
        <Button variant="outline" onClick={typecheck} disabled={dirty} loading={state === "checking"}>
          {state === "checking" ? "Typechecking" : "Typecheck"}
        </Button>
        {state === "saved" && !dirty && <Badge variant="outline">validated</Badge>}
        {checked?.ok && <Badge variant="outline">typechecked</Badge>}
      </div>
      {dirty && <Hint>Unsaved. Typecheck runs against what is on disk, so save first.</Hint>}
      {error && <FieldError pre>{error}</FieldError>}
      {checked?.unavailable && <FieldError>Could not run tsc, so nothing was checked: {checked.unavailable}</FieldError>}
      {checked && !checked.ok && !checked.unavailable && (
        <FieldError pre className="font-mono text-code">{checked.diagnostics.join("\n")}</FieldError>
      )}
      <Hint>
        Save gates on <code className={CODE}>validate()</code> plus every prompt file existing. Typecheck is the
        compiler, and it is the only thing that catches a type error inside a step.
      </Hint>
    </div>
  );
}

/** one catalog row: what the graph is, where it lives, what it needs, how big it is */
function GraphRow({ g, selected, onSelect }: { g: GraphInfo; selected: boolean; onSelect: () => void }) {
  return (
    <Row
      className="flex flex-col gap-0.5 border-b border-border px-2 py-2 text-sm leading-[1.4]"
      selected={selected} onClick={onSelect} aria-label={`the ${g.name} graph`} data-nav-row={g.name}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Truncate className="flex-1 text-body font-medium text-foreground">{g.name}</Truncate>
        {g.source === "local" && <Badge variant="outline">{g.builder ? "built here" : "local"}</Badge>}
        <Badge variant="outline">{g.kind === "repo" ? <GitBranch aria-hidden /> : <FolderGit2 aria-hidden />}{g.kind}</Badge>
      </span>
      <span className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
        <Truncate className="flex-1">{graphDescription(g.description) ?? "No description yet."}</Truncate>
        {g.steps !== undefined && <span className="shrink-0 tabular-nums">{g.steps} step{g.steps === 1 ? "" : "s"}</span>}
      </span>
    </Row>
  );
}

export function GraphsList() {
  const [catalog, setCatalog] = useState<GraphCatalog | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showSource, setShowSource] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => { setFailed(false); return getJSON<GraphCatalog>("/api/graphs").then(setCatalog).catch(() => setFailed(true)); }, []);
  useEffect(() => { load(); }, [load, reloadKey]);
  useEffect(() => { setShowSource(false); }, [selected]);
  const shape = useGraphShape(selected ? `${selected}?v=${reloadKey}` as any : undefined);
  const graphs = catalog?.graphs ?? [];
  const current = graphs.find((g) => g.name === selected);
  const isLocal = current?.source === "local";
  // HOW-22: `builder` is true only for a local graph that still carries the spec it was
  // built from. A hand-written one — or a built one since hand-edited past recognition —
  // is false, and gets told so rather than opened half-understood.
  const isBuilder = current?.builder === true;
  const draftHref = `/new?${new URLSearchParams({ graph: DRAFT_GRAPH, ...(isBuilder && selected ? { base: selected } : {}) })}`;
  const nav = useListNav({ noun: "graph", arrows: "list", enabled: graphs.length > 0 });
  const problems = catalog?.problems ?? [];

  const list = catalog === null && failed ? (
    <LoadError what="the graphs" onRetry={() => void load()} />
  ) : catalog === null ? (
    <div role="status" aria-busy="true" className="flex flex-col gap-2 px-2"><span className="sr-only">Loading graphs</span>{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-11 w-full" />)}</div>
  ) : (
    <div ref={nav.ref} {...nav.containerProps} className="flex flex-col gap-5">
      {graphs.length === 0
        ? <Hint className="px-2">No graph loaded. The built-in graphs ship with Howdah, so this means the registry failed to load — see the terminal running the viewer.</Hint>
        : <div className="flex flex-col">{graphs.map((g) => <GraphRow key={g.name} g={g} selected={selected === g.name} onSelect={() => setSelected(g.name)} />)}</div>}
      {/* a local graph that will not load is named here rather than quietly missing */}
      {problems.length > 0 && (
        <section aria-label="Will not load" className="flex flex-col gap-2 px-2">
          <SectionLabel as="h2" count={problems.length}>Will not load</SectionLabel>
          {problems.map((p) => (
            <div key={p.name} data-problem={p.name} className="flex flex-col gap-0.5 border-b border-border pb-2">
              <span className="text-body font-medium text-foreground [overflow-wrap:anywhere]">{p.name}</span>
              <FieldError pre>{p.error}</FieldError>
            </div>
          ))}
        </section>
      )}
      <Hint className="px-2">
        Your own graphs are saved under <code className={CODE}>$HOWDAH_HOME/graphs</code>, not in the Howdah
        repo, so updating Howdah never touches them.
      </Hint>
    </div>
  );

  const detail = !selected ? (
    <EmptyState title="Select a graph">Its shape, its steps and what each one runs on appear here. To make a new one, draft it from a sentence or build it by hand.</EmptyState>
  ) : !shape ? (
    <div role="status" aria-busy="true" className="flex flex-col gap-3"><span className="sr-only">Loading {selected}</span><Skeleton className="h-6 w-56" /><Skeleton className="h-4 w-full" /><Skeleton className="h-64 w-full" /></div>
  ) : (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 text-xl font-semibold leading-7 [overflow-wrap:anywhere]">{shape.name}</h2>
          {current && <Badge variant="outline">{current.source === "local" ? (current.builder ? "built here" : "local") : "built in"}</Badge>}
          {current && <Badge variant="outline">{current.kind === "repo" ? <GitBranch aria-hidden /> : <FolderGit2 aria-hidden />}{current.kind}</Badge>}
        </div>
        {graphDescription(shape.description) && <p data-slot="graph-description" className="m-0 max-w-[72ch] text-body leading-normal text-muted-foreground">{graphDescription(shape.description)}</p>}
        {current?.launched_by && (
          <Hint>
            Started by <code className={CODE}>{current.launched_by}</code>, not from New run: it launches this graph for each approved
            slice that has <code className={CODE}>depends_on</code>, and fills in its <code className={CODE}>deps</code> input itself.
          </Hint>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {current && !current.launched_by && <a className={buttonVariants({ variant: "outline", size: "sm" })} href={`/new?graph=${encodeURIComponent(current.name)}`}><Play aria-hidden />Run this graph</a>}
          {isBuilder && <Button variant="outline" size="sm" onClick={() => navigate(`/graphs/${selected}/build`)}><Pencil />Edit in builder</Button>}
        </div>
        {!isLocal && <Hint>A built-in graph: edit it in the Howdah repo, where <code className={CODE}>bun run check</code> covers it.</Hint>}
        {isLocal && !isBuilder && (
          <Hint>
            This graph was not built in the builder, so the builder cannot open it — it
            never guesses a spec back out of TypeScript. Edit its source below.
          </Hint>
        )}
      </div>
      <GraphTuner shape={shape} onSaved={() => setReloadKey((k) => k + 1)} />
      {isLocal && (
        // HOW-22: the source editor is still here and still the escape hatch for a graph the
        // builder's vocabulary cannot say — but it is not the FIRST thing a local graph offers,
        // because reading TypeScript is optional.
        <div className="flex flex-col gap-3">
          <Button variant="ghost" size="sm" className="-ml-2 self-start" aria-expanded={showSource} aria-controls="graph-source" onClick={() => setShowSource((v) => !v)}>
            {showSource ? <ChevronDown /> : <ChevronRight />}Edit the source
          </Button>
          {showSource && <div id="graph-source"><GraphSource name={selected} onSaved={() => setReloadKey((k) => k + 1)} /></div>}
        </div>
      )}
    </>
  );

  return (
    <SplitScreen
      name="graphs"
      title="Graphs"
      actions={
        <>
          <Button onClick={() => navigate(draftHref)}><Sparkles />Draft a graph</Button>
          <Button variant="outline" onClick={() => navigate("/graphs/new")}><Plus />Build by hand</Button>
        </>
      }
      footer={<KeyHints hints={LIST_HINTS} />}
      list={list}
      listLabel="Graphs"
      detail={detail}
      detailLabel={selected ?? "Graph"}
      hasDetail={selected !== null}
      onBack={() => setSelected(null)}
      backLabel="Graphs"
    />
  );
}
