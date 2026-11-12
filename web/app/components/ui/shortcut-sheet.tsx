/**
 * ShortcutSheet — `?` (HOW-68, DESIGN.md Keyboard: "`?` lists them all").
 *
 * A Dialog that prints the registry (`lib/shortcuts.ts`), grouped by scope. It holds no list
 * of its own, which is the point: the sheet a product ships by hand is wrong within a month,
 * because adding a shortcut and documenting it are two edits and only one of them breaks
 * anything when forgotten. Here there is one edit. A row that is registered appears; a screen
 * that is mounted contributes its rows; `passive` rows (Esc, a list's arrows) are printed
 * though something else handles them.
 *
 * It also carries the ONE setting the keyboard layer has — single-key shortcuts on or off
 * (WCAG 2.1.4: a shortcut made of a bare character key must be turn-off-able, because speech
 * input and a stray palm both type bare characters). It is here as well as in Settings
 * because this is where someone who has just fired one by accident will look. With it off
 * the sheet stays reachable through ⌘K → "Keyboard shortcuts".
 *
 * A Dialog, not a panel, deliberately: it is opened to be read and dismissed, it has nothing
 * to do with the screen under it, and Esc closing it must not also close that screen's drawer.
 */
import { groupByScope, isSingleKey, parseKeys, useRegisteredShortcuts, useSingleKeys, type Shortcut } from "@/lib/shortcuts";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { Dialog } from "./dialog";
import { Kbd } from "./kbd";
import { SectionLabel } from "./section-label";

const spellings = (sc: Shortcut): string[] => (sc.keys === undefined ? [] : typeof sc.keys === "string" ? [sc.keys] : [...sc.keys]);

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const all = useRegisteredShortcuts();
  const [single, setSingle] = useSingleKeys();
  const groups = groupByScope(all.filter((sc) => sc.keys !== undefined));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      className="w-[min(92vw,680px)]"
    >
      <div data-slot="shortcut-sheet" className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        {groups.map((g) => (
          <section key={g.scope} aria-label={g.scope} className="min-w-0">
            <SectionLabel as="h4" className="mb-1">{g.scope}</SectionLabel>
            <ul className="m-0 list-none p-0">
              {g.items.map((sc) => {
                const keys = spellings(sc);
                // a row a bare character key fires is inert while the setting is off — say so
                const off = !single && !sc.passive && keys.every((k) => parseKeys(k).every(isSingleKey));
                return (
                  <li key={sc.id} className="flex min-h-7 items-center gap-3 border-b border-border py-0.5 text-base last:border-b-0">
                    <span className={off ? "min-w-0 flex-1 text-faint" : "min-w-0 flex-1"}>
                      {sc.label}{off && <span className="sr-only"> (off)</span>}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1.5">
                      {keys.map((k, i) => (
                        <span key={k} className="inline-flex items-center gap-1.5">
                          {i > 0 && <span className="text-xs text-faint">or</span>}
                          <Kbd keys={k} />
                        </span>
                      ))}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <div className="border-t border-border pt-3">
        <div className="flex items-center gap-3">
          <Checkbox
            className="flex-1"
            checked={single}
            onChange={(e) => setSingle(e.target.checked)}
            label="Single-key shortcuts"
          />
          {/* takes the opening focus, so the sheet does not open with a ring on its one setting */}
          <Button variant="outline" size="sm" data-autofocus onClick={onClose}>Done</Button>
        </div>
        <p className="m-0 mt-1 text-sm text-muted-foreground">
          Keys that work without ⌘ or Ctrl, like <Kbd>C</Kbd> and <Kbd>G</Kbd> <Kbd>R</Kbd>. They never fire while you are typing. Turn them off if
          you use speech input; the command palette still reaches everything.
        </p>
      </div>
    </Dialog>
  );
}
