/**
 * Keyboard submit for the app's composers.
 *
 * A multi-line composer had NO keyboard path at all — the reply that unparks a run could
 * only be sent by reaching for the mouse. This is the convention the rest of the world uses:
 * Enter sends, Shift+Enter breaks the line. Cmd/Ctrl+Enter sends too, because that is the
 * other muscle memory people arrive with and it costs nothing to honour.
 *
 * Two refusals matter more than the happy path:
 *
 *   IME composition. While composing Japanese, Chinese or Korean, Enter COMMITS the
 *   candidate — it is not a submit. Firing on it would send a half-typed message and eat the
 *   word. `isComposing` is the only reliable signal, and it lives on the native event.
 *
 *   Code. `submitOnEnter` is for composers only, never for an editor. The graph source
 *   editor (screens/graphs.tsx) is a TypeScript file in a textarea: Enter there is a newline
 *   and nothing else, so it deliberately does not use this.
 */
export interface SubmitOnEnterOpts {
  /** when false the keydown is ignored entirely — a composer that is mid-send or disabled */
  enabled?: boolean;
}

export function submitOnEnter(submit: () => void, opts: SubmitOnEnterOpts = {}) {
  return (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    if (opts.enabled === false) return;
    // mid-composition Enter belongs to the IME, not to us
    if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return;
    if (e.shiftKey) return; // the newline
    e.preventDefault();
    submit();
  };
}
