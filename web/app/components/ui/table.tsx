/**
 * Table — shadcn/ui `table`, vendored onto Howdah's tokens (HOW-16 P1.4). No Radix in the
 * registry version either, so this is the registry shape with our palette and type scale.
 *
 * It exists so the graph-tuning table stops repeating `border-b border-border py-2 pr-3` on
 * every one of its eighteen cells — the cell padding and the hairline are the table's, once.
 */
import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-left text-base", className)} {...props} />
    </div>
  );
}
export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("text-xs uppercase text-muted-foreground", className)} {...props} />;
}
export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn(className)} {...props} />;
}
export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("border-b border-border last:border-b-0", className)} {...props} />;
}
export function TableHead({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" className={cn("py-1.5 pr-3 font-normal", className)} {...props} />;
}
export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("py-2 pr-3", className)} {...props} />;
}
