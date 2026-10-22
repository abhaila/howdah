/** split `items` into consecutive groups of `size` (the last may be shorter) */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("size must be a positive integer");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** one page of `items`; pages are numbered from 1 */
export function paginate<T>(items: readonly T[], page: number, size: number): T[] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("size must be a positive integer");
  if (!Number.isInteger(page) || page < 1) throw new RangeError("page must be a positive integer");
  const offset = page * size;
  return items.slice(offset, offset + size);
}
