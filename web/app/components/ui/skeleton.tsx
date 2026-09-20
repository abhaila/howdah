/**
 * Skeleton — shadcn/ui `skeleton` on Howdah's tokens (HOW-16 P1.4), plus the one composite
 * this app actually loads with (`LoadingBlock`). It replaces the ad-hoc `LoadingState`
 * card-with-a-spinner, which said "Loading" in a box the size of a sentence and then
 * reflowed the whole screen when the data landed.
 *
 * The pulse rides `--dur-*`, which tokens.css already zeroes under
 * `prefers-reduced-motion: reduce` — so honouring reduced motion is not a second rule here.
 */
import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("block animate-pulse rounded-[var(--radius-sm)] bg-muted", className)} />;
}

/** the shape every screen loads with: a heading bar and a few rows, announced once */
export function LoadingBlock({ label, rows = 4, className }: { label: string; rows?: number; className?: string }) {
  return (
    <div className={cn("flex max-w-[620px] flex-col gap-2 py-2", className)} role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-4 w-40" />
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-[26px] w-full" />)}
    </div>
  );
}
