/** wrap already-safe `body` in an element */
export function element(tag: string, body: string): string {
  return `<${tag}>${body}</${tag}>`;
}
