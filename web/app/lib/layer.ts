/**
 * Where a floating layer is portalled to (HOW-68).
 *
 * Tooltip, Menu and Popover portal their popup to `document.body`. That is right everywhere
 * except inside a native `<dialog>` opened with `showModal()`: the dialog is in the browser's
 * TOP LAYER, which paints above every z-index, and it makes the rest of the document inert —
 * so a tooltip or a menu opened from inside a dialog was drawn underneath it and could not be
 * clicked. No z-index fixes that; the popup has to be a descendant of the dialog.
 *
 * So Dialog (and the command palette) provide their own element here, and the three floating
 * primitives pass it to Base UI's `Portal container`. Outside a dialog the context is null and
 * the portal goes to the body, exactly as before.
 */
import { createContext, useContext, useEffect, useRef } from "react";

export const LayerContainer = createContext<HTMLElement | null>(null);

/** the element floating layers should portal into, or undefined for the document body */
export function useLayerContainer(): HTMLElement | undefined {
  return useContext(LayerContainer) ?? undefined;
}

/**
 * Focus goes back where it came from when a modal layer closes (HOW-68, DESIGN.md Keyboard:
 * "focus returns to the trigger when a layer closes").
 *
 * `showModal()` remembers the element that had focus and `close()` restores it — but Dialog
 * and the command palette UNMOUNT when they close (`if (!open) return null`), so the element
 * is removed before the platform can do that, and focus fell to `<body>`: the next Tab started
 * again from the rail. Measured on the palette, the `?` sheet and every confirmation.
 *
 * What is remembered, at the moment of opening: the focused element, and the trigger of a menu
 * that is open right then — because a dialog opened from a menu ITEM ("Abort the run…") is
 * closing over an item that no longer exists, and the place to come back to is that menu's
 * button. Focus is only put back if it was actually lost (it is on `<body>`): a palette command
 * that moved focus itself ("Ask about this run") keeps it where the command put it.
 */
export function useReturnFocus(open: boolean): void {
  const from = useRef<HTMLElement[]>([]);
  const was = useRef(false);
  if (open && !was.current && typeof document !== "undefined") {
    const active = document.activeElement;
    const menuTrigger = document.querySelector<HTMLElement>('[data-slot="menu-trigger"][aria-expanded="true"]');
    from.current = [active instanceof HTMLElement && active !== document.body ? active : null, menuTrigger].filter((el): el is HTMLElement => el !== null);
  }
  was.current = open;
  useEffect(() => {
    if (!open) return;
    return () => {
      const candidates = from.current;
      // after the commit that removed the layer, and after anything its closing ran
      setTimeout(() => {
        const now = document.activeElement;
        if (now && now !== document.body && now.isConnected) return;
        candidates.find((el) => el.isConnected && !el.closest('[data-layer="menu"]'))?.focus();
      }, 0);
    };
  }, [open]);
}
