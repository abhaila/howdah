/**
 * Howdah web app v0 (T11). Path routing: `/` runs list, `/run/:id` run view
 * (deep-linkable, `#needs-input` focuses the reply). Live via SSE. Served pre-bundled
 * as /app.js (bun build web/app/main.tsx — see web/server.ts startup).
 *
 * After HOW-16 this file is ONLY the shell: the nav, the path router, the ToastProvider
 * mount and createRoot. Every screen lives under `screens/`, the run's panes under `run/`,
 * the primitives under `components/ui/` and the helpers under `lib/` — main.tsx was 2,900
 * lines and held ten screens, nineteen inline styles and both styling systems at once.
 */
import "./globals.css";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState } from "react";
import { Rows3, Plus, Workflow, Settings as SettingsIcon, Library, FileDiff, BellRing, Sun, Moon, Monitor } from "lucide-react";
import type { ProposalView } from "../../prompts/proposals";
import type { InboxItem } from "../../engine/attention-inbox";
import { PROPOSALS_CHANGED } from "@/lib/types";
import { getJSON } from "@/lib/net";
import { Button } from "@/components/ui/button";
import { PanelToggle } from "@/components/ui/panel";
import { Tooltip } from "@/components/ui/tooltip";
import { ToastProvider } from "@/components/ui/toast";
import { usePanel } from "@/lib/panel";
import { Mark, Splash } from "./brand";
import { RunView } from "./run/view";
import { RunsList } from "./screens/runs";
import { StartRun } from "./screens/start-run";
import { GraphsList } from "./screens/graphs";
import { PromptsScreen } from "./screens/prompts";
import { ProposalsScreen } from "./screens/proposals";
import { Settings } from "./screens/settings";
import { AttentionInbox } from "./screens/attention";

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
    <Tooltip content={`Theme: ${current} — switch to ${next}`}>
      <Button variant="ghost" size="icon" aria-label={`Theme: ${current}. Switch to ${next}.`} onClick={() => onChange(next)}>
        <Icon size={15} />
      </Button>
    </Tooltip>
  );
}

function App() {
  const [path, setPath] = useState(location.pathname);
  // the nav collapses to an icon rail; width is fixed by its content, so only the state is ours
  const nav = usePanel({ key: "howdah.nav", min: 184, def: 184, minOther: 480, side: "left" });
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

  const [splashDone, setSplashDone] = useState<boolean>(() => sessionStorage.getItem("howdah-splash") === "1");
  const [theme, setTheme] = useState<string>(() => localStorage.getItem("howdah-theme") ?? "system");
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    localStorage.setItem("howdah-theme", theme);
  }, [theme]);

  const runMatch = path.match(/^\/run\/([^/]+)/);
  const promptMatch = path.match(/^\/prompts(?:\/(.+))?$/);
  const proposalMatch = path.match(/^\/proposals(?:\/(.+))?$/);
  const isNew = path === "/new";
  const isSettings = path === "/settings";
  const isGraphs = path === "/graphs";
  const isAttention = path === "/attention";
  const isRuns = !runMatch && !isNew && !isGraphs && !isSettings && !promptMatch && !proposalMatch && !isAttention;

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

  return (
    <ToastProvider>
      <div className="shell" data-nav={nav.collapsed ? "rail" : "full"}>
        {!splashDone && <Splash onDone={() => setSplashDone(true)} />}
        {/* Collapsing the nav is a preference, so it persists; the labels go and the icons
            stay, which is the same shape the 900px breakpoint already falls back to. */}
        <nav className="sidebar" aria-label="Primary">
          {/* the mark goes home like every other logo; it does NOT replay the splash —
              the boot jingle belongs to an actual load, not to navigating back to Runs */}
          <a className="mark-btn" href="/" aria-label="Howdah — runs"><Mark className="mark" /><span className="wordmark">Howdah</span></a>
          <a className={`nav ${isRuns ? "active" : ""}`} href="/"><Rows3 size={15} /><span className="label">Runs</span></a>
          <a className={`nav ${isAttention ? "active" : ""}`} href="/attention">
            <BellRing size={15} /><span className="label">Needs you</span>
            {waiting > 0 && <span className="nav-badge">{waiting}</span>}
          </a>
          <a className={`nav ${isNew ? "active" : ""}`} href="/new"><Plus size={15} /><span className="label">New run</span></a>
          <a className={`nav ${isGraphs ? "active" : ""}`} href="/graphs"><Workflow size={15} /><span className="label">Graphs</span></a>
          <a className={`nav ${promptMatch ? "active" : ""}`} href="/prompts"><Library size={15} /><span className="label">Prompts</span></a>
          <a className={`nav ${proposalMatch ? "active" : ""}`} href="/proposals">
            <FileDiff size={15} /><span className="label">Proposals</span>
            {pending > 0 && <span className="nav-badge">{pending}</span>}
          </a>
          <a className={`nav ${isSettings ? "active" : ""}`} href="/settings"><SettingsIcon size={15} /><span className="label">Settings</span></a>
          <div className="spacer" />
          <div className="nav-footer">
            <ThemeToggle theme={theme} onChange={setTheme} />
            <PanelToggle panel={nav} label="the sidebar" side="left" />
          </div>
        </nav>
        <main>
          {runMatch ? <RunView id={runMatch[1]!} />
            : isAttention ? <div className="runs"><AttentionInbox /></div>
            : isNew ? <StartRun />
            : isSettings ? <Settings />
            : isGraphs ? <GraphsList />
            : promptMatch ? <PromptsScreen selected={promptMatch[1] ? decodeURIComponent(promptMatch[1]) : null} />
            : proposalMatch ? <ProposalsScreen selected={proposalMatch[1] ? decodeURIComponent(proposalMatch[1]) : null} />
            : <div className="runs"><RunsList /></div>}
        </main>
      </div>
    </ToastProvider>
  );
}

// guarded: component tests import screens directly into a DOM with no #root
const mount = document.getElementById("root");
if (mount) createRoot(mount).render(<App />);
