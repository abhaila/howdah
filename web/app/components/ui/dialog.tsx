/**
 * Dialog + AlertDialog — built on the NATIVE `<dialog>` element (HOW-16 P1.4).
 *
 * Provenance: the shadcn registry's dialog/alert-dialog are @radix-ui/react-dialog, which
 * this project does not take. `showModal()` gives the same four things Radix is usually
 * imported for — the focus trap, the inert background, `::backdrop`, and Esc to close — from
 * the platform, in 40 lines. What it does NOT give is a backdrop click, so that is wired
 * here (a click whose target is the dialog element itself landed outside its content box).
 *
 * This is the confirmation surface the destructive actions never had: abort a run, remove a
 * workspace, reject a proposal. `window.confirm` stays out of this app, deliberately — it
 * cannot be styled, cannot say WHAT is about to happen in the app's own voice, and blocks
 * the whole tab. AlertDialog is the role-correct variant for a destructive choice
 * (`role="alertdialog"`, the cancel focused first, so Enter is never the destructive one).
 *
 * HOW-27 MOVED THE PRIMITIVE LAYER ONTO base-vega AND DELIBERATELY LEFT THIS BEHIND, for the
 * reason the paragraph above already gives. `@base-ui/react` is a dependency now, so "no Radix"
 * is no longer the argument; the argument is that `showModal()` gets the focus trap, the inert
 * background, `::backdrop` and Esc from the PLATFORM, in the top layer, with no portal, no
 * scroll-lock and no z-index. base-vega's dialog reimplements all of that in userland. This is
 * one of the few places where the hand-written version is not the compromise — it is the better
 * one, and moving it would be a regression bought with a larger file.
 *
 * HOW-68 (DESIGN.md Motion + Chrome):
 *
 *   IT ARRIVES, ONCE. 180ms of opacity plus 6px of rise on the strong ease-out, written as
 *   `@starting-style` (Tailwind's `starting:`) so it is a TRANSITION — interruptible, and no
 *   keyframe to restart. Never from `scale(0)`, never `ease-in`. It does not animate out: the
 *   operator has already decided, and the element is unmounted. Reduced motion zeroes the
 *   duration tokens, so nothing moves.
 *   THE SCRIM IS A TOKEN (`--scrim`), not `black/55` — the old one was the same in both
 *   themes, which is how a light page got a dark-theme shadow over it.
 *   IT FLOATS, so it casts the one shadow floating things cast (`shadow-float`).
 *   IT IS A LAYER CONTAINER. A `showModal()` dialog is in the top layer and makes the rest of
 *   the document inert, so a Tooltip, Menu or Popover opened from inside it and portalled to
 *   `<body>` was painted underneath and could not be clicked. The dialog offers its own
 *   element through `LayerContainer` and those three portal into it.
 *   A TALL BODY SCROLLS INSIDE IT (`max-h` + one scroller) instead of running off the screen.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { LayerContainer, useReturnFocus } from "@/lib/layer";
import { cn } from "@/lib/utils";
import { Button } from "./button";

/**
 * How the operator last acted: a key, or the pointer. DESIGN.md Motion — "nothing
 * keyboard-triggered animates" — is a rule about the INPUT, and a dialog cannot tell from its
 * props whether `?`, Enter on a focused button or a click opened it. So the two listeners
 * below remember, and a dialog opened from the keyboard is simply there (the shortcut sheet
 * on `?`, a confirmation reached by Tab and Enter), while one opened with the pointer keeps
 * the 180ms entrance. Capture phase, so it is recorded before the handler that opens anything.
 */
let lastInput: "key" | "pointer" = "pointer";
if (typeof document !== "undefined") {
  document.addEventListener("keydown", () => { lastInput = "key"; }, true);
  document.addEventListener("pointerdown", () => { lastInput = "pointer"; }, true);
}
/** exported for the tests */
export const openedByKeyboard = (): boolean => lastInput === "key";

export function Dialog({ open, onClose, title, description, children, alert = false, className }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** `alertdialog`: an interruption a human must answer, not a place to browse */
  alert?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  // state as well as a ref: the floating layers inside need a RENDER when the element exists
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  // a STABLE ref callback: an inline one is a new function every render, so React would call
  // the old one with null and the new one with the element each time, and churn this state
  const attach = useCallback((el: HTMLDialogElement | null) => { ref.current = el; setLayer(el); }, []);
  const titleId = useId();
  const descId = useId();
  // before the effect that calls showModal(): what had focus is read while it still has it
  useReturnFocus(open);
  // decided once per opening, at the moment it opens
  const [instant, setInstant] = useState(false);
  const wasOpen = useRef(false);
  if (open !== wasOpen.current) {
    wasOpen.current = open;
    if (open) { const now = openedByKeyboard(); if (now !== instant) setInstant(now); }
  }

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // happy-dom (and any browser predating <dialog>) has no showModal; the element still
    // renders, so a test sees the content and a human sees a non-modal panel — never nothing
    if (open) {
      el.showModal?.();
      // showModal() focuses the FIRST focusable thing inside, and React's `autoFocus` cannot
      // overrule it: React focuses at mount, while the dialog is still closed and nothing in
      // it can take focus. So the control a dialog wants focused says so with
      // `data-autofocus`, and is focused here, after the platform has made its own choice —
      // or the shortcut sheet opens with its ring on a setting, one Space from switching it off.
      el.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    } else el.close?.();
  }, [open]);

  const close = useCallback(() => onClose(), [onClose]);

  if (!open) return null;
  return (
    <dialog
      ref={attach}
      role={alert ? "alertdialog" : "dialog"}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      className={cn(
        "m-auto max-h-[min(86dvh,720px)] w-[min(92vw,460px)] overflow-visible rounded-[var(--radius)] border border-[var(--border-strong)] bg-card p-0 text-foreground shadow-float backdrop:bg-[var(--scrim)]",
        !instant && "transition-[opacity,translate] duration-[var(--dur-base)] ease-[var(--ease-out-strong)] starting:translate-y-1.5 starting:opacity-0",
        className,
      )}
      data-instant={instant || undefined}
      onCancel={(e) => { e.preventDefault(); close(); }}
      onClick={(e) => { if (e.target === ref.current) close(); }}
    >
      <LayerContainer.Provider value={layer}>
        <div className="flex max-h-[min(86dvh,720px)] flex-col gap-3 overflow-y-auto p-4">
          <h3 id={titleId} className="m-0 text-md font-semibold">{title}</h3>
          {description && <div id={descId} className="text-sm leading-relaxed text-muted-foreground">{description}</div>}
          {children}
        </div>
      </LayerContainer.Provider>
    </dialog>
  );
}

/**
 * The destructive-confirmation shape, so no call site hand-rolls the button pair. Cancel
 * carries `data-autofocus`: the default answer to "really?" is no.
 */
export function AlertDialog({ open, onClose, onConfirm, title, description, confirmLabel, cancelLabel = "Cancel", busy = false }: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
}) {
  return (
    <Dialog alert open={open} onClose={onClose} title={title} description={description}>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" data-autofocus disabled={busy} onClick={onClose}>{cancelLabel}</Button>
        <Button variant="destructive" size="sm" disabled={busy} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </Dialog>
  );
}
