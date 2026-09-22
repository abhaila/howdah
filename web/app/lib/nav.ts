/**
 * Going somewhere from code rather than from a click (HOW-22).
 *
 * main.tsx's router keeps `path` in state and updates it two ways: it intercepts clicks on
 * `a[href^='/']`, and it listens for `popstate`. A link is still the right answer wherever
 * there is something to click — it keeps middle-click and copy-link — but the builder has
 * two moves that happen without one: saving a NEW graph has to swap /graphs/new for
 * /graphs/:name/build so a reload re-opens what was saved, and a button is the honest
 * control where the act is "save", not "go".
 *
 * `pushState` alone does not fire `popstate` (only real history navigation does), so this
 * dispatches one. That is the whole function, and it lives here so the two call sites cannot
 * drift into doing it half a way each.
 */
export function navigate(path: string): void {
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
