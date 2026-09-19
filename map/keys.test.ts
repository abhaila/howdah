import { describe, expect, test } from "bun:test";
import { edgeKey, fetchSiteKey, joinPaths, jvmBlockKey, jvmFunctionKey, normTemplate, normType, parseKey, routeKey, splitTopLevel, tsBlockKey, tsFunctionKey, tsModulePath } from "./keys";

describe("normType", () => {
  test("whitespace never changes a type", () => {
    expect(normType("Map<String,   Int>")).toBe("Map<String,Int>");
    expect(normType(" List < T > ")).toBe("List<T>");
    expect(normType("suspend () -> Unit")).toBe("suspend()->Unit");
    expect(normType("String ?")).toBe("String?");
    expect(normType("{ get(url: string): Promise<unknown> }")).toBe("{get(url:string):Promise<unknown>}");
  });
  test("keeps meaningful spaces between words", () => {
    expect(normType("final   String")).toBe("final String");
  });
});

describe("normTemplate", () => {
  test.each([
    ["/users/{id}", "/users/{*}"],
    ["/orders/{orderId:\\d+}", "/orders/{*}"],
    ["/x/{id:[0-9]{2}}", "/x/{*}"],
    ["/users/:id/posts", "/users/{*}/posts"],
    ["/users/${id}", "/users/{*}"],
    ["https://API.example.com/v1/users?x=1#h", "https://api.example.com/v1/users"],
    ["https://api.github.com", "https://api.github.com"],
    ["http://{host}:8080/x/{id}", "http://{*}:8080/x/{*}"],
    ["/a//b/", "/a/b"],
    ["", "/"],
    ["{*}{*}/x", "{*}/x"],
    ["/files/{name}.json", "/files/{*}.json"],
  ])("%s → %s", (raw, want) => {
    expect(normTemplate(raw)).toBe(want);
  });
});

test("joinPaths joins http4k prefixes", () => {
  expect(joinPaths(["/api", "/v1", "/orders"])).toBe("/api/v1/orders");
  expect(joinPaths(["/api/", "users"])).toBe("/api/users");
  expect(joinPaths(["", "/"])).toBe("/");
});

describe("key builders", () => {
  test("JVM function keys: member, top-level, extension, nested, default package", () => {
    expect(jvmFunctionKey({ pkg: "com.x", container: ["Renderer"], name: "render", params: ["User"] })).toBe("com.x.Renderer.render(User)");
    expect(jvmFunctionKey({ pkg: "com.x", container: [], name: "health", params: ["Request"] })).toBe("com.x.<top>.health(Request)");
    expect(jvmFunctionKey({ pkg: "com.x", container: [], name: "slugify", params: [], receiver: "String" })).toBe("com.x.<ext String>.slugify()");
    expect(jvmFunctionKey({ pkg: "com.x", container: ["Outer", "Inner"], name: "f", params: ["Map<String,Int>", "Int"] })).toBe("com.x.Outer.Inner.f(Map<String,Int>,Int)");
    expect(jvmFunctionKey({ pkg: "", container: [], name: "main", params: [] })).toBe("<top>.main()");
  });
  test("blocks, routes, TS functions, fetch sites, edges", () => {
    expect(jvmBlockKey("", ":api", "com.x")).toBe(":api/com.x");
    expect(jvmBlockKey("backend", ":", "com.x")).toBe("backend:/com.x");
    expect(jvmBlockKey("", ":", "")).toBe(":/<default>");
    expect(tsBlockKey("")).toBe(".");
    expect(tsBlockKey("web")).toBe("web");
    expect(routeKey("GET", "/users/{*}")).toBe("GET /users/{*}");
    expect(tsModulePath("web/src/Users.tsx")).toBe("web/src/Users");
    expect(tsFunctionKey("web/src/api", "ApiClient", "health")).toBe("web/src/api#ApiClient.health");
    expect(fetchSiteKey("web/src/api#getUser", "GET", "/api/users/{*}")).toBe("web/src/api#getUser|GET /api/users/{*}");
    expect(edgeKey("a#f", "GET /x", "fe-be")).toBe("a#f→GET /x:fe-be");
  });
});

test("splitTopLevel respects generics and function types", () => {
  expect(splitTopLevel("Map<String,Int>,Int")).toEqual(["Map<String,Int>", "Int"]);
  expect(splitTopLevel("(Int)->Unit,String")).toEqual(["(Int)->Unit", "String"]);
  expect(splitTopLevel("")).toEqual([]);
  expect(splitTopLevel("Map<String,Int")).toBeNull();
});

describe("parseKey", () => {
  test("accepts every key kind and says what it names", () => {
    expect(parseKey(":api/com.example.api")).toEqual({ ok: true, key: { kind: "block", lang: "jvm", buildRoot: "", gradlePath: ":api", package: "com.example.api" } });
    expect(parseKey("backend:shared:core/com.x")).toEqual({ ok: true, key: { kind: "block", lang: "jvm", buildRoot: "backend", gradlePath: ":shared:core", package: "com.x" } });
    expect(parseKey(":/<default>")).toEqual({ ok: true, key: { kind: "block", lang: "jvm", buildRoot: "", gradlePath: ":", package: "" } });
    expect(parseKey("web")).toEqual({ ok: true, key: { kind: "block", lang: "ts", packageDir: "web" } });
    expect(parseKey(".")).toEqual({ ok: true, key: { kind: "block", lang: "ts", packageDir: "." } });
    expect(parseKey("GET /api/users/{*}")).toEqual({ ok: true, key: { kind: "route", method: "GET", template: "/api/users/{*}" } });
    expect(parseKey("com.x.Renderer.render(User)")).toEqual({ ok: true, key: { kind: "function", lang: "jvm", qualifier: "com.x.Renderer", scope: "member", name: "render", params: ["User"] } });
    expect(parseKey("com.x.<top>.f(Map<String,Int>,(Int)->Unit)")).toEqual({
      ok: true,
      key: { kind: "function", lang: "jvm", qualifier: "com.x", scope: "top", name: "f", params: ["Map<String,Int>", "(Int)->Unit"] },
    });
    expect(parseKey("com.x.<ext Map<String,Int>>.ext()")).toEqual({ ok: true, key: { kind: "function", lang: "jvm", qualifier: "com.x", scope: "extension", receiver: "Map<String,Int>", name: "ext", params: [] } });
    expect(parseKey("com.x.Greeter.<init>(String)").ok).toBe(true);
    expect(parseKey("<top>.main()").ok).toBe(true);
    expect(parseKey("web/src/api#getUser")).toEqual({ ok: true, key: { kind: "function", lang: "ts", module: "web/src/api", name: "getUser" } });
    expect(parseKey("web/src/api#ApiClient.health")).toEqual({ ok: true, key: { kind: "function", lang: "ts", module: "web/src/api", name: "ApiClient", member: "health" } });
    const fetch = parseKey("web/src/api#deleteOrder|DELETE {*}/orders/{*}");
    expect(fetch.ok && fetch.key.kind === "fetch-site" && fetch.key.method === "DELETE" && fetch.key.template === "{*}/orders/{*}").toBe(true);
    expect(parseKey("web/src/api#<module>|GET {*}").ok).toBe(true);
    const edge = parseKey(":api/com.x→:shared:core/com.y:import");
    expect(edge.ok && edge.key.kind === "edge" && edge.key.edgeKind === "import").toBe(true);
    expect(parseKey("web/src/api#getUser|GET /api/users/{*}→GET /api/users/{*}:fe-be").ok).toBe(true);
    expect(parseKey("GET /x→com.x.<top>.h(Request):route-handler").ok).toBe(true);
  });

  test("item 10: every form the builders emit parses — backticked names, Next.js paths, unicode, #private", () => {
    const built = [
      jvmFunctionKey({ pkg: "p", container: ["Tests"], name: "`handles issue #12`", params: [] }),
      jvmFunctionKey({ pkg: "p", container: ["Tests"], name: "`a|GET /b`", params: [] }),
      jvmFunctionKey({ pkg: "p", container: ["Tests"], name: "`uses → arrows (and parens)`", params: ["Int"] }),
      jvmFunctionKey({ pkg: "p", container: [], name: "f", params: ["vararg Int"] }),
      jvmFunctionKey({ pkg: "p.ünï", container: ["Größe"], name: "berechne", params: ["Map<String,Int>"] }),
      tsFunctionKey(tsModulePath("web/src/app/(auth)/login/page.tsx"), "default"),
      tsFunctionKey(tsModulePath("web/src/app/users/[id]/[...slug]/page.tsx"), "default"),
      tsFunctionKey("web/src/@modal/x", "K", "#secret"),
      tsFunctionKey("web/src/api", "función"),
      fetchSiteKey(tsFunctionKey("web/src/app/(auth)/login/page", "default"), "GET", "/api/orders"),
      fetchSiteKey("web/src/client#b", "GET", "https://api.github.com/api/orders"),
      fetchSiteKey(jvmFunctionKey({ pkg: "p", container: ["T"], name: "`x|GET /y`", params: [] }), "GET", "/z"),
      routeKey("GET", "{*}/orders"),
    ];
    for (const k of built) {
      const r = parseKey(k);
      if (!r.ok) throw new Error(`${k}: ${r.error}`);
    }
    expect(parseKey(built[0] ?? "")).toMatchObject({ ok: true, key: { kind: "function", lang: "jvm", name: "`handles issue #12`", qualifier: "p.Tests" } });
    expect(parseKey(built[1] ?? "")).toMatchObject({ ok: true, key: { kind: "function", lang: "jvm", name: "`a|GET /b`" } });
    expect(parseKey(built[5] ?? "")).toEqual({ ok: true, key: { kind: "function", lang: "ts", module: "web/src/app/(auth)/login/page", name: "default" } });
    expect(parseKey(built[10] ?? "")).toMatchObject({ ok: true, key: { kind: "fetch-site", template: "https://api.github.com/api/orders" } });
    expect(parseKey(built[11] ?? "")).toMatchObject({ ok: true, key: { kind: "fetch-site", method: "GET", template: "/z", enclosing: { name: "`x|GET /y`" } } });
    const edge = edgeKey(built[1] ?? "", built[0] ?? "", "call");
    expect(parseKey(edge)).toMatchObject({ ok: true, key: { kind: "edge", edgeKind: "call" } });
  });

  test.each([
    ["", "empty"],
    ["p.T.`unterminated(x)", "unterminated backtick"],
    ["web/src/(auth)", "a block path with parentheses (malformed function)"],
    [" GET /x", "whitespace"],
    ["get /x", "lower-case method"],
    ["GET /users/{id}", "un-normalised template"],
    ["GET users", "template without leading slash"],
    ["com.x.render(User", "unbalanced parens"],
    ["com.x.render(Map<String, Int>)", "non-normalised param type"],
    ["render(User)", "no qualifier"],
    ["com.x.<ext >.f()", "empty receiver"],
    ["web/src/api#", "missing export name"],
    ["web/src/api#a.b.c", "too many members"],
    ["a→b:friend", "unknown edge kind"],
    ["a#f|GET users", "bad fetch template"],
    [":api/com..x", "bad package"],
    ["web/", "trailing slash block"],
  ])("rejects %j (%s)", (key) => {
    const r = parseKey(key);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
});
