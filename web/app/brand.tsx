/**
 * The mark and the load splash, out of main.tsx (HOW-16 P1) so the shell is only the shell.
 *
 * The eye's `#cfac3f` is the ONE hardcoded colour left in the TypeScript layer and it is
 * deliberate: it is a BRAND value, not a theme value. Every token in tokens.css flips
 * between dark and light; the mark's eye must not — it is the same gold on a business card,
 * a favicon and a README, and a mark that changes colour with the OS is not a mark. The
 * css-contract test allows a hex only on a line that says why, which is this comment.
 */
import { useEffect, useState } from "react";

/** the mark's eye — a brand colour, deliberately NOT a token (see the file header) */
const EYE = "#cfac3f";
const MARK_PATH =
  "M 52 46 C 57 38 57 24 48 18 L 41 18 L 41 11 L 28 11 L 28 18 L 22 18 C 13 20 9 27 9 33 C 9 41 7 47 11 53 C 13 56 18 56 19 52";

export function Mark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" aria-label="Howdah">
      <path d={MARK_PATH} stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="21" cy="30" r="3" fill={EYE} />
    </svg>
  );
}

/**
 * The load splash: the mark draws itself, once per browser session.
 * Delight is rare-frequency only — sessionStorage gates repeats, and the app loads
 * underneath, so the splash never delays data. Reduced motion gets a plain fade.
 */
export function Splash({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    // silent on purpose: the load used to play a jingle, removed at the operator's request
    const hold = setTimeout(() => setLeaving(true), 1900);
    const gone = setTimeout(() => { sessionStorage.setItem("howdah-splash", "1"); onDone(); }, 2350);
    return () => { clearTimeout(hold); clearTimeout(gone); };
  }, [onDone]);
  return (
    <div className={`splash ${leaving ? "leaving" : ""}`}>
      <svg viewBox="0 0 64 64" fill="none" className="splash-mark" aria-label="Howdah">
        <path className="splash-stroke" pathLength={100} d={MARK_PATH}
          stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
        {/* brand gold, as above — the splash draws the same mark */}
        <circle className="splash-eye" cx="21" cy="30" r="3" fill={EYE} />
      </svg>
      <div className="splash-word">Howdah</div>
    </div>
  );
}
