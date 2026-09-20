/**
 * EmptyState — no shadcn registry entry; hand-written in the house pattern (HOW-16 P1.4).
 *
 * It replaces the bare `.empty` div that Logs, Context, the run list and every picker used.
 * An empty list and a list that has not loaded are different facts about the world, and the
 * old `.empty` was used for both — this one is only ever the first, and Skeleton is the
 * second.
 */
import { cn } from "@/lib/utils";

export function EmptyState({ children, className, mark }: {
  children: React.ReactNode;
  className?: string;
  /** the Howdah mark, for the one empty state that is the whole screen */
  mark?: React.ReactNode;
}) {
  return (
    <div className={cn("empty", className)}>
      {mark}
      <div>{children}</div>
    </div>
  );
}
