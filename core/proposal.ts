/**
 * Proposal identity (system-map D15): a decision binds to WHAT was proposed, not only to
 * which round it was. `proposalHash(value)` is canonical JSON (object keys sorted at every
 * depth, arrays kept in order) hashed with the SAME function as `renderedHash`, so a
 * proposal and a prompt share one notion of "these bytes".
 *
 * Canonical because the proposal travels through JSON: the engine hashes the value an
 * executor returned, replay rebuilds it from `node-finished.writes`, and the `requires`
 * gate re-hashes that rebuilt value. Key order is an accident of whoever built the object,
 * so it must not change the hash; undefined members vanish exactly as JSON.stringify drops
 * them, so a value and its JSON round-trip always hash the same.
 *
 * One implementation, reused everywhere (engine, approval executor, gate, routes): a
 * second copy would make "is this still the approved proposal?" a coin toss the first time
 * the two drifted.
 */
import { renderedHash } from "./template";

/** JSON with object keys sorted recursively — the one serialisation proposalHash covers. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  // toJSON-bearing values (Date) serialise as JSON would, then canonicalise that
  const maybeJson = value as { toJSON?: () => unknown };
  if (typeof maybeJson.toJSON === "function") return sortKeys(maybeJson.toJSON());
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
  return out;
}

/** The hash a decision binds to: canonical JSON, then the renderedHash function. */
export function proposalHash(value: unknown): string {
  return renderedHash(canonicalJson(value));
}
