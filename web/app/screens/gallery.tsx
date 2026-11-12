/**
 * The component gallery — `/dev/components` (HOW-68).
 *
 * Every primitive in `components/ui/`, in every state it has, on one page. It is not in the
 * rail; it is reached from the command palette ("Component gallery") or by its address.
 *
 * It exists for the visual loop (`tools/visual/shoot.mjs`, step `components-gallery`). The
 * design overhaul judges a primitive in BOTH themes before any screen is allowed to use it,
 * and until now the only way to see a destructive-outline button or an indeterminate checkbox
 * was to find the one screen that happened to render one, in the one state it happened to be
 * in. A defect in the component layer shipped twice that way (HOW-16's `.tab.on` and `.chip`):
 * nothing rendered the state, so nothing could see it was unstyled. Here every state is
 * rendered whether or not a screen uses it yet, so a regression has somewhere to show up.
 *
 * Two rules keep it honest. It composes ONLY primitives and Tailwind utilities — no class of
 * its own in howdah.css — so what is on this page is what the primitives look like, with
 * nothing dressed up for the occasion. And it is itself laid out the way DESIGN.md says a
 * screen is: a fixed header over ONE `ScrollPane`.
 *
 * States that need a pointer or a key (hover, press, an open menu) are live rather than
 * faked: hover it. The harness opens the layered ones before it shoots.
 *
 * Not shown: `message-scroller` and `questionnaire`. Both are the chat pane's vendored
 * composites (HOW-27, kept verbatim from the shadcn registry) and are only meaningful with a
 * transcript or a harness question behind them; they are judged on the run view.
 */
import { useDocumentTitle } from "@/lib/page";
import { useState } from "react";
import { Copy, FolderOpen, MoreHorizontal, Pause, Play, Plus, Square, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Chip } from "@/components/ui/chip";
import { CommandPalette } from "@/components/ui/command-palette";
import { AlertDialog, Dialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { KeyValue } from "@/components/ui/key-value";
import { Label } from "@/components/ui/label";
import { Markdown } from "@/components/ui/markdown";
import { Menu } from "@/components/ui/menu";
import { Popover } from "@/components/ui/popover";
import { Row } from "@/components/ui/row";
import { ScrollPane } from "@/components/ui/scroll-pane";
import { SectionLabel } from "@/components/ui/section-label";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ShortcutSheet } from "@/components/ui/shortcut-sheet";
import { LoadingBlock, Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PanelTabs, Tabs } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { Toolbar } from "@/components/ui/toolbar";
import { Tooltip } from "@/components/ui/tooltip";
import { Truncate } from "@/components/ui/truncate";

const LONG_ID = "implement-ticket-how-431-add-rate-limit-headers-to-the-public-api-gateway-and-document-them-mhv3a7xw";
const LONG_PATH = "/Users/operator/.howdah/repos/acme-api/worktrees/implement-ticket-mhv2k9qd/src/gateway/middleware/rate-limit-headers.ts";

/** one primitive: its name, then its specimens */
function Section({ name, note, children }: { name: string; note?: string; children: React.ReactNode }) {
  return (
    <section aria-label={name} data-gallery={name} className="border-b border-border py-5">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="m-0 text-md font-semibold">{name}</h2>
        {note !== undefined && <span className="text-sm text-muted-foreground">{note}</span>}
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

/** one state of it, labelled */
function Specimen({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <SectionLabel>{label}</SectionLabel>
      <div className={className ?? "flex flex-wrap items-center gap-2"}>{children}</div>
    </div>
  );
}

/** the three grounds a control can sit on — a ghost button that vanishes on one is a defect */
function Grounds({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-px overflow-hidden rounded-[var(--radius)] border border-border sm:grid-cols-3">
      {(["bg-background", "bg-card", "bg-muted"] as const).map((g) => (
        <div key={g} className={`flex flex-wrap items-center gap-2 p-3 ${g}`}>{children}</div>
      ))}
    </div>
  );
}

const BUTTON_VARIANTS = ["default", "outline", "ghost", "destructive", "destructive-outline", "link"] as const;
const BADGE_VARIANTS = ["default", "attention", "outline", "success", "destructive", "id", "scope-cleared", "scope-per-visit", "scope-sticky"] as const;

export function Gallery() {
  const { toast } = useToast();
  const [tab, setTab] = useState("build");
  const [pane, setPane] = useState<"activity" | "prompt" | "output">("activity");
  const [scope, setScope] = useState<"step" | "run">("step");
  const [chips, setChips] = useState<Record<string, boolean>>({ model: true, tool: false });
  const [checked, setChecked] = useState(true);
  const [dialog, setDialog] = useState(false);
  useDocumentTitle("Components");
  const [alert, setAlert] = useState(false);
  const [drawer, setDrawer] = useState(true);
  const [palette, setPalette] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [selectedRow, setSelectedRow] = useState("b");

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-screen="gallery">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-8">
        <h1 className="m-0 text-lg font-semibold">Components</h1>
        <span className="text-sm text-muted-foreground">Every primitive, every state. Switch the theme from the rail.</span>
      </header>
      <ScrollPane label="Component gallery" className="px-8 pb-16">
        <div className="max-w-[1100px]">
          <Section name="Button" note="default is the primary action: one per view. Press scales to 0.97; hover is colour only.">
            {BUTTON_VARIANTS.map((v) => (
              <Specimen key={v} label={v}>
                <Button variant={v} size={v === "link" ? "inline" : "default"}>Retry this step</Button>
                {v !== "link" && <Button variant={v} size="sm">Small</Button>}
                {v !== "link" && <Button variant={v} size="icon" aria-label={`${v} icon`}><Play /></Button>}
                {v !== "link" && <Button variant={v} size="icon-sm" aria-label={`${v} small icon`}><Copy /></Button>}
                {v !== "link" && <Button variant={v}><Plus />With icon</Button>}
                {v !== "link" && <Button variant={v}>With key <Kbd keys="r" decorative /></Button>}
                <Button variant={v} size={v === "link" ? "inline" : "default"} disabled>Disabled</Button>
                {v !== "link" && <Button variant={v} loading>Loading</Button>}
              </Specimen>
            ))}
            <Specimen label="on each ground" className="block">
              <Grounds>
                <Button>Primary</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="ghost" size="icon" aria-label="ghost icon"><MoreHorizontal /></Button>
              </Grounds>
            </Specimen>
          </Section>

          <Section name="Badge" note="static. Amber is the attention variant and nothing else.">
            <Specimen label="variants">
              {BADGE_VARIANTS.map((v) => <Badge key={v} variant={v}>{v === "id" ? "implementation.plan@2" : v}</Badge>)}
            </Specimen>
          </Section>

          <Section name="Chip" note="a toggle: aria-pressed, 24px minimum.">
            <Specimen label="off · on · attention on · disabled">
              <Chip on={chips.model === true} onClick={() => setChips((c) => ({ ...c, model: !c.model }))}>model</Chip>
              <Chip on={chips.tool === true} onClick={() => setChips((c) => ({ ...c, tool: !c.tool }))}>tool</Chip>
              <Chip on>on</Chip>
              <Chip tone="attention" on>attention</Chip>
              <Chip tone="attention">attention off</Chip>
              <Chip disabled>disabled</Chip>
            </Specimen>
          </Section>

          <Section name="Tabs" note="the selected tab is an indigo rule under its label; one row; arrows move.">
            <Specimen label="Tabs (a screen's switcher, with shortcut hints)" className="block border-b border-border">
              <Tabs
                value={tab}
                onValueChange={setTab}
                items={[
                  { value: "plan", label: "Plan", hint: "1" }, { value: "build", label: "Build", hint: "2" },
                  { value: "report", label: "Report", hint: "3" }, { value: "steps", label: "Steps", hint: "4" },
                  { value: "context", label: "Context", hint: "5" }, { value: "logs", label: "Logs", hint: "6" },
                  { value: "graph", label: "Graph", hint: "7" },
                ]}
              />
            </Specimen>
            <Specimen label="PanelTabs, underline" className="block border-b border-border">
              <PanelTabs
                className="flex gap-4"
                value={pane}
                onValueChange={setPane}
                items={[{ value: "activity", label: "Activity" }, { value: "prompt", label: "Prompt & context" }, { value: "output", label: "Output" }]}
              />
            </Specimen>
            <Specimen label="PanelTabs, chip">
              <PanelTabs className="flex gap-1.5" look="chip" value={scope} onValueChange={setScope} items={[{ value: "step", label: "Step" }, { value: "run", label: "Run" }]} />
            </Specimen>
          </Section>

          <Section name="Input, Select, Textarea" note="on the raised ground; sans unless the value is machine text (mono).">
            <div className="grid max-w-[760px] gap-3 sm:grid-cols-2">
              <Label>Name<Input defaultValue="HOW-431 Rate-limit headers" /></Label>
              <Label>Empty, with a placeholder<Input placeholder="Ask about this run…" /></Label>
              <Label>Mono (a path)<Input mono defaultValue="~/code/acme-api" /></Label>
              <Label>Disabled<Input disabled defaultValue="cannot change" /></Label>
              <Label>Select
                <Select defaultValue="implement-ticket">
                  <option value="implement-ticket">implement-ticket</option>
                  <option value="quick-task">quick-task</option>
                </Select>
              </Label>
              <Label>Select, disabled<Select disabled defaultValue="a"><option value="a">claude</option></Select></Label>
              <Label>Textarea<Textarea defaultValue="Reply with evidence that the metric is visible in production." /></Label>
              <Label>Textarea, mono<Textarea mono defaultValue={'{"outputs": {"review_verdict": "pass"}}'} /></Label>
            </div>
          </Section>

          <Section name="Checkbox" note="a real input; the hit area is 24px, the box 16px.">
            <Specimen label="unchecked · checked · indeterminate · disabled">
              <Checkbox label="Unchecked" />
              <Checkbox label="Checked" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              <Checkbox label="Indeterminate" ref={(el) => { if (el) el.indeterminate = true; }} />
              <Checkbox label="Disabled" disabled />
              <Checkbox label="Disabled, checked" disabled defaultChecked />
            </Specimen>
          </Section>

          <Section name="Kbd" note="prints a key from the registry's own grammar.">
            <Specimen label="a chord · a sequence · single keys · named keys">
              <Kbd keys="mod+k" /><Kbd keys="g r" /><Kbd keys="c" /><Kbd keys="?" /><Kbd keys="[" /><Kbd keys="mod+i" />
              <Kbd keys="escape" /><Kbd keys="enter" /><Kbd keys="shift+enter" /><Kbd>↑</Kbd><Kbd>↓</Kbd>
            </Specimen>
          </Section>

          <Section name="Truncate" note="the only way to ellipsize. Cut text grows a tooltip, on hover and on focus; text that fits stays plain.">
            <Specimen label="fits (no tooltip, no focus stop)" className="w-64"><Truncate>Bump Kotlin to 2.2</Truncate></Specimen>
            <Specimen label="cut" className="w-64"><Truncate>HOW-431 Add rate-limit headers to the public API gateway and document them</Truncate></Specimen>
            <Specimen label="cut, mono" className="w-64"><Truncate mono>{LONG_ID}</Truncate></Specimen>
            <Specimen label="middle (keeps the tail of an id or a path)" className="w-64"><Truncate mono middle>{LONG_ID}</Truncate></Specimen>
            <Specimen label="middle, a path" className="w-80"><Truncate mono middle={24}>{LONG_PATH}</Truncate></Specimen>
            <Specimen label="inside a link row (shows while the row has focus)" className="w-64">
              <Row href="/dev/components" className="flex h-9 items-center px-2.5"><Truncate>{LONG_ID}</Truncate></Row>
            </Specimen>
          </Section>

          <Section name="Tooltip, Popover, Menu" note="open from their trigger; scale in from it in 150ms, and not at all from the keyboard.">
            <Specimen label="triggers">
              <Tooltip content="Folder is gone: the worktree was removed"><Button variant="outline">Tooltip</Button></Tooltip>
              <Popover title="Pin a comment" trigger={<Button variant="outline">Popover</Button>}>
                <Input placeholder="What should change?" aria-label="comment" />
                <div className="flex justify-end gap-2"><Button size="sm">Pin</Button></div>
              </Popover>
              <Menu
                trigger={<Button variant="outline">More <Kbd keys="." decorative /></Button>}
                items={[
                  { heading: "This run" },
                  { label: "Open in IDE", icon: <FolderOpen />, keys: "o", onSelect: () => toast("Open in IDE") },
                  { label: "Copy resume command", icon: <Copy />, onSelect: () => toast("Copied") },
                  { label: "Open the graph", href: "/graphs" },
                  { label: "Unavailable here", disabled: true },
                  { separator: true },
                  { label: "Abort run", icon: <Trash2 />, destructive: true, onSelect: () => toast("Abort", "error") },
                ]}
              />
            </Specimen>
          </Section>

          <Section name="Dialog, AlertDialog, Toast" note="an interruption that must be answered. 180ms, opacity + 6px.">
            <Specimen label="open one">
              <Button variant="outline" onClick={() => setDialog(true)}>Dialog</Button>
              <Button variant="destructive-outline" onClick={() => setAlert(true)}>AlertDialog</Button>
              <Button variant="outline" onClick={() => toast("Reply delivered to implementation.implement@2")}>Toast</Button>
              <Button variant="outline" onClick={() => toast("Could not open the folder: /Users/operator/.howdah/repos/acme-api is gone", "error")}>Error toast</Button>
            </Specimen>
            <Dialog open={dialog} onClose={() => setDialog(false)} title="A plain dialog" description="It holds its own controls, and a tooltip inside it is drawn above it.">
              <Input placeholder="Type here" aria-label="example" />
              <div className="flex justify-end gap-2">
                <Tooltip content="Closes without saving"><Button variant="outline" size="sm" onClick={() => setDialog(false)}>Cancel</Button></Tooltip>
                <Button size="sm" onClick={() => setDialog(false)}>Save</Button>
              </div>
            </Dialog>
            <AlertDialog
              open={alert} onClose={() => setAlert(false)} onConfirm={() => setAlert(false)}
              title="Abort this run?" description="The agent stops at once and the worktree is kept. This cannot be undone." confirmLabel="Abort run"
            />
          </Section>

          <Section name="CommandPalette, ShortcutSheet" note="⌘K and ?. Both are rendered from lib/shortcuts.ts; neither animates.">
            <Specimen label="open one">
              <Button variant="outline" onClick={() => setPalette(true)}>Command palette <Kbd keys="mod+k" decorative /></Button>
              <Button variant="outline" onClick={() => setSheet(true)}>Shortcut sheet <Kbd keys="?" decorative /></Button>
            </Specimen>
            <CommandPalette open={palette} onClose={() => setPalette(false)} />
            <ShortcutSheet open={sheet} onClose={() => setSheet(false)} />
          </Section>

          <Section name="Toolbar" note="one row that never wraps; Left/Right move between its controls.">
            <Specimen label="a run header's actions" className="block">
              <div className="flex h-12 items-center gap-3 rounded-[var(--radius)] border border-border px-3">
                <Truncate className="flex-1 text-lg font-semibold">HOW-431 Add rate-limit headers to the public API gateway and document them</Truncate>
                <Toolbar label="Run actions">
                  <Button variant="ghost" size="sm"><Pause />Pause</Button>
                  <Button variant="ghost" size="sm"><Square />Stop</Button>
                  <Menu trigger={<Button variant="ghost" size="sm">More</Button>} items={[{ label: "Open run folder" }, { label: "Copy run id" }]} />
                  <Button variant="outline" size="sm">Details <Kbd keys="mod+i" decorative /></Button>
                </Toolbar>
              </div>
            </Specimen>
          </Section>

          <Section name="Drawer, KeyValue, ScrollPane" note="the drawer is in the layout, not over it: no scrim, no focus trap. Esc closes it.">
            <Specimen label="a pane with its details drawer" className="block">
              <div className="flex h-80 overflow-hidden rounded-[var(--radius)] border border-border">
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
                    <span className="flex-1 text-base font-medium">Transcript</span>
                    <Button variant="outline" size="sm" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>Details <Kbd keys="mod+i" decorative /></Button>
                  </div>
                  <ScrollPane label="Example transcript" className="p-3 text-body leading-normal">
                    {Array.from({ length: 14 }, (_, i) => (
                      <p key={i} className="m-0 mb-2 max-w-[70ch] text-muted-foreground">
                        Line {i + 1}. This pane overflows, so it is a focus stop: Tab to it and the arrow keys scroll it.
                      </p>
                    ))}
                  </ScrollPane>
                </div>
                <Drawer open={drawer} onClose={() => setDrawer(false)} label="Run details" title="Details" width={300}>
                  <SectionLabel as="h3" className="mb-1.5">Run</SectionLabel>
                  <KeyValue
                    items={[
                      { label: "Graph", value: "implement-ticket" },
                      { label: "Id", value: LONG_ID, mono: true, copy: true },
                      { label: "Branch", value: "howdah/implement-ticket-mhv2k9qd", mono: true, copy: true },
                      { label: "Worktree", value: LONG_PATH, mono: true, copy: true },
                      { label: "Cost", value: "$2.44" },
                      { label: "PR", value: null },
                    ]}
                  />
                </Drawer>
              </div>
            </Specimen>
          </Section>

          <Section name="Row" note="selected is the raised ground with a 1px outline. A waiting row carries NO tint and no stripe.">
            <Specimen label="static · clickable (hover it) · selected · needs input · a link" className="block">
              <div className="max-w-[640px]">
                <Row as="div" className="flex h-9 items-center gap-3 border-b border-border px-2.5 text-sm"><span className="flex-1">A static row</span><span className="text-muted-foreground">2h 53m</span></Row>
                {(["a", "b", "c"] as const).map((k) => (
                  <Row key={k} selected={selectedRow === k} needsInput={k === "c"} onClick={() => setSelectedRow(k)} className="flex h-9 items-center gap-3 border-b border-border px-2.5 text-sm">
                    <span className="flex-1">{k === "c" ? "A row whose run is waiting on you" : `Clickable row ${k}`}</span>
                    <span className="text-muted-foreground">{k === "c" ? "4h 22m" : "7s"}</span>
                  </Row>
                ))}
                <Row href="/dev/components" className="flex h-9 items-center gap-3 px-2.5 text-sm no-underline"><span className="flex-1">A navigation row (a real link)</span></Row>
              </div>
            </Specimen>
          </Section>

          <Section name="Table">
            <div className="max-w-[640px]">
              <Table>
                <TableHeader><TableRow><TableHead>Step</TableHead><TableHead>Harness</TableHead><TableHead>Model</TableHead></TableRow></TableHeader>
                <TableBody>
                  <TableRow><TableCell>implementation.plan</TableCell><TableCell>claude</TableCell><TableCell className="font-mono text-code">claude-opus-4</TableCell></TableRow>
                  <TableRow><TableCell>implementation.implement</TableCell><TableCell>codex</TableCell><TableCell className="font-mono text-code">gpt-5-codex</TableCell></TableRow>
                </TableBody>
              </Table>
            </div>
          </Section>

          <Section name="Card, Separator, SectionLabel" note="a card is a form or a decision surface, never a list item; no nested cards.">
            <div className="grid max-w-[760px] gap-3 sm:grid-cols-2">
              <Card>
                <CardHeader><CardTitle>Register a workspace</CardTitle><CardDescription>A local clone that runs may branch from.</CardDescription></CardHeader>
                <CardContent><Label>Path<Input mono placeholder="~/code/acme-api" /></Label><div className="flex justify-end"><Button size="sm">Register</Button></div></CardContent>
              </Card>
              <div className="flex flex-col gap-2">
                <SectionLabel count={11}>Needs you</SectionLabel>
                <Separator />
                <SectionLabel as="h3">A section label is 12px/600, never uppercase</SectionLabel>
              </div>
            </div>
          </Section>

          <Section name="Skeleton, EmptyState, Markdown" note="loading is the shape of the content, and it does not pulse.">
            <div className="grid gap-6 sm:grid-cols-2">
              <Specimen label="LoadingBlock" className="block"><LoadingBlock label="Loading runs" rows={3} /><Skeleton className="mt-2 h-4 w-24" /></Specimen>
              <Specimen label="EmptyState" className="block">
                <EmptyState className="py-8" title="No runs yet" actions={<Button size="sm"><Plus />New run <Kbd keys="c" decorative /></Button>}>
                  Runs appear here as soon as one is launched.
                </EmptyState>
              </Specimen>
              <Specimen label="Markdown" className="block max-w-[65ch]">
                <Markdown text={"### Plan\n\nAdd the three **rate-limit headers** to `gateway/middleware`:\n\n- `X-RateLimit-Limit`\n- `X-RateLimit-Remaining`\n\n```ts\nres.setHeader(\"X-RateLimit-Limit\", String(limit));\n```"} />
              </Specimen>
            </div>
          </Section>
        </div>
      </ScrollPane>
    </div>
  );
}
