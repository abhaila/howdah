/**
 * `cn` — the class merge every vendored shadcn component calls (clsx for conditionals,
 * tailwind-merge so a caller's `className` can override a variant's own utility).
 *
 * It lives HERE, not in a component file, because `components.json` declares this path as
 * `aliases.utils`: a component pulled with `shadcn add` imports `@/lib/utils` and must
 * compile unedited (HOW-16 P1.3). `@/*` maps to `web/app/*` in tsconfig.json.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
