/**
 * ScrollPane — the one element in a pane that scrolls (HOW-68, DESIGN.md rule 2: "one
 * scroller per pane").
 *
 * The audit's worst finding was a layout one: at 1024×700 a parked run could not be answered,
 * because the column holding the composer was `overflow: hidden` and nothing inside it
 * scrolled. Every instance had the same cause — a flex column where the scrolling child
 * forgot `min-height: 0` (so it grew instead of scrolling) or where NO child scrolled and a
 * parent hid the overflow to keep the page tidy. DESIGN.md's contract is "a screen is a
 * column: header (fixed) → body (scrolls); exactly one element in each pane has
 * `overflow-y: auto`". This is that element, with the three properties that make it work
 * (`flex: 1`, `min-height: 0`, `overflow-y: auto`) in one place where they cannot be
 * half-remembered.
 *
 * Two things a bare `overflow: auto` div does not give:
 *
 *   KEYBOARD SCROLLING. A scroller with no focusable child cannot be scrolled without a mouse
 *   — a log, a document, a transcript of plain prose. So while (and only while) the content
 *   overflows, the pane is a focus stop with a name (`role="region"` + `label`), and the
 *   platform's own arrow/Page/Home/End scrolling does the rest. A pane that fits adds no tab
 *   stop and no landmark. Overflow is watched on the pane AND on its children, because
 *   content growing does not resize the scroller itself.
 *
 *   A VISIBLE FOCUS RING that is not clipped: the pane usually runs edge to edge, so its ring
 *   is drawn inside the box rather than 2px outside it where a neighbour would cover it.
 *
 * It is `position: relative` so that it CONTAINS what is absolutely positioned inside it. A
 * visually-hidden label (`sr-only`) far down a list is otherwise placed against the viewport,
 * outside every scroller, and stretches the page instead of the pane.
 *
 * The scrollbar is themed once, globally (tokens.css `scrollbar-color`); this adds nothing to
 * that. The horizontal axis is left to the platform (`overflow-x` computes to `auto` beside a
 * scrolling y): content wider than the pane gets a scrollbar rather than being cut, which is
 * the whole rule — every region either fits or scrolls.
 */
import { forwardRef, useCallback, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface ScrollPaneProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "role" | "tabIndex"> {
  /** what this pane holds, for assistive tech when it is a focus stop: "Transcript" */
  label: string;
}

export const ScrollPane = forwardRef<HTMLDivElement, ScrollPaneProps>(function ScrollPane(
  { label, className, children, ...rest },
  forwarded,
) {
  const own = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  const setRef = useCallback((el: HTMLDivElement | null) => {
    own.current = el;
    if (typeof forwarded === "function") forwarded(el);
    else if (forwarded) forwarded.current = el;
  }, [forwarded]);

  useLayoutEffect(() => {
    const el = own.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    const watch = () => {
      ro.disconnect();
      ro.observe(el);
      for (const child of Array.from(el.children)) ro.observe(child);
    };
    watch();
    // children come and go (a list loads, a row expands): re-point the observer at them
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => { watch(); measure(); });
    mo?.observe(el, { childList: true });
    return () => { ro.disconnect(); mo?.disconnect(); };
  }, []);

  return (
    <div
      ref={setRef}
      data-slot="scroll-pane"
      data-overflows={overflows || undefined}
      role={overflows ? "region" : undefined}
      aria-label={overflows ? label : undefined}
      tabIndex={overflows ? 0 : undefined}
      className={cn(
        "relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:-outline-offset-2",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
});
