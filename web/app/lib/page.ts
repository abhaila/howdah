/**
 * Where focus goes when the screen changes, what the tab is called, and where focus goes when
 * the thing that held it is answered away (HOW-68 D20).
 *
 * This is a client-side router: a navigation replaces the screen without the browser's own
 * page-load behaviour, so focus stayed on a link that no longer existed (or fell to `<body>`)
 * and every tab was titled "Howdah". Three small rules, each of which the platform would have
 * given a multi-page app for free:
 *
 *   TITLE — `useDocumentTitle("Runs")` → "Runs · Howdah". Called by the screen frame, the run
 *   view and the builder, never by the shell: a child's effect runs before its parent's, so a
 *   shell-level title would overwrite the run's own name on the same commit.
 *
 *   ROUTE FOCUS — when the SCREEN changes (not a selection inside one: `/prompts/a` → `/prompts/b`
 *   is the same screen, and moving focus off the list on every j/k would be a bug), focus moves
 *   to the new screen's `<h1>`, which is given `tabIndex=-1`. A screen that is still loading has
 *   no heading yet, so `#main` takes focus first and the heading takes it when it arrives —
 *   unless the operator has focused something themselves by then. A deep link with a hash
 *   (`#needs-input`) is left alone: the ask card takes that focus itself.
 *   The ring follows `:focus-visible` and nothing else — a keyboard navigation (`g r`) shows it
 *   on the heading, a mouse click on a rail link does not. Nothing here forces or suppresses it.
 *
 *   AFTER AN ASK — `focusRunStatus()` puts focus on the run header's status line
 *   (`#run-status`), which is where the run now says what it is doing.
 */
import { useEffect, useRef } from "react";

export const APP_NAME = "Howdah";
export const pageTitle = (title: string | null | undefined): string => (title && title.trim() ? `${title.trim()} · ${APP_NAME}` : APP_NAME);

/** `undefined` leaves the title alone — for a wrapper whose child names the page (RunView → RunFrame) */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (title !== undefined) document.title = pageTitle(title);
  }, [title]);
}

/**
 * Which screen a path is. Two paths with the same key are the same screen with a different
 * selection, and focus is left where the operator put it.
 */
export function screenKey(path: string): string {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const run = p.match(/^\/run\/([^/]+)/);
  if (run) return `run:${run[1]}`;
  const draft = p.match(/^\/runs\/([^/]+)\/draft$/);
  if (draft) return `draft:${draft[1]}`;
  const build = p.match(/^\/graphs\/([^/]+)\/build$/);
  if (build) return `build:${build[1]}`;
  if (p === "/graphs/new") return "build:";
  for (const s of ["prompts", "proposals", "graphs", "attention", "new", "settings"]) if (p === `/${s}` || p.startsWith(`/${s}/`)) return s;
  return p === "/" ? "runs" : `other:${p}`;
}

/** how long a screen is given to settle (its loading frame, then itself) before the watch ends */
const HEADING_WAIT_MS = 4000;

function focusQuietly(el: HTMLElement): void {
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

/**
 * Move focus to the screen's heading, and KEEP it there while the screen settles. Returns a
 * cleanup.
 *
 * A screen arrives in two renders: a loading frame (which may or may not have a heading), then
 * the screen itself — a different component, so React replaces the heading that was just
 * focused and focus falls to `<body>` a moment after it was placed. So for a short window this
 * watches `main`: whenever focus is nowhere real (on `main`, on `<body>`, on a node that has
 * been removed) and there is a heading, the heading takes it. The first time the operator
 * focuses anything else, the watch ends — their focus is never taken back.
 */
export function focusScreenHeading(main: HTMLElement): () => void {
  let placed: HTMLElement | null = null;
  const nowhere = () => {
    const a = document.activeElement as HTMLElement | null;
    return !a || a === document.body || a === main || !a.isConnected;
  };
  const place = () => {
    const h = main.querySelector<HTMLElement>("h1");
    if (h) { if (h !== document.activeElement) focusQuietly(h); placed = h; }
    else if (document.activeElement !== main) { focusQuietly(main); placed = main; }
  };
  place();
  if (typeof MutationObserver === "undefined") return () => {};
  const obs = new MutationObserver(() => { if (nowhere()) place(); });
  // focus that goes anywhere we did not put it is the operator's: stop watching
  const onFocus = (e: FocusEvent) => { if (e.target !== placed && e.target !== main && (e.target as HTMLElement | null)?.tagName !== "H1") done(); };
  const done = () => { obs.disconnect(); clearTimeout(timer); document.removeEventListener("focusin", onFocus); };
  obs.observe(main, { childList: true, subtree: true });
  document.addEventListener("focusin", onFocus);
  const timer = setTimeout(done, HEADING_WAIT_MS);
  return done;
}

/** The shell's hook: on a change of SCREEN (never on first load), focus the new heading. */
export function useRouteFocus(path: string): void {
  const last = useRef<string | null>(null);
  useEffect(() => {
    const key = screenKey(path);
    const was = last.current;
    last.current = key;
    if (was === null || was === key) return; // first paint keeps the browser's own focus
    if (location.hash) return; // a deep link's target takes focus itself
    const main = document.getElementById("main");
    if (!main) return;
    return focusScreenHeading(main);
  }, [path]);
}

/**
 * Focus `target`, but only if focus is nowhere real — on `<body>`, or on an element that has
 * just been removed (the button that was pressed, the field that was submitted). The general
 * form of the rule below, for a screen whose action removes its own control.
 */
export function focusIfLost(target: HTMLElement | null | undefined): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (a && a !== document.body && a.isConnected) return false;
  if (!target) return false;
  focusQuietly(target);
  return document.activeElement === target;
}

/**
 * Focus an element that may not be focusable YET. The Build transcript hides its viewport
 * (`visibility: hidden`) until its first scroll position is set, and `focus()` on a hidden
 * element does nothing and says nothing — which is how a notification's deep link came to open
 * the run with focus on `<body>` in every real browser while the test DOM, which has no layout,
 * passed. Tries now, then once a frame until it holds or `ms` runs out; stops the moment the
 * operator focuses something else. Returns a cancel.
 */
export function focusWhenVisible(get: () => HTMLElement | null | undefined, ms = 2000): () => void {
  let stopped = false;
  const until = Date.now() + ms;
  const attempt = () => {
    if (stopped) return;
    const el = get();
    const a = document.activeElement;
    if (el && a === el) return; // it held
    if (a && a !== document.body && a.isConnected && tried) return; // the operator went elsewhere
    if (el) { tried = true; el.focus({ preventScroll: false }); if (document.activeElement === el) return; }
    if (Date.now() < until) schedule(attempt);
  };
  let tried = false;
  const schedule = (fn: () => void) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : setTimeout(fn, 16));
  attempt();
  return () => { stopped = true; };
}

export const RUN_STATUS_ID = "run-status";

/**
 * After an ask is answered and its card is gone: focus the run's status line, unless the
 * operator has already put focus somewhere real. Returns whether focus was moved.
 */
export function focusRunStatus(): boolean {
  const active = document.activeElement as HTMLElement | null;
  const lost = !active || active === document.body || !active.isConnected || active.closest("#needs-input") !== null;
  if (!lost) return false;
  const target = document.getElementById(RUN_STATUS_ID);
  if (!target) return false;
  // the parked header draws a button inside the status line; once answered it is a badge
  focusQuietly(target);
  return document.activeElement === target;
}
