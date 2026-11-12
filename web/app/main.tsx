/**
 * Howdah web app v0 (T11). Path routing: `/` runs list, `/run/:id` run view
 * (deep-linkable, `#needs-input` focuses the reply). Live via SSE. Served pre-bundled
 * as /app.js (bun build web/app/main.tsx — see web/server.ts startup).
 *
 * After HOW-16 this file is ONLY the shell: the rail, the path router, the ToastProvider
 * mount and createRoot — and, since HOW-68, the keyboard layer's global rows, the command
 * palette, the `?` sheet and a real 404 (an unknown path used to render the Runs list). Every screen lives under `screens/`, the run's panes under `run/`,
 * the primitives under `components/ui/` and the helpers under `lib/` — main.tsx was 2,900
 * lines and held ten screens, nineteen inline styles and both styling systems at once.
 */
import "./globals.css";
// HOW-24: React Flow's own sheet, imported HERE and never pasted into howdah.css/tokens.css —
// those three are scanned by app/css-contract.test.ts in both directions, and a few hundred
// unconsumed vendor rules would fail "every rule has a consumer" instantly. The canvas is
// themed by setting React Flow's custom properties from tokens.css, under .gb-canvas.
import "@xyflow/react/dist/style.css";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState } from "react";
import { Rows3, Plus, Workflow, Settings as SettingsIcon, Library, FileDiff, BellRing, Sun, Moon, Monitor, Search, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { ProposalView } from "../../prompts/proposals";
import type { InboxItem } from "../../engine/attention-inbox";
import type { ReadyItem } from "../draft";
import { PROPOSALS_CHANGED } from "@/lib/types";
import { getJSON } from "@/lib/net";
import { navigate } from "@/lib/nav";
import { useMediaQuery } from "@/lib/hooks";
import { installShortcuts, useShortcuts } from "@/lib/shortcuts";
import { Button, buttonVariants } from "@/components/ui/button";
import { CommandPalette } from "@/components/ui/command-palette";
import { Kbd } from "@/components/ui/kbd";
import { ShortcutSheet } from "@/components/ui/shortcut-sheet";
import { Tooltip } from "@/components/ui/tooltip";
import { ToastProvider } from "@/components/ui/toast";
import { usePanel } from "@/lib/panel";
import { Mark } from "./brand";
import { RunView } from "./run/view";
import { RunsList } from "./screens/runs";
import { StartRun } from "./screens/start-run";
import { GraphsList } from "./screens/graphs";
import { GraphBuilder } from "./screens/graph-builder";
import { PromptsScreen } from "./screens/prompts";
import { ProposalsScreen } from "./screens/proposals";
import { Settings } from "./screens/settings";
import { AttentionInbox } from "./screens/attention";
import { DraftReview } from "./screens/draft-review";
import { NotFound } from "./screens/not-found";
import { Gallery } from "./screens/gallery";

const THEMES = ["dark", "light", "system"] as const;
type Theme = (typeof THEMES)[number];
const THEME_ICON = { dark: Moon, light: Sun, system: Monitor };

/**
 * The theme control is an icon: the ghost button reading "theme: system" was the one item in
 * the nav that spelled its own state out in prose, and it had no icon to stand in for it when
 * the rail collapsed.
 *
 * An icon-only control has to say two things the glyph cannot. The MODE is the icon (moon,
 * sun, monitor — not one toggle, because "system" is a third state and a two-way switch
 * cannot express it), and the accessible name carries both where you are and where the next
 * press goes, so the control is usable without seeing it (HOW-16 P2.11).
 */
/** Exported for component tests (web/app/panel.test.tsx). */
export function ThemeToggle({ theme, onChange }: { theme: string; onChange: (t: Theme) => void }) {
  const current = (THEMES as readonly string[]).includes(theme) ? (theme as Theme) : "system";
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]!;
  const Icon = THEME_ICON[current];
  return (
    <Tooltip side="right" align="center" content={`Theme: ${current} — switch to ${next}`}>
      <Button variant="ghost" size="icon" aria-label={`Theme: ${current}. Switch to ${next}.`} onClick={() => onChange(next)}>
        <Icon />
      </Button>
    </Tooltip>
  );
}

/** the skip link wears Button's appearance; it is an `<a>` because it goes somewhere */
const SKIP_LINK_LOOK = buttonVariants({ variant: "outline", size: "sm" });

/** DESIGN.md Layout: "below 1100px the rail collapses to icons by itself" */
const RAIL_AUTO_COLLAPSE = "(max-width: 1099px)";

/**
 * One item in the rail. It is a real link (middle-click and copy-link work) and a 32px target.
 *
 * Its trailing slot holds ONE thing: a count when there is one, else the key that goes there.
 * The count wins because it is news and the key is a hint — and the two together are what
 * pushed "Needs you" onto a second line.
 *
 * The accessible name is spelled out (`aria-label`) rather than left to the content, for two
 * reasons: when the rail is icons the label is not rendered at all, and a bare "11" beside a
 * word is not a sentence. The Tooltip only speaks in the icon rail, where the icon is all
 * there is to see.
 */
function NavItem({ href, icon, label, active, collapsed, keys, counts = [] }: {
  href: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
  collapsed: boolean;
  keys?: string;
  /** `quiet` is a count that is not the alarm: drafts ready, proposals pending */
  counts?: Array<{ n: number; what: string; quiet?: boolean }>;
}) {
  const live = counts.filter((c) => c.n > 0);
  const name = [label, ...live.map((c) => `${c.n} ${c.what}`)].join(", ");
  return (
    <Tooltip
      className="nav-tip"
      disabled={!collapsed}
      side="right"
      align="center"
      content={<span className="inline-flex items-center gap-2">{name}{keys !== undefined && <Kbd keys={keys} />}</span>}
    >
      <a className={`nav ${active ? "active" : ""}`} href={href} aria-label={name} aria-current={active ? "page" : undefined}>
        {icon}
        <span className="label">{label}</span>
        {live.map((c) => <span key={c.what} className={`nav-badge ${c.quiet ? "quiet" : ""}`}>{c.n}</span>)}
        {live.length === 0 && keys !== undefined && <Kbd keys={keys} decorative className="nav-kbd" />}
      </a>
    </Tooltip>
  );
}

/** Exported for the shell tests (web/app/shell.test.tsx); `mount` below is the only real caller. */
export function App() {
  const [path, setPath] = useState(location.pathname);
  // the rail collapses to icons: by the operator's toggle (remembered) or by the window being
  // too narrow for it. Width is fixed by CSS, so only the open/closed state is ours.
  const nav = usePanel({ key: "howdah.nav", min: 176, def: 176, minOther: 480, side: "left" });
  const narrow = useMediaQuery(RAIL_AUTO_COLLAPSE);
  const collapsed = narrow || nav.collapsed;
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a[href^='/']");
      if (a && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        history.pushState(null, "", (a as HTMLAnchorElement).href);
        setPath(location.pathname);
      }
    };
    const onPop = () => setPath(location.pathname);
    document.addEventListener("click", onClick);
    window.addEventListener("popstate", onPop);
    return () => { document.removeEventListener("click", onClick); window.removeEventListener("popstate", onPop); };
  }, []);

  const [theme, setTheme] = useState<string>(() => localStorage.getItem("howdah-theme") ?? "system");
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    localStorage.setItem("howdah-theme", theme);
  }, [theme]);
  const nextTheme = THEMES[(THEMES.indexOf((THEMES as readonly string[]).includes(theme) ? (theme as Theme) : "system") + 1) % THEMES.length]!;

  // a trailing slash is the same place; anything else that matches nothing is a 404, not Runs
  const route = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const runMatch = route.match(/^\/run\/([^/]+)/);
  const promptMatch = route.match(/^\/prompts(?:\/(.+))?$/);
  const proposalMatch = route.match(/^\/proposals(?:\/(.+))?$/);
  const isNew = route === "/new";
  const isSettings = route === "/settings";
  const isGraphs = route === "/graphs";
  // HOW-22: the graph builder. /graphs/new is a draft with no file yet; /graphs/:name/build
  // re-opens one that has one. Both sit UNDER /graphs so the nav's Graphs tab stays lit —
  // building a graph is not a different place, it is what that place is for.
  const buildMatch = route === "/graphs/new" ? { name: undefined } : (() => {
    const m = route.match(/^\/graphs\/([^/]+)\/build$/);
    return m ? { name: m[1]! } : null;
  })();
  const isAttention = route === "/attention";
  // HOW-65: a draft-graph run's review page. `/runs/…` never matches `/run/:id`, so the two cannot clash
  const draftMatch = route.match(/^\/runs\/([^/]+)\/draft$/);
  const fromRun = buildMatch && !buildMatch.name ? new URLSearchParams(location.search).get("fromRun") : null;
  const isRuns = route === "/";
  // HOW-68: every primitive in every state. Not in the nav — it is reached from the palette —
  // and it is what tools/visual shoots to check the component layer in both themes.
  const isGallery = route === "/dev/components";

  // how many drafts are waiting for you to look — R2's whole point is that you look, so a
  // count that goes stale after an accept is worse than no count: it is a live-looking lie
  const [pending, setPending] = useState(0);
  const countPending = useCallback(() => {
    getJSON<ProposalView[]>("/api/proposals")
      .then((ps) => setPending(ps.filter((p) => p.status === "pending").length))
      .catch(() => setPending(0));
  }, []);
  useEffect(() => {
    countPending();
    window.addEventListener(PROPOSALS_CHANGED, countPending);
    return () => window.removeEventListener(PROPOSALS_CHANGED, countPending);
  }, [countPending, path]);

  // how many runs are standing there waiting for a human (HOW-20). Polled, not counted from
  // the runs list: this is the same read model the notifications ring by, so the badge and
  // the banner can never say different numbers.
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    const load = () => getJSON<InboxItem[]>("/api/attention").then((i) => setWaiting(i.length)).catch(() => setWaiting(0));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [path]);
  // HOW-67: finished drafts waiting to be looked at — a SEPARATE, grey count, never added to
  // `waiting`: amber means a run cannot go on without you, and a draft can wait
  const [ready, setReady] = useState(0);
  useEffect(() => {
    const load = () => getJSON<ReadyItem[]>("/api/ready").then((i) => setReady(i.length)).catch(() => setReady(0));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [path]);

  // HOW-68: the keyboard layer. The listener is installed once, here; what it can DO is the
  // registry (lib/shortcuts.ts), and these are the rows that exist on every screen. The `?`
  // sheet and the ⌘K palette are both rendered from that registry, so this list is also
  // their content — a screen adds its own rows with the same hook.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => installShortcuts(), []);
  useShortcuts([
    { id: "palette", scope: "Anywhere", label: "Command palette", keys: "mod+k", palette: false, run: () => setPaletteOpen(true) },
    { id: "shortcuts", scope: "Anywhere", label: "Keyboard shortcuts", keys: "?", keywords: "help keys", run: () => setSheetOpen(true) },
    { id: "go.runs", scope: "Anywhere", label: "Go to Runs", keys: "g r", run: () => navigate("/") },
    { id: "go.attention", scope: "Anywhere", label: "Go to Needs you", keys: "g n", keywords: "attention inbox waiting", run: () => navigate("/attention") },
    { id: "go.graphs", scope: "Anywhere", label: "Go to Graphs", keys: "g g", run: () => navigate("/graphs") },
    { id: "go.prompts", scope: "Anywhere", label: "Go to Prompts", keys: "g p", run: () => navigate("/prompts") },
    { id: "go.proposals", scope: "Anywhere", label: "Go to Proposals", keys: "g o", keywords: "revisions", run: () => navigate("/proposals") },
    { id: "go.settings", scope: "Anywhere", label: "Go to Settings", keys: "g s", keywords: "preferences workspaces", run: () => navigate("/settings") },
    { id: "run.new", scope: "Anywhere", label: "New run", keys: "c", keywords: "create start launch", run: () => navigate("/new") },
    { id: "graph.new", scope: "Anywhere", label: "New graph", keywords: "create build", run: () => navigate("/graphs/new") },
    { id: "rail", scope: "Anywhere", label: collapsed ? "Show the sidebar" : "Hide the sidebar", keys: "[", keywords: "rail nav collapse toggle", disabled: narrow, run: nav.toggle },
    { id: "theme", scope: "Anywhere", label: `Switch theme to ${nextTheme}`, keywords: "dark light system appearance toggle", run: () => setTheme(nextTheme) },
    { id: "layers.escape", scope: "Layers", label: "Close the topmost: menu, dialog, detail panel, drawer", keys: "escape", passive: true },
    { id: "dev.gallery", scope: "Developer", label: "Component gallery", keywords: "primitives design system dev", run: () => navigate("/dev/components") },
  ]);

  return (
    <ToastProvider>
      <div className="shell" data-nav={collapsed ? "rail" : "full"}>
        <a className={`${SKIP_LINK_LOOK} skip-link`} href="#main">Skip to content</a>
        <nav className="sidebar" aria-label="Primary">
          <a className="mark-btn" href="/" aria-label="Howdah — runs"><Mark className="mark" /><span className="wordmark">Howdah</span></a>
          <NavItem href="/" icon={<Rows3 size={15} />} label="Runs" keys="g r" active={isRuns || !!runMatch || !!draftMatch} collapsed={collapsed} />
          <NavItem
            href="/attention" icon={<BellRing size={15} />} label="Needs you" keys="g n" active={isAttention} collapsed={collapsed}
            counts={[{ n: waiting, what: "waiting on you" }, { n: ready, what: "ready to review", quiet: true }]}
          />
          <NavItem href="/new" icon={<Plus size={15} />} label="New run" keys="c" active={isNew} collapsed={collapsed} />
          <NavItem href="/graphs" icon={<Workflow size={15} />} label="Graphs" keys="g g" active={isGraphs || !!buildMatch} collapsed={collapsed} />
          <NavItem href="/prompts" icon={<Library size={15} />} label="Prompts" keys="g p" active={!!promptMatch} collapsed={collapsed} />
          <NavItem
            href="/proposals" icon={<FileDiff size={15} />} label="Proposals" keys="g o" active={!!proposalMatch} collapsed={collapsed}
            counts={[{ n: pending, what: "pending", quiet: true }]}
          />
          <NavItem href="/settings" icon={<SettingsIcon size={15} />} label="Settings" keys="g s" active={isSettings} collapsed={collapsed} />
          <div className="spacer" />
          <div className="nav-footer">
            <Tooltip className="nav-tip" disabled={!collapsed} side="right" align="center" content={<span className="inline-flex items-center gap-2">Commands <Kbd keys="mod+k" /></span>}>
              <Button variant="ghost" className="nav-cmd" aria-label="Commands" aria-haspopup="dialog" onClick={() => setPaletteOpen(true)}>
                <Search className="nav-cmd-icon" />
                <Kbd keys="mod+k" decorative className="nav-kbd" />
                <span className="label">Commands</span>
              </Button>
            </Tooltip>
            <div className="nav-footer-row">
              <ThemeToggle theme={theme} onChange={setTheme} />
              {/* under 1100px the rail is icons whatever the preference says, so there is nothing to toggle */}
              {!narrow && (
                <Tooltip side="right" align="center" content={<span className="inline-flex items-center gap-2">{collapsed ? "Show the sidebar" : "Hide the sidebar"} <Kbd keys="[" /></span>}>
                  <Button variant="ghost" size="icon" aria-expanded={!collapsed} aria-label={collapsed ? "Show the sidebar" : "Hide the sidebar"} onClick={nav.toggle}>
                    {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
                  </Button>
                </Tooltip>
              )}
            </div>
          </div>
        </nav>
        <main id="main">
          {runMatch ? <RunView id={runMatch[1]!} />
            : draftMatch ? <DraftReview runId={decodeURIComponent(draftMatch[1]!)} />
            : isAttention ? <AttentionInbox />
            : isNew ? <StartRun />
            : isSettings ? <Settings />
            : isGraphs ? <GraphsList />
            : buildMatch ? <GraphBuilder name={buildMatch.name} fromRun={fromRun ?? undefined} />
            : promptMatch ? <PromptsScreen selected={promptMatch[1] ? decodeURIComponent(promptMatch[1]) : null} />
            : proposalMatch ? <ProposalsScreen selected={proposalMatch[1] ? decodeURIComponent(proposalMatch[1]) : null} />
            : isGallery ? <Gallery />
            : isRuns ? <RunsList />
            : <NotFound path={path} onOpenPalette={() => setPaletteOpen(true)} />}
        </main>
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        <ShortcutSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
      </div>
    </ToastProvider>
  );
}

// guarded: component tests import screens directly into a DOM with no #root
const mount = document.getElementById("root");
if (mount) createRoot(mount).render(<App />);
