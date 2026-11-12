/**
 * The 404 (HOW-68; the audit's 3.1.14: "No 404. An unknown path renders the Runs list").
 *
 * A mistyped or stale URL used to show the Runs list under an address that was not the Runs
 * list's — the page answered a question nobody asked and hid that anything was wrong. An
 * unknown path now says so: which path, that nothing lives there, and the two ways on. It is
 * the EmptyState primitive and nothing else (DESIGN.md: "empty states say what will appear
 * and how to make the first one").
 *
 * The path is printed in mono and WRAPS — it is the one thing on this screen the operator
 * might need to read exactly, and it is as long as whatever they pasted.
 */
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Kbd } from "@/components/ui/kbd";
import { useDocumentTitle } from "@/lib/page";
import { Mark } from "../brand";

/** a link that reads as the primary button: going to Runs is navigation, so it is an `<a>` */
const PRIMARY_LINK = buttonVariants({ variant: "default" });

export function NotFound({ path, onOpenPalette }: { path: string; onOpenPalette?: () => void }) {
  useDocumentTitle("Not found");
  return (
    <div className="runs" data-screen="not-found">
      <EmptyState
        mark={<Mark className="mark" />}
        as="h1"
        title="Nothing lives here"
        actions={
          <>
            <a className={PRIMARY_LINK} href="/">Go to Runs</a>
            {onOpenPalette && (
              <Button variant="outline" onClick={onOpenPalette}>Find a command <Kbd keys="mod+k" decorative /></Button>
            )}
          </>
        }
      >
        <p className="m-0 mx-auto max-w-[60ch]">
          There is no screen at <code className="[overflow-wrap:anywhere]">{path}</code>. The address may be mistyped, or it may be from
          an older version of Howdah.
        </p>
      </EmptyState>
    </div>
  );
}
