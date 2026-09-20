import { expect, test } from "bun:test";
import { joinFetch, type RouteRef } from "./join";

const routes: RouteRef[] = [
  { key: "GET /api/users/{*}", method: "GET", template: "/api/users/{*}" },
  { key: "POST /api/users", method: "POST", template: "/api/users" },
  { key: "GET /api/orders/{*}", method: "GET", template: "/api/orders/{*}" },
  { key: "DELETE /api/v1/orders/{*}", method: "DELETE", template: "/api/v1/orders/{*}" },
  { key: "GET /files/{*}.json", method: "GET", template: "/files/{*}.json" },
];

test("exact: same method and identical normalised template — the only edge-worthy outcome", () => {
  expect(joinFetch({ method: "GET", template: "/api/users/{*}", urlKind: "template" }, routes)).toEqual({ status: "exact", candidates: ["GET /api/users/{*}"] });
  expect(joinFetch({ method: "POST", template: "/api/users", urlKind: "literal" }, routes)).toEqual({ status: "exact", candidates: ["POST /api/users"] });
});

test("a literal segment against a route parameter is a pattern match, not exact", () => {
  const r = joinFetch({ method: "GET", template: "/api/users/me", urlKind: "literal" }, routes);
  expect(r.status).toBe("pattern-match");
  expect(r.candidates).toEqual(["GET /api/users/{*}"]);
});

test("a dynamic segment can match several routes: pattern-match (N candidates), never a guess", () => {
  const r = joinFetch({ method: "GET", template: "/api/{*}/{*}", urlKind: "template" }, routes);
  expect(r.status).toBe("pattern-match");
  expect(r.candidates).toEqual(["GET /api/orders/{*}", "GET /api/users/{*}"]);
  expect(r.reason).toContain("2 candidates");
});

test("non-literal base URL: suffix match, even with a single candidate", () => {
  const r = joinFetch({ method: "DELETE", template: "{*}/orders/{*}", urlKind: "base", base: "BASE_URL" }, routes);
  expect(r).toEqual({ status: "pattern-match", candidates: ["DELETE /api/v1/orders/{*}"], reason: "base URL is non-literal (BASE_URL); 1 candidate" });
});

test("non-literal base with no matching suffix is unresolved with the reason", () => {
  const r = joinFetch({ method: "GET", template: "{*}/nothing/else", urlKind: "base", base: "API" }, routes);
  expect(r.status).toBe("unresolved");
  expect(r.reason).toBe("base URL is non-literal (API); no route matches suffix /nothing/else");
});

test("a fully non-literal URL is unresolved", () => {
  expect(joinFetch({ method: "GET", template: "{*}", urlKind: "unknown", base: "url" }, routes)).toEqual({ status: "unresolved", candidates: [], reason: "URL is a non-literal expression: url" });
});

test("a non-literal method matches any method but never exactly", () => {
  const r = joinFetch({ method: "*", template: "/api/users", urlKind: "literal" }, routes);
  expect(r.status).toBe("pattern-match");
  expect(r.candidates).toEqual(["POST /api/users"]);
});

test("method mismatch and no route are unresolved", () => {
  expect(joinFetch({ method: "PUT", template: "/api/users", urlKind: "literal" }, routes)).toEqual({ status: "unresolved", candidates: [], reason: "no PUT route matches /api/users" });
});

test("partial-segment parameters glob-match", () => {
  const r = joinFetch({ method: "GET", template: "/files/report.json", urlKind: "literal" }, routes);
  expect(r.status).toBe("pattern-match");
  expect(r.candidates).toEqual(["GET /files/{*}.json"]);
});

test("item 12: a fetch matching an ambiguous (duplicated) route is never exact", () => {
  const dup = [...routes, { key: "POST /api/users", method: "POST", template: "/api/users" }];
  expect(joinFetch({ method: "POST", template: "/api/users", urlKind: "literal" }, dup)).toEqual({
    status: "pattern-match",
    candidates: ["POST /api/users"],
    reason: "route key is ambiguous (2 definitions); 1 candidate",
  });
  const flagged = routes.map((r) => (r.key === "POST /api/users" ? { ...r, ambiguous: true } : r));
  expect(joinFetch({ method: "POST", template: "/api/users", urlKind: "literal" }, flagged).status).toBe("pattern-match");
});

test("item 12: an ambiguous fetch-site key is never exact", () => {
  const r = joinFetch({ method: "POST", template: "/api/users", urlKind: "literal", ambiguous: true }, routes);
  expect(r.status).toBe("pattern-match");
  expect(r.reason).toContain("fetch-site key is ambiguous");
});

test("item 6: an absolute URL keeps its origin and is never exact — suffix candidates or external", () => {
  const r = joinFetch({ method: "GET", template: "https://api.github.com/api/users/{*}", urlKind: "absolute", base: "https://api.github.com" }, routes);
  expect(r.status).toBe("pattern-match");
  expect(r.candidates).toEqual(["GET /api/users/{*}"]);
  expect(r.reason).toStartWith("absolute URL (origin https://api.github.com) — may not be this backend");
  expect(joinFetch({ method: "GET", template: "https://h.example/nothing/here", urlKind: "absolute", base: "https://h.example" }, routes)).toEqual({
    status: "unresolved",
    candidates: [],
    reason: "external origin https://h.example; no route matches /nothing/here",
  });
});

test("item 1: a route with an unknown mount prefix (`{*}/orders`) only ever pattern-matches, by suffix", () => {
  const open: RouteRef[] = [{ key: "GET {*}/orders", method: "GET", template: "{*}/orders" }];
  const r = joinFetch({ method: "GET", template: "/api/orders", urlKind: "literal" }, open);
  expect(r).toEqual({ status: "pattern-match", candidates: ["GET {*}/orders"], reason: "route mount prefix unknown; 1 candidate" });
  expect(joinFetch({ method: "GET", template: "{*}/orders", urlKind: "base", base: "B" }, open).status).toBe("pattern-match");
  expect(joinFetch({ method: "GET", template: "/api/items", urlKind: "literal" }, open).status).toBe("unresolved");
});
