/**
 * The viewer's shared hooks, moved out of main.tsx (HOW-16 P1). Nothing here renders; the
 * surfaces that consume them are the shell and the run screens.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { observeAsks, type Observation } from "./attention-sound";

/**
 * Does a media query match, live. The shell's one use: below 1100px the rail collapses to
 * icons by itself (DESIGN.md Layout). It is state rather than a CSS `@media` rule so the
 * breakpoint and the operator's own toggle drive the SAME `data-nav` attribute — two
 * mechanisms were how the old rail had two different collapsed widths.
 */
export function useMediaQuery(query: string): boolean {
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [query]);
  return matches;
}

/** a ticking clock, so live durations count up without the read model refetching */
export function useNow(tickMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(t);
  }, [tickMs]);
  return now;
}

export function useBottomPinnedScroll(followKey: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setAtTop(el.scrollTop <= 8);
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight <= 16);
  }, []);
  const scrollToTop = useCallback(() => {
    ref.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (atBottom) el.scrollTop = el.scrollHeight;
    measure();
  }, [followKey, atBottom, measure]);
  return { ref, atTop, atBottom, measure, scrollToTop, scrollToBottom };
}

/**
 * needs-attention surfaces: the trunk-raise favicon, and the sound.
 *
 * The favicon follows `needsInput` directly. The sound does not: it is decided by
 * lib/attention-sound.ts from WHICH runs are waiting, so it plays for news and never for
 * navigation (HOW-68). Pass `null` while the screen has no data yet — "nothing loaded" is not
 * "nothing waiting", and treating it as such is what forgot every standing ask on each mount.
 */
export function useAttentionSurfaces(needsInput: boolean, observation: Observation | null = null) {
  useEffect(() => {
    const fav = document.getElementById("favicon") as HTMLLinkElement | null;
    let timer: ReturnType<typeof setInterval> | undefined;
    if (needsInput) {
      let frame = 0;
      const frames = ["/favicon-raise-1.svg", "/favicon-raise-2.svg"];
      timer = setInterval(() => { if (fav) fav.href = frames[(frame = (frame + 1) % 2)]!; }, 900);
    } else if (fav) fav.href = "/favicon.svg";
    return () => { if (timer) clearInterval(timer); if (fav) fav.href = "/favicon.svg"; };
  }, [needsInput]);
  const seen = observation === null ? null : JSON.stringify(observation);
  useEffect(() => {
    if (seen !== null) void observeAsks(JSON.parse(seen) as Observation);
  }, [seen]);
}

/**
 * A text box over a value the draft stores as MEANING rather than as keystrokes (HOW-22
 * review, finding 2).
 *
 * The graph builder's spec stores typed data on purpose: a number field's operand is `3`, not
 * `"3"`; an `is one of` row holds `["pass","warn"]`, not `"pass, warn"`. A box fed straight
 * back from that loses every intermediate keystroke the coercion trims — `3.` reads back as
 * `3`, so the next key gives `35`; `-` reads back as `0`, so a negative operand cannot be
 * typed at all; and a comma is swallowed the instant it is typed, which makes a second value
 * unreachable.
 *
 * `means(typed)` is what the draft WOULD hold for that text, rendered back as text. What was
 * typed stays on screen while it still means what the draft holds; the moment the draft says
 * something else — the field's kind flipped, the row moved, the value changed from another
 * control — the box follows the draft again. So this is not an uncontrolled input: it is
 * controlled by MEANING instead of by spelling.
 */
export function useTypedText(stored: string, means: (typed: string) => string): [string, (typed: string) => void] {
  const [typed, setTyped] = useState(stored);
  return [means(typed) === stored ? typed : stored, setTyped];
}
