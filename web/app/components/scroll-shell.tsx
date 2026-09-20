/**
 * ScrollShell — an APP component, not a ui primitive (HOW-16 P1): it knows this app's
 * bottom-pinned-transcript behaviour, which no registry component does. Moved out of
 * main.tsx with `useBottomPinnedScroll`, which now lives in lib/hooks.ts.
 *
 * A live thread follows the bottom until the operator scrolls away, and then stops — the Top
 * and Bottom controls are what make "stops" recoverable.
 */
import { useBottomPinnedScroll } from "@/lib/hooks";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "./ui/button";

export function ScrollShell({ className = "", followKey, children }: {
  className?: string;
  followKey: unknown;
  children: React.ReactNode;
}) {
  const { ref, atTop, atBottom, measure, scrollToTop, scrollToBottom } = useBottomPinnedScroll(followKey);
  return (
    <div className={`scroll-shell ${className}`}>
      <div className="scroll-actions">
        <Button variant="outline" size="sm" disabled={atTop} onClick={scrollToTop}><ArrowUp />Top</Button>
        {!atBottom && <Button variant="outline" size="sm" onClick={scrollToBottom}><ArrowDown />Bottom</Button>}
      </div>
      <div className="scroll-viewport" ref={ref} onScroll={measure}>
        {children}
      </div>
    </div>
  );
}
