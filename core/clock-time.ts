/**
 * "14:02" in local time — how a decision refusal names when the earlier decision landed
 * (engine/control.ts) and how the approval card names it in the UI (web/app/slice.tsx). One
 * implementation, because the card's "approved at 14:02" and the route's "already approved at
 * 14:02" must agree. Dependency-free on purpose: the browser bundle imports it directly, and
 * anything this file imported would ship to the browser with it.
 */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
