/**
 * The two controls every resizable pane needs: the separator you drag, and the button that
 * opens and closes it. Geometry lives in `lib/panel.ts`; this file is only the surfaces.
 *
 * `PanelResizer` is a real `role="separator"` with `aria-valuenow`, focusable and operable by
 * arrows, so a pane is never mouse-only. When its panel is collapsed it drops out of the tab
 * order (`tabIndex -1`) rather than staying focusable with nothing to resize.
 *
 * Placement is the one thing these do NOT decide. The Steps panel learned this the hard way:
 * a control that positions itself against a zero-width lane resolves `left: 50%` to the lane's
 * edge and lands on top of its neighbour — the overlap howdah.css's lane comment describes.
 * So the resizer keeps a real width at all times and the toggle is static inside it.
 *
 * HOW-68: the toggle is a 24px target (`icon-sm`). It measured 14–17px, and it sat in a 9px
 * lane whose hover rule took the pointer across the middle of the button — a Playwright click
 * on its centre was refused with "pane-resize intercepts pointer events". The size is the
 * Button's now rather than a `width: 17px` override in howdah.css, and the lane's rule there
 * puts the toggle above the divider line. The separator also shows the focus ring it used to
 * suppress (`.pane-resize:focus-visible { outline: none }`): a focus stop with no ring is the
 * one thing DESIGN.md's Components section says every control must not be.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeft, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ScrollPane } from "@/components/ui/scroll-pane";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePanel, type Panel } from "@/lib/panel";
import { useEscapeLayer, useShortcuts } from "@/lib/shortcuts";

export function PanelResizer({
  panel,
  label,
  className,
  disabled,
  children,
}: {
  panel: Panel;
  /** what the separator resizes, for assistive tech: "the detail panel" */
  label: string;
  className?: string;
  /**
   * There is nothing to resize right now — a full-width or closed panel. The lane stays (it
   * carries the way back), but it stops being draggable AND leaves the tab order: a separator
   * you can focus and drag with nothing on the other side is a control that lies.
   */
  disabled?: boolean;
  children?: ReactNode;
}) {
  const inert = disabled || panel.collapsed;
  return (
    <div
      className={cn("pane-resize", className)}
      role="separator"
      aria-orientation="vertical"
      aria-label={`resize ${label}`}
      aria-valuenow={inert ? 0 : panel.width}
      aria-valuemin={panel.min}
      tabIndex={inert ? -1 : 0}
      onPointerDown={inert ? undefined : panel.onPointerDown}
      onDoubleClick={inert ? undefined : panel.onDoubleClick}
      onKeyDown={inert ? undefined : panel.onKeyDown}
    >
      {children}
    </div>
  );
}

/**
 * The open/close control. `aria-expanded` is what tells a screen reader the state, and the
 * icon carries the same fact visually — a chevron that only changes direction is a state
 * nobody can name, so the icon says which side and which way.
 */
export function PanelToggle({
  panel,
  label,
  side = "right",
  className,
}: {
  panel: Panel;
  /** the pane's name, used in both the tooltip and the accessible label */
  label: string;
  side?: "left" | "right";
  className?: string;
}) {
  const Icon = side === "left"
    ? (panel.collapsed ? PanelLeftOpen : PanelLeftClose)
    : (panel.collapsed ? PanelRightOpen : PanelRightClose);
  const verb = panel.collapsed ? "Show" : "Hide";
  return (
    <Tooltip content={`${verb} ${label}`}>
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn("pane-toggle", className)}
        aria-expanded={!panel.collapsed}
        aria-label={`${verb} ${label}`}
        onPointerDown={(e) => e.stopPropagation()} /* inside a resizer this is a click, never a drag */
        onClick={panel.toggle}
      >
        <Icon />
      </Button>
    </Tooltip>
  );
}

/**
 * SplitView — the ONE list + detail split (HOW-68, DESIGN.md Layout: "split views give each
 * side its own scroller and a minimum width; below 1100px the detail replaces the list instead
 * of squeezing it").
 *
 * Steps, Logs and Context each built this by hand around `usePanel`, and each got the same
 * three things wrong, which the audit measured: at 1024px the list was squeezed to 8px
 * (§3.1.4) because the detail kept its remembered width; the last column of a row slid under
 * the divider (§3.1.7) because the split hid its overflow instead of giving the list a floor;
 * and Escape did nothing, because a detail panel was not a layer anybody had registered.
 *
 * What it decides, so no pane has to:
 *
 *   WIDE: list · separator · detail. The separator is the keyboard-operable `PanelResizer`;
 *   the detail's width is the operator's and is CAPPED IN CSS as well as clamped on drag, so a
 *   width remembered from a wide window cannot starve the list in a narrower one.
 *   NARROW (the split's own width is under `narrowBelow`): ONE side at a time. The list shows
 *   first; opening a row replaces it with the detail under a Back control. Which side shows is
 *   not remembered — it is where you are, not a preference.
 *   ESC closes the detail in both shapes, through `useEscapeLayer`, so it takes its turn with
 *   menus, dialogs and the drawer rather than fighting them.
 *
 * The split does not know what a row is. A list tells it "the operator opened something"
 * through `useSplit().open()` — a click or Enter on a row — which is what re-opens a closed
 * panel and what swaps the sides when narrow. Outside a SplitView the hook is inert, so a list
 * renders on its own in a test or another screen unchanged.
 */
export interface SplitApi {
  /** show the detail: un-collapses it when wide, swaps to it when narrow */
  open: () => void;
  close: () => void;
  /** one side at a time */
  narrow: boolean;
  /** is the detail on screen right now */
  detailOpen: boolean;
}
const INERT_SPLIT: SplitApi = { open: () => {}, close: () => {}, narrow: false, detailOpen: true };
const SplitContext = createContext<SplitApi>(INERT_SPLIT);
export const useSplit = (): SplitApi => useContext(SplitContext);

export function SplitView({
  storageKey, list, detail, label, listLabel, className,
  min = 320, def = 420, minList = 360, narrowBelow = 1100, allowFull = false,
}: {
  /** localStorage prefix for the remembered width and open/closed state */
  storageKey: string;
  list: ReactNode;
  detail: ReactNode;
  /** what the detail is, for the separator, the toggle and assistive tech: "the step detail" */
  label: string;
  /** what Back returns to: "Steps" */
  listLabel: string;
  className?: string;
  min?: number;
  def?: number;
  /** the list's floor — the drag stops here, and so does the CSS cap */
  minList?: number;
  narrowBelow?: number;
  /** offer a full-width detail (the approval card outgrows any split) */
  allowFull?: boolean;
}) {
  const panel = usePanel({ key: storageKey, min, def, minOther: minList, side: "right" });
  const [full, setFull] = useState(false);
  const [width, setWidth] = useState(0);
  const [narrowOpen, setNarrowOpen] = useState(false);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);

  // the split's OWN width decides, not the window's: the Details drawer and the rail both take
  // room from it. An unmeasured box (0, or no ResizeObserver) is treated as wide.
  useLayoutEffect(() => {
    const box = panel.boxRef.current;
    if (!box) return;
    const measure = () => setWidth(box.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [panel.boxRef]);

  const narrow = width > 0 && width < narrowBelow;
  const state: "closed" | "full" | "split" = narrow ? (narrowOpen ? "full" : "closed") : panel.collapsed ? "closed" : full ? "full" : "split";
  const detailOpen = state !== "closed";

  const { setCollapsed } = panel;
  const open = useCallback(() => {
    if (narrow) setNarrowOpen(true);
    else setCollapsed(false);
  }, [narrow, setCollapsed]);
  const close = useCallback(() => {
    if (narrow) setNarrowOpen(false);
    else if (full) setFull(false);
    else setCollapsed(true);
  }, [narrow, full, setCollapsed]);
  const api = useMemo<SplitApi>(() => ({ open, close, narrow, detailOpen }), [open, close, narrow, detailOpen]);

  useEscapeLayer(close, { active: detailOpen, kind: "panel", ref: detailRef });

  // Narrow swaps the sides, so the element that had focus is gone: hand it to the control that
  // undoes the swap, and back to the row on the way out. Nothing moves when wide.
  const wasNarrowOpen = useRef(false);
  useEffect(() => {
    if (!narrow) { wasNarrowOpen.current = false; return; }
    if (narrowOpen && !wasNarrowOpen.current) backRef.current?.focus();
    if (!narrowOpen && wasNarrowOpen.current) listRef.current?.querySelector<HTMLElement>("[data-selected]")?.focus();
    wasNarrowOpen.current = narrowOpen;
  }, [narrow, narrowOpen]);

  return (
    <SplitContext.Provider value={api}>
      {/* --sd-w is the operator's remembered width — a custom property fed by data is the one
          inline style DESIGN.md keeps (HOW-16 P3.13) */}
      <div
        className={cn("split", className)}
        ref={panel.boxRef}
        data-slot="split-view"
        data-detail={state === "full" ? "full" : "split"}
        data-pane={state === "closed" ? "closed" : "open"}
        data-narrow={narrow || undefined}
        style={{ ["--sd-w" as string]: `${panel.width}px`, ["--split-list-min" as string]: `${minList}px` }}
      >
        {state !== "full" && <div className="split-list" ref={listRef}>{list}</div>}
        {!narrow && (
          <PanelResizer panel={panel} label={label} disabled={state === "full"}>
            <div className="pane-controls">
              <PanelToggle panel={panel} label={label} side="right" />
              {/* full width is a separate axis from open/closed, so it keeps its own control */}
              {allowFull && state !== "closed" && (
                <Tooltip content={full ? `Restore the ${listLabel.toLowerCase()} list` : "Full width"}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="pane-toggle"
                    data-control="full"
                    aria-pressed={full}
                    aria-label={full ? "restore the step list" : "expand the detail panel to full width"}
                    onPointerDown={(e) => e.stopPropagation()} /* the button is a click, never a drag */
                    onClick={() => setFull(!full)}
                  >
                    {full ? <Minimize2 /> : <Maximize2 />}
                  </Button>
                </Tooltip>
              )}
            </div>
          </PanelResizer>
        )}
        {state !== "closed" && (
          <div className="split-detail" ref={detailRef}>
            {narrow && (
              <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
                <Button ref={backRef} variant="ghost" size="sm" onClick={close}>
                  <ArrowLeft aria-hidden />Back to {listLabel}
                </Button>
                <Kbd keys="escape" decorative />
              </div>
            )}
            {detail}
          </div>
        )}
      </div>
    </SplitContext.Provider>
  );
}

/**
 * DetailPanel — "the detail panel is one component with a slot" (DESIGN.md). A fixed head
 * (what is selected), an optional fixed strip under it (sub-tabs), and ONE scroller for the
 * body. Steps, Logs and Context all put their detail in this, so the three read as one panel
 * showing three kinds of thing.
 */
export function DetailPanel({ label, head, strip, children, className, bodyClassName }: {
  /** what the scrolling body holds, for assistive tech: "Step detail" */
  label: string;
  head?: ReactNode;
  strip?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section data-slot="detail-panel" aria-label={label} className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      {head !== undefined && <div className={cn("shrink-0 px-4 pt-3", strip === undefined && "border-b border-border")}>{head}</div>}
      {strip !== undefined && <div className="shrink-0 border-b border-border px-4">{strip}</div>}
      <ScrollPane label={label} className={cn("px-4 py-3", bodyClassName)}>{children}</ScrollPane>
    </section>
  );
}

/**
 * Keyboard selection for a list (DESIGN.md Keyboard: "Lists — J K or arrows move · Enter
 * open"). J and K are registered through `useShortcuts`, so they are in the `?` sheet and work
 * wherever focus is on the pane; they select the neighbour AND move focus to its row, which is
 * what makes Enter open it — a row is a real button, so Enter is the platform's, not a global
 * binding that would steal Enter from every other button on the screen. The arrows are handled
 * on the list itself (spread `onKeyDown` on its container) for the same reason: registered
 * globally they would take the arrow keys away from every scroller and tab strip beside it.
 * Both are still LISTED, as passive rows. The list is ONE tab stop (a roving tabindex on the
 * selected row), which is what makes the arrows the way through it rather than a nicety.
 */
export function useListKeys<T extends string | number>({ ids, selected, onSelect, name }: {
  ids: readonly T[];
  selected: T | null;
  onSelect: (id: T) => void;
  /** what the rows are, for the shortcut sheet: "step" */
  name: string;
}): { ref: React.RefObject<HTMLDivElement | null>; onKeyDown: (e: React.KeyboardEvent) => void } {
  const ref = useRef<HTMLDivElement | null>(null);
  const focusNext = useRef(false);
  // a list may show one id twice (an approval visit that failed, then succeeded): walk the
  // distinct ids, or the move would stop on the repeat
  const unique = useMemo(() => [...new Set(ids)], [ids]);
  const move = useCallback((to: "next" | "prev" | "first" | "last") => {
    if (unique.length === 0) return;
    const at = selected === null ? -1 : unique.indexOf(selected);
    const i = to === "first" ? 0 : to === "last" ? unique.length - 1
      : to === "next" ? Math.min(unique.length - 1, at + 1) : Math.max(0, at === -1 ? 0 : at - 1);
    const next = unique[i];
    if (next === undefined) return;
    focusNext.current = true;
    if (next === selected) ref.current?.querySelector<HTMLElement>("[data-selected]")?.focus();
    else onSelect(next);
  }, [unique, selected, onSelect]);
  // ONE tab stop for the whole list — the selected row (the first, when the selection is not
  // on screen) — so Tab goes list → detail in one press instead of through 168 log rows. The
  // rows stay real buttons; the arrows and J/K are what move between them.
  useLayoutEffect(() => {
    const rows = Array.from(ref.current?.querySelectorAll<HTMLElement>("button, a[href]") ?? []);
    const stop = rows.find((r) => r.hasAttribute("data-selected")) ?? rows[0];
    for (const r of rows) r.tabIndex = r === stop ? 0 : -1;
  });
  // after the selection has rendered: the row that carries it takes focus (and scrolls into view)
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    ref.current?.querySelector<HTMLElement>("[data-selected]")?.focus();
  }, [selected]);
  useShortcuts([
    { id: "list.next", scope: "Lists", label: `Next ${name}`, keys: "j", palette: false, run: () => move("next") },
    { id: "list.prev", scope: "Lists", label: `Previous ${name}`, keys: "k", palette: false, run: () => move("prev") },
    { id: "list.arrows", scope: "Lists", label: "Move through the list, from a row", keys: ["arrowdown", "arrowup"], palette: false, passive: true },
    { id: "list.open", scope: "Lists", label: `Open the selected ${name}`, keys: "enter", palette: false, passive: true },
  ]);
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    // only from a ROW (a real button): put this on the rows' own container, not the filter bar
    if (!(e.target as HTMLElement).closest?.("button, a[href]")) return;
    const to = e.key === "ArrowDown" ? "next" : e.key === "ArrowUp" ? "prev" : e.key === "Home" ? "first" : e.key === "End" ? "last" : null;
    if (!to) return;
    e.preventDefault();
    move(to);
  }, [move]);
  return { ref, onKeyDown };
}
