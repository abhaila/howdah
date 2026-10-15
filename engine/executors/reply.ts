/**
 * Interpreting a free-text reply to a permission ask. Until structured approve/deny
 * buttons land, the reply card sends prose — "Change permissions to Full Access" must
 * read as ALLOW, not be forwarded as a deny message (observed failure).
 */
const ALLOW_PATTERN =
  /\b(allow|approve[d]?|yes|ok(ay)?|lgtm|proceed|go ahead|continue|resume|full access|allow all|grant(ed)?)\b/i;
const DENY_PATTERN = /\b(deny|denied|no|don'?t|stop|reject|block)\b/i;

/**
 * The reply to an MCP elicitation park (codex.ts): the operator was sent somewhere to act (a
 * reconnect URL), so ANY reply that is not a refusal means "done, carry on" — "done",
 * "reconnected", an empty send. Only an explicit refusal declines, and `skip`/`decline`/
 * `cancel` count as one here because that is the vocabulary such a card invites.
 */
export function isDenyReply(reply: string): boolean {
  const r = reply.trim();
  return DENY_PATTERN.test(r) || /\b(skip|decline|cancel)\b/i.test(r);
}

export function isAllowReply(reply: string): boolean {
  const r = reply.trim();
  if (r === "") return true; // an empty reply on an ask card means "let it through"
  if (DENY_PATTERN.test(r)) return false; // an explicit deny wins outright — the safe direction
  return ALLOW_PATTERN.test(r);
}
