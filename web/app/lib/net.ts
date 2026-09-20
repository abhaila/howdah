/**
 * The ONE door for every read in the viewer, moved out of main.tsx verbatim (HOW-16 P1).
 * Its contract is load-bearing and must not be rewritten in passing:
 *
 * Every read model in this app arrives over fetch, and `fetch` only rejects on a transport
 * failure: a 404 resolves, and its error body parses as JSON just fine. `.then(r => r.json())
 * .then(setState)` therefore stores `{error: "unknown run"}` where a RunDetail belongs, which
 * is worse than no data — a truthy non-value walks straight past every `if (!x) return
 * <Skeleton/>` guard and the next property read throws mid-render. With no error boundary in
 * this app, that throw unmounts the tree and the operator gets a blank page.
 *
 * So: one door for every read, and a non-ok response leaves the page's state alone, which is
 * what makes the loading and empty states it already has do their job.
 */
export class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`${status} from ${url}`);
  }
}

export async function getJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new HttpError(r.status, url);
  return (await r.json()) as T;
}
