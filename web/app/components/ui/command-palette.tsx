/**
 * CommandPalette — ⌘K (HOW-68, DESIGN.md Keyboard).
 *
 * One box that reaches everything: type a few letters of what you want, Enter. It is fed by
 * the ONE registry (`lib/shortcuts.ts`) — every registered row that has something to run is a
 * command, and each shows its own shortcut, so the palette is also how a shortcut is learnt.
 * Nothing is listed here that is not registered there, and a screen that registers its
 * shortcuts gets its commands in the palette for free.
 *
 * WHY THE NATIVE `<dialog>`, as `Dialog` is (see its header): `showModal()` gives the focus
 * trap, the inert page behind, the top layer and Esc from the platform. Base UI has no
 * command-list primitive, and its Dialog would reimplement those four in userland to hold a
 * text field and a list. It is its own `<dialog>` rather than a `<Dialog>` because that
 * component is a titled confirmation card that animates in, and this must not:
 *
 * NO MOTION AT ALL. DESIGN.md Motion: "nothing keyboard-triggered animates … the palette".
 * It is opened dozens of times a day by a key; it is there on the same frame. The active row
 * is instant too — a highlight that eases trails one row behind the arrow key.
 *
 * The keyboard contract is the ARIA combobox-with-listbox one, with focus staying in the
 * field: Up/Down move the active option (wrapping), Home/End jump, Enter runs it, Esc closes
 * (the platform's `cancel`), and ⌘K again closes — the key that opened it. The pointer moves
 * the active row on `pointermove`, not `mouseenter`, so a list scrolling under a resting
 * cursor does not steal the selection from the keyboard.
 *
 * Filtering is deliberately plain: every word typed must appear somewhere in the command's
 * label, scope or keywords, and a label that STARTS with the query ranks first. No fuzzy
 * scoring — with a few dozen commands, "graphs" finding "Go to Graphs" every time is worth
 * more than "gg" sometimes finding it.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { LayerContainer, useReturnFocus } from "@/lib/layer";
import { groupByScope, primaryKeys, strokeOf, useRegisteredShortcuts, type Shortcut } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { Input } from "./input";
import { Kbd } from "./kbd";
import { SectionLabel } from "./section-label";

/** what the palette can run: a registered row with an action, not opted out */
export function paletteCommands(list: readonly Shortcut[]): Shortcut[] {
  return list.filter((sc) => sc.run !== undefined && !sc.passive && !sc.disabled && sc.palette !== false);
}

/** The filter, pure so it is testable without a DOM: all words must match; label-prefix first. */
export function filterCommands(list: readonly Shortcut[], query: string): Shortcut[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...list];
  const q = words.join(" ");
  return list
    .map((sc, i) => {
      const label = sc.label.toLowerCase();
      const hay = `${label} ${sc.scope.toLowerCase()} ${(sc.keywords ?? "").toLowerCase()}`;
      if (!words.every((w) => hay.includes(w))) return null;
      const rank = label.startsWith(q) ? 0 : label.split(/\s+/).some((w) => w.startsWith(words[0] ?? "")) ? 1 : label.includes(words[0] ?? "") ? 2 : 3;
      return { sc, rank, i };
    })
    .filter((x): x is { sc: Shortcut; rank: number; i: number } => x !== null)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.sc);
}

export function CommandPalette({ open, onClose, commands }: {
  open: boolean;
  onClose: () => void;
  /** defaults to everything registered in `lib/shortcuts.ts` */
  commands?: readonly Shortcut[];
}) {
  const registered = useRegisteredShortcuts();
  const all = useMemo(() => paletteCommands(commands ?? registered), [commands, registered]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDialogElement | null>(null);
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  // a STABLE ref callback: an inline one is a new function every render, so React would call
  // the old one with null and the new one with the element each time, and churn this state
  const attach = useCallback((el: HTMLDialogElement | null) => { ref.current = el; setLayer(el); }, []);
  const listId = useId();
  const optionId = (i: number) => `${listId}-o${i}`;

  const shown = useMemo(() => filterCommands(all, query), [all, query]);
  // with nothing typed the list is grouped by scope; a search is one ranked list
  const groups = useMemo(() => (query.trim() === "" ? groupByScope(shown) : [{ scope: "", items: shown }]), [shown, query]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const at = Math.min(active, Math.max(0, flat.length - 1));

  // focus goes back to where ⌘K was pressed from (lib/layer.ts) — declared before the effect
  // that opens the dialog, so it reads what had focus while it still has it
  useReturnFocus(open);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) { setQuery(""); setActive(0); el.showModal?.(); }
    else el.close?.();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(at))?.scrollIntoView?.({ block: "nearest" });
    // optionId is derived from listId, which is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, open, shown]);

  if (!open) return null;

  const run = (sc: Shortcut | undefined) => {
    if (!sc) return;
    onClose(); // first: a command may open another layer (the shortcut sheet)
    sc.run?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return;
    const n = flat.length;
    if (e.key === "ArrowDown") { e.preventDefault(); if (n) setActive((at + 1) % n); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (n) setActive((at - 1 + n) % n); }
    else if (e.key === "Home" && n) { e.preventDefault(); setActive(0); }
    else if (e.key === "End" && n) { e.preventDefault(); setActive(n - 1); }
    else if (e.key === "Enter") { e.preventDefault(); run(flat[at]); }
    else if (strokeOf(e.nativeEvent) === "mod+k") { e.preventDefault(); onClose(); }
  };

  let index = -1;
  return (
    <dialog
      ref={attach}
      data-slot="command-palette"
      aria-label="Command palette"
      className="m-0 mx-auto mt-[12dvh] w-[min(92vw,560px)] overflow-visible rounded-[var(--radius)] border border-[var(--border-strong)] bg-card p-0 text-foreground shadow-float backdrop:bg-[var(--scrim)]"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      onKeyDown={onKeyDown}
    >
      <LayerContainer.Provider value={layer}>
        <div className="relative border-b border-border">
          <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <Input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat.length ? optionId(at) : undefined}
            aria-label="Search commands"
            placeholder="Type a command…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            className="h-12 rounded-b-none border-0 bg-transparent pl-10 text-md focus-visible:-outline-offset-2"
          />
        </div>
        <div id={listId} role="listbox" aria-label="Commands" className="max-h-[min(52dvh,420px)] overflow-y-auto p-1.5">
          {flat.length === 0 && (
            <div role="presentation" className="px-3 py-6 text-center text-base text-muted-foreground">
              No command matches <span className="font-medium text-foreground">“{query.trim()}”</span>.
            </div>
          )}
          {groups.map((g) => (
            <div key={g.scope || "results"} role="group" aria-label={g.scope || "Results"}>
              {g.scope !== "" && <SectionLabel className="px-2.5 pb-0.5 pt-2">{g.scope}</SectionLabel>}
              {g.items.map((sc) => {
                const i = ++index;
                const keys = primaryKeys(sc);
                return (
                  <div
                    key={sc.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === at}
                    data-active={i === at || undefined}
                    className={cn(
                      "flex min-h-8 cursor-pointer select-none items-center gap-3 rounded-[var(--radius-sm)] px-2.5 text-base text-foreground",
                      i === at && "bg-accent",
                    )}
                    onPointerMove={() => { if (i !== at) setActive(i); }}
                    onClick={() => run(sc)}
                  >
                    <span className="min-w-0 flex-1">{sc.label}</span>
                    {query.trim() !== "" && <span className="shrink-0 text-xs text-faint">{sc.scope}</span>}
                    {keys !== undefined && <Kbd keys={keys} />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-4 border-t border-border px-3 py-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
          <span className="inline-flex items-center gap-1.5"><Kbd keys="enter" /> run</span>
          <span className="inline-flex items-center gap-1.5"><Kbd keys="escape" /> close</span>
        </div>
      </LayerContainer.Provider>
    </dialog>
  );
}
