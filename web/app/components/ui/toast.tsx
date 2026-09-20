/**
 * Toast — ToastProvider + Toaster + useToast, hand-written (the shadcn registry's toast is
 * Radix; `sonner` is a dependency this app does not need for four call sites). HOW-16 P1.4.
 *
 * This is the transient surface the write actions never had. Before it, "did that work?"
 * was answered by a button label changing for 1.2 seconds, or by nothing at all — and a
 * label change is invisible to a screen reader and invisible to anyone not looking at that
 * exact button. The region is `aria-live="polite"`, so the outcome of a reply, a launch, a
 * pause/abort/resume, an accept/reject or a saved tuning is ANNOUNCED, not just coloured.
 *
 * What it deliberately is not: an error channel that replaces the inline one. A refusal that
 * explains why a round moved still belongs beside the control that was refused — a toast
 * that has faded cannot be re-read. Toasts second those messages; they never carry them
 * alone.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export type ToastTone = "default" | "error";
export interface Toast { id: number; text: string; tone: ToastTone }

interface ToastApi {
  /** show a toast; returns its id so a caller can dismiss it early */
  toast: (text: string, tone?: ToastTone) => number;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastApi | null>(null);

/** an error stays up long enough to read and copy; a confirmation gets out of the way */
const LIFETIME_MS: Record<ToastTone, number> = { default: 3200, error: 7000 };

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((text: string, tone: ToastTone = "default") => {
    const id = next.current++;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => dismiss(id), LIFETIME_MS[tone]);
    return id;
  }, [dismiss]);
  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </Ctx.Provider>
  );
}

/**
 * Outside a provider this is a no-op rather than a throw: the component tests render a
 * single screen with no app shell, and a missing toast must never be what breaks a render.
 */
const NOOP: ToastApi = { toast: () => 0, dismiss: () => {} };

export function useToast(): ToastApi {
  return useContext(Ctx) ?? NOOP;
}

export function Toaster({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(92vw,380px)] flex-col gap-2"
      role="status"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          data-tone={t.tone}
          className={cn(
            "pointer-events-auto flex items-start gap-2 rounded-[var(--radius)] border bg-card px-3 py-2 text-sm leading-snug shadow-[0_4px_16px_rgba(0,0,0,0.35)]",
            t.tone === "error" ? "border-destructive text-destructive" : "border-[var(--border-strong)] text-foreground",
          )}
        >
          <span className="min-w-0 flex-1 break-words">{t.text}</span>
          <Button variant="ghost" size="icon" className="size-5 shrink-0" aria-label="dismiss" onClick={() => onDismiss(t.id)}><X /></Button>
        </div>
      ))}
    </div>
  );
}
