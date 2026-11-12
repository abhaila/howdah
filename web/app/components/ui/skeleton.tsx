/**
 * Skeleton — shadcn/ui `skeleton` on Howdah's tokens (HOW-16 P1.4), plus the one composite
 * this app actually loads with (`LoadingBlock`). It replaces the ad-hoc `LoadingState`
 * card-with-a-spinner, which said "Loading" in a box the size of a sentence and then
 * reflowed the whole screen when the data landed.
 *
 * It does not pulse (HOW-68). DESIGN.md Motion: "no looping animation except a spinner on
 * something actually loading. No pulse." The header here used to say the pulse rode `--dur-*`
 * and so honoured reduced motion; it did not — `animate-pulse` is Tailwind's own fixed 2s
 * loop. A skeleton is the SHAPE of what is coming, and the shape is enough.
 */
import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("block rounded-[var(--radius-sm)] bg-muted", className)} />;
}

/** the shape every screen loads with: a heading bar and a few rows, announced once */
export function LoadingBlock({ label, rows = 4, className }: { label: string; rows?: number; className?: string }) {
  return (
    <div className={cn("flex max-w-[620px] flex-col gap-2 py-2", className)} role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-4 w-40" />
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-7 w-full" />)}
    </div>
  );
}
