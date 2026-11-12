/**
 * The mark, out of main.tsx (HOW-16 P1) so the shell is only the shell. It used to share this
 * file with a load splash — the mark drawing itself for two seconds over the app, once per
 * session. HOW-68 removed it (DESIGN.md Motion: "no splash"): the operator opens the viewer to
 * answer something, and the first thing it did was stand between them and the answer.
 *
 * The eye's `#cfac3f` is the ONE hardcoded colour left in the TypeScript layer and it is
 * deliberate: it is a BRAND value, not a theme value. Every token in tokens.css flips
 * between dark and light; the mark's eye must not — it is the same gold on a business card,
 * a favicon and a README, and a mark that changes colour with the OS is not a mark. The
 * css-contract test allows a hex only on a line that says why, which is this comment.
 */
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
