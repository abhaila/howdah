/**
 * Kbd — prints a key (HOW-68, DESIGN.md "Keyboard first: every action has a key, printed
 * beside it").
 *
 * Two spellings, one look. `<Kbd keys="mod+k" />` takes the registry's own grammar
 * (`lib/shortcuts.ts`) and prints it for THIS platform — ⌘K on macOS, Ctrl K elsewhere — so a
 * hint beside a control can be fed the same string the shortcut was registered with and the
 * two cannot disagree. A sequence (`"g r"`) prints one cap per press, because "G then R" is
 * two presses and a single cap reading "GR" says chord. `<Kbd>Esc</Kbd>` prints its children
 * as given, for the keys that are not shortcuts (the palette's "↵ to run").
 *
 * It is a real `<kbd>`, so assistive tech and copy-paste get the semantics for free. Mono on
 * purpose: a key is something you match exactly, which is DESIGN.md's test for the mono face.
 * It never shrinks below the 12px floor, and it is `aria-hidden` when `decorative` — a hint
 * inside a button whose accessible name already says what the button does should not be read
 * as part of that name.
 */
import { formatKeys } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

const CAP =
  "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-[var(--radius-xs)] border border-[var(--border-strong)] bg-card px-1 font-mono text-xs leading-none text-muted-foreground";

export function Kbd({ keys, children, className, decorative = false }: {
  /** registry grammar: `"mod+k"`, `"g r"`, `"?"` */
  keys?: string;
  /** printed as given, when there is no registry string */
  children?: React.ReactNode;
  className?: string;
  /** hide from assistive tech: the control it sits in already names itself */
  decorative?: boolean;
}) {
  if (keys === undefined) {
    return <kbd data-slot="kbd" aria-hidden={decorative || undefined} className={cn(CAP, className)}>{children}</kbd>;
  }
  const caps = formatKeys(keys);
  if (caps.length === 1) {
    return <kbd data-slot="kbd" aria-hidden={decorative || undefined} className={cn(CAP, className)}>{caps[0]}</kbd>;
  }
  return (
    <span data-slot="kbd-sequence" aria-hidden={decorative || undefined} className={cn("inline-flex shrink-0 items-center gap-0.5", className)}>
      {caps.map((cap, i) => <kbd key={i} data-slot="kbd" className={CAP}>{cap}</kbd>)}
    </span>
  );
}
