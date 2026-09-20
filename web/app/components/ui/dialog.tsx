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
 */
import { useCallback, useEffect, useId, useRef } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

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
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // happy-dom (and any browser predating <dialog>) has no showModal; the element still
    // renders, so a test sees the content and a human sees a non-modal panel — never nothing
    if (open) el.showModal?.();
    else el.close?.();
  }, [open]);

  const close = useCallback(() => onClose(), [onClose]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      role={alert ? "alertdialog" : "dialog"}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      className={cn(
        "m-auto w-[min(92vw,460px)] rounded-[var(--radius)] border border-[var(--border-strong)] bg-card p-0 text-foreground backdrop:bg-black/55",
        className,
      )}
      onCancel={(e) => { e.preventDefault(); close(); }}
      onClick={(e) => { if (e.target === ref.current) close(); }}
    >
      <div className="flex flex-col gap-3 p-4">
        <h3 id={titleId} className="m-0 text-md font-semibold">{title}</h3>
        {description && <div id={descId} className="text-sm leading-relaxed text-muted-foreground">{description}</div>}
        {children}
      </div>
    </dialog>
  );
}

/**
 * The destructive-confirmation shape, so no call site hand-rolls the button pair. Cancel
 * carries `autoFocus`: the default answer to "really?" is no.
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
        <Button variant="outline" size="sm" autoFocus disabled={busy} onClick={onClose}>{cancelLabel}</Button>
        <Button variant="destructive" size="sm" disabled={busy} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </Dialog>
  );
}
