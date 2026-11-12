/**
 * Truncate — the ONLY way to ellipsize (HOW-68, DESIGN.md rule 5: "nothing is cut without a
 * way to read it").
 *
 * The audit counted the same defect in a dozen places: a span with `text-overflow: ellipsis`
 * and no way to read what it cut — timeline node names (455 hits), run names, inbox reasons,
 * workspace names cut to "acm…". The few that did have a `Tooltip` had it on a span that was
 * not focusable, so the value could be read by a mouse and by nobody else. The fix is not
 * thirty more tooltips; it is that an ellipsis cannot be written without one. Raw
 * `text-overflow: ellipsis` in the stylesheets is a test failure now
 * (`css-contract.test.ts`), and this component is where the property lives.
 *
 * What it does:
 *
 *   One line, cut with an ellipsis, and it KNOWS whether it is cut (a ResizeObserver compares
 *   scrollWidth to clientWidth). Only then does it grow a tooltip carrying the full value and
 *   a focus stop to reach it — text that fits is left as plain text, so a list of forty names
 *   that all fit adds no tab stops and no hover boxes.
 *
 *   Hover AND focus. When the text sits inside something that is already a focus stop (a link
 *   row, a button, a tab) it does not add a second stop inside it — nested focus stops are
 *   invalid inside a link and a nuisance everywhere — it shows the value while that ancestor
 *   has keyboard focus instead.
 *
 *   `middle` keeps the END of the value: an id or a path usually differs at its tail
 *   (`…headers-mhv3a7xw`, `…/src/api/gateway.ts`), which is exactly what a trailing ellipsis
 *   throws away. It is two spans — a head that shrinks and a tail that does not — so the full
 *   text is still in the DOM in order, and select-and-copy gets all of it.
 *
 * `className` lands on the OUTER element, the one that takes part in the parent's layout
 * (`flex-1`, a width, a colour — text styles inherit inward). The element is an inline-flex
 * box with `min-width: 0` and `max-width: 100%`, so it shrinks inside a flex row or a grid
 * cell without the parent needing `overflow: hidden`.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { Tooltip } from "./tooltip";
import { cn } from "@/lib/utils";

/** what already counts as a focus stop — Truncate rides its focus instead of adding one */
const INTERACTIVE = "a[href], button, [role='button'], [role='tab'], [role='option'], [role='menuitem'], [role='row'][tabindex], summary";

export function Truncate({ children, text, mono = false, middle = false, className }: {
  children: React.ReactNode;
  /** the full value, when `children` is not a plain string */
  text?: string;
  /** machine text: an id, a path, a branch (DESIGN.md Type) */
  mono?: boolean;
  /** keep this many characters of the END visible (`true` = 10). Needs string content. */
  middle?: boolean | number;
  className?: string;
}) {
  const full = text ?? (typeof children === "string" || typeof children === "number" ? String(children) : "");
  const clip = useRef<HTMLSpanElement | null>(null);
  const [cut, setCut] = useState(false);
  const [nested, setNested] = useState(false);
  const [ancestorFocused, setAncestorFocused] = useState(false);

  useLayoutEffect(() => {
    const el = clip.current;
    if (!el) return;
    const measure = () => setCut(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [full]);

  // inside a focus stop: show the value while THAT has keyboard focus, add no stop of our own
  useLayoutEffect(() => {
    const host = clip.current?.parentElement?.closest(INTERACTIVE) ?? null;
    setNested(host !== null);
    if (!host) return;
    const on = () => setAncestorFocused(typeof host.matches !== "function" || host.matches(":focus-visible"));
    const off = () => setAncestorFocused(false);
    host.addEventListener("focus", on);
    host.addEventListener("blur", off);
    return () => { host.removeEventListener("focus", on); host.removeEventListener("blur", off); };
  }, []);

  const tailLen = middle === true ? 10 : typeof middle === "number" ? middle : 0;
  const split = tailLen > 0 && typeof children === "string" && children.length > tailLen * 2;
  const stop = cut && !nested ? 0 : undefined;
  const FOCUS = "rounded-[2px] focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2";

  return (
    <Tooltip content={full} disabled={!cut} forceOpen={cut && ancestorFocused} className={className}>
      {split ? (
        <span data-slot="truncate" data-truncated={cut || undefined} tabIndex={stop} className={cn("inline-flex min-w-0 max-w-full", mono && "font-mono", FOCUS)}>
          <span ref={clip} className="min-w-0 truncate">{(children as string).slice(0, -tailLen)}</span>
          <span className="shrink-0 whitespace-pre">{(children as string).slice(-tailLen)}</span>
        </span>
      ) : (
        <span ref={clip} data-slot="truncate" data-truncated={cut || undefined} tabIndex={stop} className={cn("min-w-0 truncate", mono && "font-mono", FOCUS)}>
          {children}
        </span>
      )}
    </Tooltip>
  );
}
