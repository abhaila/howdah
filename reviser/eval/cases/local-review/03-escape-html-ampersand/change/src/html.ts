const ENTITIES: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** make untrusted text safe to place in HTML text or a quoted attribute */
export function escapeHtml(s: string): string {
  return s.replace(/[<>"']/g, (c) => ENTITIES[c]!);
}

/** wrap already-safe `body` in an element */
export function element(tag: string, body: string): string {
  return `<${tag}>${body}</${tag}>`;
}
