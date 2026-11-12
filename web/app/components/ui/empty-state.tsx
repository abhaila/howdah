/**
 * EmptyState — no shadcn registry entry; hand-written in the house pattern (HOW-16 P1.4).
 *
 * It replaces the bare `.empty` div that Logs, Context, the run list and every picker used.
 * An empty list and a list that has not loaded are different facts about the world, and the
 * old `.empty` was used for both — this one is only ever the first, and Skeleton is the
 * second.
 *
 * HOW-68: DESIGN.md asks an empty state to "say what will appear and how to make the first
 * one", so it can carry a `title` (what this place is) and `actions` (the way forward) as
 * well as its sentence. The 404 screen is this component and nothing else.
 */
import { cn } from "@/lib/utils";

export function EmptyState({ children, className, mark, title, actions }: {
  children: React.ReactNode;
  className?: string;
  /** the Howdah mark, for the one empty state that is the whole screen */
  mark?: React.ReactNode;
  /** what this place is, as a heading */
  title?: React.ReactNode;
  /** the way forward: a link or a button or two */
  actions?: React.ReactNode;
}) {
  return (
    <div className={cn("empty", className)}>
      {mark}
      {title !== undefined && <h1 className="m-0 mb-1 text-lg font-semibold text-foreground">{title}</h1>}
      <div>{children}</div>
      {actions !== undefined && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
    </div>
  );
}
