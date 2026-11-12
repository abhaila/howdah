/**
 * The frame every top-level screen sits in (HOW-68, DESIGN.md Layout: "a screen is a column:
 * header (fixed) → body (scrolls)").
 *
 * Eight screens each built their own page: a `.runs` div that was container, gutter AND
 * scroller at once, an `<h1>` inside the scrolling content (so the title scrolled away with
 * it), and a `max-width` that was 1480px for a list and 640px for a form by local decision.
 * This is the one frame, so the next screen cannot be laid out a ninth way:
 *
 *   HEADER — one row at every supported width: the title (16px/600), a one-line description
 *   only where it earns its place, and the actions on the right in a `Toolbar` (which never
 *   wraps; the title's side is what gives). ONE primary action per screen is the caller's
 *   promise; the frame only gives it its place.
 *   BODY — the screen's single scroller, a `ScrollPane`. Content is left-anchored with a 24px
 *   gutter and capped at 1200px for a list, 720px for a form or prose (DESIGN.md Type: a
 *   65–75ch measure).
 *   FOOT — an optional hint line (`KeyHints`) that stays put under the scroller.
 *
 * `SplitScreen` is the list + detail form of the same frame (Prompts, Proposals, Graphs):
 * each side is its own scroller with a minimum width, and below 1100px the detail REPLACES the
 * list — with a Back control and Esc — instead of both being squeezed (DESIGN.md Layout). The
 * breakpoint is state (`useMediaQuery`), not a CSS `@media` rule, because which pane is on
 * screen decides what Back and Esc do, and CSS cannot tell a component that.
 */
import { ArrowLeft, RotateCw } from "lucide-react";
import { useMediaQuery } from "@/lib/hooks";
import { useEscapeLayer } from "@/lib/shortcuts";
import { Kbd } from "@/components/ui/kbd";
import { ScrollPane } from "@/components/ui/scroll-pane";
import { SectionLabel } from "@/components/ui/section-label";
import { Skeleton } from "@/components/ui/skeleton";
import { Toolbar } from "@/components/ui/toolbar";
import { Truncate } from "@/components/ui/truncate";
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

/** DESIGN.md Layout: "below 1100px the detail replaces the list instead of squeezing it" */
export const SPLIT_NARROW = "(max-width: 1099px)";

const WIDTH = { list: "max-w-[1248px]", form: "max-w-[768px]", full: "" } as const;

export function ScreenHeader({ title, description, actions, lead }: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** a control before the title: the split screen's Back */
  lead?: React.ReactNode;
}) {
  return (
    <header data-slot="screen-header" // 48px with or without a 32px control in it: 7px of padding each side plus the hairline,
    // so a header that has a button is not 1px taller than one that has none (it was 49 vs 48)
    className="flex min-h-12 shrink-0 items-center gap-3 border-b border-border px-6 py-[7px]">
      {lead}
      <h1 className="m-0 flex min-w-0 shrink-0 text-lg font-semibold leading-6">{title}</h1>
      {description !== undefined && <p className="m-0 hidden min-w-0 flex-1 text-sm leading-5 text-muted-foreground min-[900px]:block">{description}</p>}
      {actions !== undefined && <Toolbar label={`${typeof title === "string" ? title : "Screen"} actions`} className="ml-auto gap-2">{actions}</Toolbar>}
    </header>
  );
}

export function Screen({ name, title, description, actions, footer, width = "list", children }: {
  /** `data-screen`, for the harness and the tests */
  name: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  /** `list` 1200px · `form` 720px · `full` the screen manages its own width */
  width?: keyof typeof WIDTH;
  children: React.ReactNode;
}) {
  return (
    <div data-screen={name} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ScreenHeader title={title} description={description} actions={actions} />
      <ScrollPane label={title}>
        <div className={cn("flex flex-col gap-5 px-6 pb-12 pt-5", WIDTH[width])}>{children}</div>
      </ScrollPane>
      {footer}
    </div>
  );
}

/** A loading screen in the shape of the screen: the real header, then bars where rows will be. */
export function ScreenLoading({ name, title, label, rows = 6 }: { name: string; title: string; label: string; rows?: number }) {
  return (
    <Screen name={name} title={title}>
      <div className="flex flex-col gap-2" role="status" aria-busy="true" aria-live="polite">
        <span className="sr-only">{label}</span>
        <Skeleton className="h-4 w-32" />
        {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)}
      </div>
    </Screen>
  );
}

/** The hint line at the foot of a list screen: which keys move, open and filter. */
export function KeyHints({ hints }: { hints: ReadonlyArray<{ keys: readonly string[]; label: string }> }) {
  return (
    <footer data-slot="key-hints" aria-label="Keyboard hints" className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-6 py-1.5 text-xs text-muted-foreground">
      {hints.map((h) => (
        <span key={h.label} className="inline-flex items-center gap-1.5">
          {h.keys.map((k) => <Kbd key={k} keys={k} />)}
          {h.label}
        </span>
      ))}
    </footer>
  );
}

export const LIST_HINTS = [
  { keys: ["j", "k"], label: "move" },
  { keys: ["enter"], label: "open" },
  { keys: ["mod+k"], label: "commands" },
  { keys: ["?"], label: "all shortcuts" },
] as const;

/** a link that wears the Back control's look; navigation, so it is an `<a>` */
const BACK = buttonVariants({ variant: "ghost", size: "sm" });

export function SplitScreen({ name, title, description, actions, footer, list, listLabel, detail, detailLabel, hasDetail, backHref, onBack, backLabel }: {
  name: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  list: React.ReactNode;
  listLabel: string;
  detail: React.ReactNode;
  detailLabel: string;
  /** something is selected: below 1100px the detail takes the screen and Back returns */
  hasDetail: boolean;
  /** where Back goes when the selection lives in the URL… */
  backHref?: string;
  /** …or what it does when it lives in state */
  onBack?: () => void;
  backLabel: string;
}) {
  const narrow = useMediaQuery(SPLIT_NARROW);
  const detailOnly = narrow && hasDetail;
  // Esc steps back out of the detail, like every other panel — only while it has replaced the list
  useEscapeLayer(() => { if (onBack) onBack(); else if (backHref !== undefined) document.querySelector<HTMLElement>("[data-slot='split-back']")?.click(); }, { active: detailOnly, kind: "panel" });
  const back = detailOnly ? (
    backHref !== undefined
      ? <a data-slot="split-back" className={cn(BACK, "-ml-2")} href={backHref}><ArrowLeft aria-hidden />{backLabel}</a>
      : <a data-slot="split-back" className={cn(BACK, "-ml-2")} href="#list" onClick={(e) => { e.preventDefault(); onBack?.(); }}><ArrowLeft aria-hidden />{backLabel}</a>
  ) : undefined;
  return (
    <div data-screen={name} data-split={detailOnly ? "detail" : narrow ? "list" : "both"} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* with the list gone, the header names what is on screen and Back names where it came from */}
      <ScreenHeader title={detailOnly ? <Truncate className="max-w-[40vw]">{detailLabel}</Truncate> : title} description={detailOnly ? undefined : description} actions={actions} lead={back} />
      <div className="flex min-h-0 min-w-0 flex-1">
        {!detailOnly && (
          <ScrollPane
            label={listLabel}
            data-pane="list"
            className={cn(narrow ? "flex-1" : "w-[320px] flex-none border-r border-border")}
          >
            <div className="flex flex-col px-3 py-3">{list}</div>
          </ScrollPane>
        )}
        {(!narrow || detailOnly) && (
          <ScrollPane label={detailLabel} data-pane="detail">
            <div className="flex max-w-[960px] flex-col gap-5 px-6 pb-12 pt-5">{detail}</div>
          </ScrollPane>
        )}
      </div>
      {footer}
    </div>
  );
}

// ---- the small pieces every form and detail on these screens shares ------------------------

/** inline code in a sentence: a command, a path, an env var */
export const CODE = "rounded-[var(--radius-xs)] bg-muted px-1 py-px font-mono text-code text-foreground";

/** A titled group: a `SectionLabel` heading over its content (DESIGN.md Type: 12px/600, never uppercase). */
export function Section({ title, count, description, children, className }: {
  title: string;
  count?: number | string;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={title} data-section={title} className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-col gap-1 border-b border-border pb-1.5">
        <SectionLabel as="h2" count={count}>{title}</SectionLabel>
        {description !== undefined && <Hint>{description}</Hint>}
      </div>
      {children}
    </section>
  );
}

/** the quiet sentence under a field or a heading */
export function Hint({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p data-slot="hint" className={cn("m-0 text-sm font-normal leading-5 text-muted-foreground", className)}>{children}</p>;
}

/** what went wrong, in words, where it went wrong. `pre` keeps a tool's own line breaks. */
export function FieldError({ children, pre = false, className }: { children: React.ReactNode; pre?: boolean; className?: string }) {
  return <p role="alert" data-slot="field-error" className={cn("m-0 text-sm font-normal leading-5 text-destructive [overflow-wrap:anywhere]", pre && "whitespace-pre-wrap", className)}>{children}</p>;
}

/**
 * A read that failed is not an empty list and not a list that is still loading: it says so,
 * and offers the one thing that helps. (A failed read used to leave a skeleton up for ever, or
 * — worse — render "nothing here yet" over a server that had not answered.)
 */
export function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <EmptyState title={`Could not load ${what}`} actions={<Button variant="outline" onClick={onRetry}><RotateCw />Try again</Button>}>
      <span role="alert">The viewer's server did not answer. Check the terminal running <code>bun run web</code>, then try again.</span>
    </EmptyState>
  );
}
