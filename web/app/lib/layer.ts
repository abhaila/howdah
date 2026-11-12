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
import { createContext, useContext } from "react";

export const LayerContainer = createContext<HTMLElement | null>(null);

/** the element floating layers should portal into, or undefined for the document body */
export function useLayerContainer(): HTMLElement | undefined {
  return useContext(LayerContainer) ?? undefined;
}
