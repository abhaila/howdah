import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FileParser } from "./facts";
import { FIXTURE_DIR } from "./testkit";
import type { FileFacts, Language } from "./types";

let parser: FileParser;
beforeAll(async () => {
  parser = await FileParser.create();
});

async function facts(content: string, lang: Language): Promise<FileFacts> {
  const r = await parser.parse(content, lang);
  if (!r.ok) throw new Error(r.reason);
  return r.facts;
}

const fixture = (p: string) => readFileSync(join(FIXTURE_DIR, p), "utf8");
const KT = "api/src/main/kotlin/com/example/api/";

describe("Kotlin declarations", () => {
  test("package, overloads, generics/defaults, nested + companion chains, extension, top-level", async () => {
    const f = await facts(fixture(KT + "Handlers.kt"), "kotlin");
    expect(f.package).toBe("com.example.api");
    const fns = f.decls.filter((d) => d.kind === "function").map((d) => ({ name: d.name, container: d.container, params: d.params, receiver: d.receiver, topLevel: d.topLevel }));
    expect(fns).toEqual([
      { name: "render", container: ["Renderer"], params: ["User"], receiver: undefined, topLevel: false },
      { name: "render", container: ["Renderer"], params: ["Order"], receiver: undefined, topLevel: false },
      { name: "page", container: ["Renderer"], params: ["List<T>", "Int"], receiver: undefined, topLevel: false },
      { name: "describe", container: ["Renderer", "Inner"], params: ["Map<String,Int>"], receiver: undefined, topLevel: false },
      { name: "create", container: ["Renderer", "Companion"], params: [], receiver: undefined, topLevel: false },
      { name: "lookup", container: ["Registry"], params: ["String"], receiver: undefined, topLevel: false },
      { name: "slugify", container: [], params: [], receiver: "String", topLevel: true },
      { name: "health", container: [], params: ["Request"], receiver: undefined, topLevel: true },
      { name: "helper", container: [], params: ["Int"], receiver: undefined, topLevel: true },
    ]);
    const types = f.decls.filter((d) => d.kind !== "function").map((d) => `${d.kind}:${[...d.container, d.name].join(".")}`);
    expect(types).toEqual(["class:User", "class:Order", "class:Renderer", "class:Renderer.Inner", "object:Renderer.Companion", "object:Registry"]);
  });

  test("casts (as / as?) are inventoried with line and type; names declared in bodies are listed", async () => {
    const f = await facts(fixture(KT + "Handlers.kt"), "kotlin");
    expect(f.casts).toEqual([
      { line: 37, kind: "as", type: "String" },
      { line: 38, kind: "as?", type: "Int" },
    ]);
    expect(f.locals.map((l) => `${l.name}@${l.line}`)).toEqual(["size@19", "raw@36", "text@37", "maybe@38"]);
  });

  test("calls carry callee, receiver and the enclosing declaration", async () => {
    const f = await facts(fixture(KT + "App.kt"), "kotlin");
    const getUser = f.decls.findIndex((d) => d.name === "getUser");
    expect(f.calls.filter((c) => c.enclosing === getUser).map((c) => `${c.receiver ?? "-"}.${c.callee}@${c.line}`)).toEqual([
      "req.path@35",
      "Renderer().render@36",
      "-.Renderer@36",
      "-.User@36",
      "Response(OK).body@37",
      "-.Response@37",
    ]);
  });

  test("Kotlin 2.2 context parameters are an unparsed region, and the swallowed functions are not claimed", async () => {
    const f = await facts(fixture(KT + "Audit.kt"), "kotlin");
    expect(f.unparsed).toEqual([{ startLine: 7, endLine: 12, kind: "error" }]);
    expect(f.decls.map((d) => d.name)).toEqual(["Logger", "info"]);
  });

  test("interfaces, enums, local functions and imports", async () => {
    const src = `package p
import a.b.C
import a.d.*
import a.e.F as G

interface I {
    fun f()
}

enum class E {
    A;
    fun g() = 1
}

fun outer() {
    fun inner() = 1
    val (x, y) = pair
    for (i in xs) {}
}
`;
    const f = await facts(src, "kotlin");
    expect(f.imports).toEqual([
      { line: 2, path: "a.b.C" },
      { line: 3, path: "a.d", wildcard: true },
      { line: 4, path: "a.e.F", alias: "G" },
    ]);
    expect(f.unparsed).toEqual([]);
    expect(f.decls.map((d) => `${d.kind}:${d.name}`)).toEqual(["interface:I", "function:f", "enum:E", "function:g", "function:outer"]);
    expect(f.locals.map((l) => l.name).sort()).toEqual(["i", "inner", "x", "y"]);
  });
});

describe("Java declarations", () => {
  test("package, constructors as <init>, overloads with generic param text, varargs, nested classes, casts", async () => {
    const f = await facts(fixture("shared/core/src/main/java/com/example/core/Greeter.java"), "java");
    expect(f.package).toBe("com.example.core");
    expect(f.decls.filter((d) => d.kind === "function").map((d) => `${[...d.container, d.name].join(".")}(${(d.params ?? []).join(",")})`)).toEqual([
      "Greeter.<init>(String)",
      "Greeter.greet(Object)",
      "Greeter.greet(Map<String,List<Integer>>,int)",
      "Greeter.format(int,int)",
      "Greeter.Nested.run(String...)",
    ]);
    expect(f.casts).toEqual([
      { line: 14, kind: "cast", type: "String" },
      { line: 30, kind: "cast", type: "Object" },
    ]);
    expect(f.locals.map((l) => l.name)).toEqual(["name", "total", "g"]);
    expect(f.imports.map((i) => i.path)).toEqual(["java.util.List", "java.util.Map"]);
    expect(f.calls.find((c) => c.callee === "format")).toEqual({ line: 20, callee: "format", receiver: null, enclosing: 3 });
    expect(f.decls[3]?.params).toEqual(["Map<String,List<Integer>>", "int"]);
  });
});

describe("TypeScript declarations", () => {
  test("exported functions, const arrows, class members, default export; overload signatures carry no key", async () => {
    const src = `export function f(a: string): void;
export function f(a: number): void;
export function f(a: unknown) {}
const g = () => 1;
export { g as gee };
export default function () {}
export const Memo = memo(function Inner() { return 1; });
class K { m() {} field = () => 2; }
declare function ambient(): void;
`;
    const f = await facts(src, "typescript");
    expect(f.decls.map((d) => `${[...d.container, d.name].join(".")}:${d.exportName ?? "-"}`)).toEqual(["f:f", "g:gee", "default:default", "Memo:Memo", "K:-", "K.m:-", "K.field:-"]);
  });

  test("fixture api.ts: casts, locals exclude own params and function-type params", async () => {
    const f = await facts(fixture("web/src/api.ts"), "typescript");
    expect(f.casts).toEqual([{ line: 11, kind: "as", type: "User" }]);
    expect(f.locals.map((l) => l.name)).toEqual(["res", "r", "cache"]);
  });

  test("tsx: non-null and as casts; legacy angle-bracket assertion in .ts", async () => {
    const tsx = await facts(fixture("web/src/Users.tsx"), "tsx");
    expect(tsx.casts).toEqual([
      { line: 7, kind: "non-null", type: "" },
      { line: 8, kind: "as", type: "User|undefined" },
    ]);
    const legacy = await facts(fixture("web/src/legacy.ts"), "typescript");
    expect(legacy.casts).toEqual([{ line: 6, kind: "angle", type: "Box" }]);
  });

  test("imports record bindings, including namespace, default and re-exports", async () => {
    const f = await facts(`import React, { useState as us } from "react";\nimport * as api from "./api";\nexport * from "./x";\n`, "typescript");
    expect(f.imports).toEqual([
      { line: 1, source: "react", names: [{ imported: "default", local: "React" }, { imported: "useState", local: "us" }] },
      { line: 2, source: "./api", names: [{ imported: "*", local: "api" }] },
      { line: 3, source: "./x", names: [{ imported: "*", local: "*" }], reexport: true },
    ]);
  });
});

describe("http4k adapter", () => {
  test("nested routes(...) prefixes are joined by ancestry; handlers named", async () => {
    const f = await facts(fixture(KT + "App.kt"), "kotlin");
    expect(f.routes.map((r) => ({ method: r.method, path: r.path, template: r.template, handler: r.handler.name, line: r.line }))).toEqual([
      { method: "GET", path: "/health", template: "/health", handler: "health", line: 14 },
      { method: "GET", path: "/api/users/{id}", template: "/api/users/{*}", handler: "getUser", line: 16 },
      { method: "POST", path: "/api/users", template: "/api/users", handler: "createUser", line: 17 },
      { method: "DELETE", path: "/api/v1/orders/{orderId:\\d+}", template: "/api/v1/orders/{*}", handler: "deleteOrder", line: 19 },
    ]);
  });

  test("a helper-built route is partial; named groups become mounts resolved at assembly", async () => {
    const f = await facts(fixture(KT + "App.kt"), "kotlin");
    expect(f.coverage).toEqual([{ adapter: "http4k", status: "partial", candidates: 13, unresolved: [{ line: 27, reason: 'bind path is not a string literal: crudPath("/admin")' }] }]);
    const app = { name: "app", line: 13, local: false, enclosing: null };
    expect(f.mounts.map(({ prefix, target, owner, rooted, line }) => ({ prefix, target, owner, rooted, line }))).toEqual([
      { prefix: "/", target: { kind: "call", name: "adminRoutes", args: 0 }, owner: app, rooted: false, line: 22 },
      { prefix: "/shop", target: { kind: "call", name: "orderRoutes", args: 0 }, owner: app, rooted: false, line: 23 },
    ]);
    expect(f.routes.every((r) => r.owner?.name === "app" && r.owner.line === 13 && !r.rooted)).toBe(true);
    // every routes(…) group's owner is recorded, including adminRoutes' (no literal route)
    expect(f.groups.map((g) => `${g.name}@${g.line}`)).toEqual(["app@13", "adminRoutes@26"]);
  });

  test("a file with no candidates is full; `bind` without an http4k import is not a candidate", async () => {
    const handlers = await facts(fixture(KT + "Handlers.kt"), "kotlin");
    expect(handlers.coverage).toEqual([{ adapter: "http4k", status: "full", candidates: 0, unresolved: [] }]);
    const koin = await facts(`package p\nval m = module { single { A() } bind B::class }\n`, "kotlin");
    expect(koin.coverage).toEqual([{ adapter: "http4k", status: "full", candidates: 0, unresolved: [] }]);
  });

  test("interpolated paths, bind without a method, non-literal methods and contract DSL are partial", async () => {
    const src = `package p
import org.http4k.routing.*
val base = "/b"
val app = routes(
  "$base/x" bind GET to ::h,
  "/static" bind static(),
  "/m" bind method to ::h,
  "/ok" bind Method.PUT to ::h,
)
val c = contract { }
`;
    const f = await facts(src, "kotlin");
    expect(f.routes.map((r) => `${r.method} ${r.template}`)).toEqual(["PUT /ok"]);
    const cov = f.coverage[0];
    expect(cov?.status).toBe("partial");
    expect(cov?.unresolved.map((u) => u.reason)).toEqual([
      'bind path is not a string literal: "$base/x"',
      "route method is not a literal HTTP method: method",
      "http4k contract routes (contract) are not covered",
    ]);
  });
});

describe("fetch adapter", () => {
  test("URL expressions: template, same-file const, imported base, dynamic segment, unknown; client.get", async () => {
    const f = await facts(fixture("web/src/api.ts"), "typescript");
    expect(f.fetches.map((x) => ({ via: x.via, method: x.method, kind: x.url.kind, template: x.url.template, base: x.url.base, line: x.line }))).toEqual([
      { via: "fetch", method: "GET", kind: "template", template: "/api/users/{*}", base: undefined, line: 10 },
      { via: "fetch", method: "POST", kind: "literal", template: "/api/users", base: undefined, line: 15 },
      { via: "fetch", method: "DELETE", kind: "base", template: "{*}/orders/{*}", base: "BASE_URL", line: 19 },
      { via: "fetch", method: "GET", kind: "template", template: "/api/{*}/list", base: undefined, line: 23 },
      { via: "fetch", method: "GET", kind: "unknown", template: "{*}", base: "url", line: 27 },
      { via: "client", method: "GET", kind: "literal", template: "/health", base: undefined, line: 34 },
    ]);
  });

  test("a non-literal URL makes coverage partial; Map.get / URLSearchParams.get are not candidates", async () => {
    const f = await facts(fixture("web/src/api.ts"), "typescript");
    expect(f.coverage.find((c) => c.adapter === "fetch")).toEqual({
      adapter: "fetch",
      status: "partial",
      candidates: 6,
      unresolved: [{ line: 27, reason: "fetch URL is a non-literal expression: url" }],
    });
  });

  test("non-literal method or init object is partial with method `*`", async () => {
    const f = await facts(`const m = pick();\nfetch("/a", { method: m });\nfetch("/b", opts);\napi.post(someUrl);\nfetch("https://h.example/c?q=1");\n`, "typescript");
    expect(f.fetches.map((x) => `${x.method} ${x.url.template}`)).toEqual(["* /a", "* /b", "POST {*}", "GET https://h.example/c"]);
    expect(f.coverage.find((c) => c.adapter === "fetch")?.unresolved.map((u) => u.reason)).toEqual([
      "fetch method is not a string literal",
      "fetch init is not an object literal: opts",
      "client URL is a non-literal expression: someUrl",
    ]);
  });

  test("a relative URL is a base-relative template", async () => {
    const f = await facts(`fetch("users/list");\n`, "typescript");
    expect(f.fetches[0]?.url).toEqual({ kind: "base", template: "{*}/users/list", text: '"users/list"', base: "<relative>" });
  });
});

describe("react-query adapter", () => {
  test("queryFn / mutationFn captured with references and enclosing component", async () => {
    const f = await facts(fixture("web/src/Users.tsx"), "tsx");
    expect(f.queryHooks.map(({ hook, fnKey, fnText, reference, enclosing }) => ({ hook, fnKey, fnText, reference, enclosing }))).toEqual([
      { hook: "useQuery", fnKey: "queryFn", fnText: "() => getUser(id)", reference: null, enclosing: 0 },
      { hook: "useMutation", fnKey: "mutationFn", fnText: "createUser", reference: "createUser", enclosing: 0 },
    ]);
    expect(f.coverage.find((c) => c.adapter === "react-query")).toEqual({ adapter: "react-query", status: "full", candidates: 2, unresolved: [] });
  });

  test("options that are not an object literal, or lack a fn, are partial", async () => {
    const f = await facts(`useQuery(userOptions(id));\nuseSuspenseQuery({ ...opts });\n`, "typescript");
    expect(f.coverage.find((c) => c.adapter === "react-query")?.unresolved.map((u) => u.reason)).toEqual([
      "useQuery options are not an object literal: userOptions(id)",
      "useSuspenseQuery has no literal queryFn (options spread)",
    ]);
  });
});

describe("failure policy", () => {
  test("a grammar that fails to load is a per-file not-checked outcome, not a throw", async () => {
    const broken = await FileParser.create({ kotlin: "/nonexistent/tree-sitter-kotlin.wasm" });
    const r = await broken.parse("fun f() = 1", "kotlin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toStartWith("grammar unavailable:");
    // other languages on the same parser still work
    expect((await broken.parse("class A {}", "java")).ok).toBe(true);
  });

  test("every ERROR / MISSING node becomes an unparsed region", async () => {
    const f = await facts(`function ok() {}\nfunction broken( {\n`, "typescript");
    expect(f.unparsed.length).toBeGreaterThan(0);
    expect(f.unparsed.every((u) => u.startLine >= 1)).toBe(true);
  });

  test("facts are path-independent: identical bytes give identical facts", async () => {
    const src = fixture(KT + "App.kt");
    expect(await facts(src, "kotlin")).toEqual(await facts(src, "kotlin"));
  });
});

// ── review fixes (1b precision): one targeted test per item ─────────────────

const HTTP4K_IMPORTS = "import org.http4k.core.Method.GET\nimport org.http4k.routing.bind\nimport org.http4k.routing.routes\n";

describe("review item 1: http4k groups record owner, mounts and server roots", () => {
  test("a group in a helper function is owned by it; `bind helper()` and `routes(helper())` are mounts", async () => {
    const orders = await facts(`package p\n${HTTP4K_IMPORTS}fun orderRoutes() = routes(\n    "/orders" bind GET to ::listOrders,\n)\n`, "kotlin");
    expect(orders.routes.map((r) => [r.method, r.path, r.owner?.name, r.rooted])).toEqual([["GET", "/orders", "orderRoutes", false]]);
    expect(orders.coverage[0]?.status).toBe("full");
    const app = await facts(`package p\n${HTTP4K_IMPORTS}fun app() = routes(\n    "/api" bind routes("/v1" bind orderRoutes()),\n    other(),\n)\nfun main() { app().asServer(Jetty(1)).start() }\n`, "kotlin");
    expect(app.mounts.map((m) => [m.prefix, m.target, m.owner?.name])).toEqual([
      ["/", { kind: "call", name: "other", args: 0 }, "app"],
      ["/api/v1", { kind: "call", name: "orderRoutes", args: 0 }, "app"],
    ]);
    // the RECEIVER of .asServer is recorded as a reference (not every identifier in sight)
    expect(app.serverRoots.map((r) => r.ref)).toEqual([{ kind: "call", name: "app", args: 0 }]);
  });

  test("a group that is literally the receiver of .asServer is rooted; a filter-wrapped bind target is an unknown prefix", async () => {
    const f = await facts(`package p\n${HTTP4K_IMPORTS}fun main() {\n    routes("/x" bind GET to ::h).asServer(Jetty(1)).start()\n}\nval wrapped = routes("/a" bind filter.then(routes("/b" bind GET to ::h)))\n`, "kotlin");
    expect(f.routes.map((r) => [r.path, r.rooted])).toEqual([["/x", true]]);
    expect(f.coverage[0]?.unresolved.map((u) => u.reason)).toEqual([
      "an enclosing bind prefix is not a string literal, or passes through a non-routes target",
      'bind target is neither routes(...), a named routes group, nor `METHOD to handler`: filter.then(routes("/b" bind GET to ::h))',
    ]);
  });
});

describe("review item 2: nothing is emitted from an unparsed region", () => {
  test("Kotlin 2.1 `when` guard: the class's members are not recovered as top-level functions", async () => {
    const src = `package z\n\nclass S {\n    fun m1(x: Any): Int = when (x) {\n        is String if x.isEmpty() -> 1\n        else -> 2\n    }\n\n    fun m2(s: String) {}\n}\n\nfun after() {}\n`;
    const f = await facts(src, "kotlin");
    expect(f.unparsed.length).toBeGreaterThan(0);
    expect(f.decls.filter((d) => d.name === "m2" || d.name === "m1")).toEqual([]);
    expect(f.decls.some((d) => d.topLevel && d.name === "m2")).toBe(false);
  });

  test("an ERROR inside a function drops that function and its calls; adapters turn partial", async () => {
    const src = `package p\n${HTTP4K_IMPORTS}fun ok() = helper()\nfun bad() {\n    val x = (1 + \n    helper()\n}\nfun helper() = 1\n`;
    const f = await facts(src, "kotlin");
    expect(f.unparsed.length).toBeGreaterThan(0);
    expect(f.decls.map((d) => d.name)).not.toContain("bad");
    expect(f.calls.every((c) => c.enclosing === null || f.decls[c.enclosing]?.name !== "bad")).toBe(true);
    expect(f.coverage[0]?.status).toBe("partial");
    expect(f.coverage[0]?.unresolved.at(-1)?.reason).toStartWith("unparsed region (lines");
  });

  test("regions widen to the end of the parent (recovery can re-attach later code to the wrong parent)", async () => {
    const f = await facts(`function a() {\n  const x = (;\n  const y = 2;\n}\nfunction b() {}\n`, "typescript");
    expect(f.unparsed[0]?.startLine).toBe(2);
    expect(f.decls.map((d) => d.name)).toEqual(["b"]);
  });
});

describe("review item 3: anonymous objects/classes and initializers are not declaration scopes", () => {
  test("Kotlin object literals (top-level and in a class property) declare no members", async () => {
    const src = `package p

class Svc {
    val listener = object : Runnable {
        override fun run() {
            helper()
        }
    }

    fun helper() {}
}

val top = object : Runnable {
    override fun run() {}
}
`;
    const f = await facts(src, "kotlin");
    expect(f.unparsed).toEqual([]);
    expect(f.decls.filter((d) => d.kind === "function").map((d) => [...d.container, d.name].join("."))).toEqual(["Svc.helper"]);
    expect(f.locals.map((l) => l.name)).not.toContain("listener");
    const call = f.calls.find((c) => c.callee === "helper");
    expect(call?.enclosing).toBeNull();
  });

  test("Java anonymous classes in field initializers and enum constant bodies declare no members", async () => {
    const f = await facts(`package p;\npublic class Anon {\n  private final Runnable r = new Runnable() { public void run() { go(); } };\n  enum E { A { void x() {} }; }\n  void go() {}\n}\n`, "java");
    expect(f.decls.filter((d) => d.kind === "function").map((d) => [...d.container, d.name].join("."))).toEqual(["Anon.go"]);
    expect(f.locals.map((l) => l.name)).not.toContain("r");
  });
});

describe("review item 4 (facts): what call resolution needs to be careful", () => {
  test("Kotlin calls inside lambdas are flagged; classes with supertypes are flagged", async () => {
    const f = await facts(`package q\nopen class Base { fun g() {} }\nclass A : Base() {\n    fun f() { g() }\n    fun h(sb: StringBuilder) { with(sb) { append("x") } }\n    fun k() { val g = { 1 }; g() }\n}\n`, "kotlin");
    expect(f.decls.find((d) => d.name === "A")?.supertypes).toBe(true);
    expect(f.decls.find((d) => d.name === "Base")?.supertypes).toBeUndefined();
    expect(f.calls.find((c) => c.callee === "append")?.inLambda).toBe(true);
    expect(f.calls.find((c) => c.callee === "with")?.inLambda).toBeUndefined();
    const k = f.decls.findIndex((d) => d.name === "k");
    expect(f.locals.some((l) => l.name === "g" && l.enclosing === k)).toBe(true);
  });

  test("Java extends/implements marks supertypes", async () => {
    const f = await facts(`class A extends B implements C { void f() { g(); } }\nclass D { }\n`, "java");
    expect(f.decls.find((d) => d.name === "A")?.supertypes).toBe(true);
    expect(f.decls.find((d) => d.name === "D")?.supertypes).toBeUndefined();
  });
});

describe("review items 5–9: fetch adapter precision", () => {
  test("5: generic client calls are seen; member fetch and axios(config) make the file partial", async () => {
    const f = await facts(`import axios from "axios";\nconst api = axios.create();\nexport async function a() { return api.get<User[]>("/api/orders"); }\nexport function b() { return window.fetch("/x"); }\nexport function c() { return axios({ url: "/y" }); }\n`, "typescript");
    expect(f.fetches.map((x) => `${x.via} ${x.method} ${x.url.template}`)).toEqual(["client GET /api/orders"]);
    const cov = f.coverage.find((c) => c.adapter === "fetch");
    expect(cov?.status).toBe("partial");
    expect(cov?.unresolved.map((u) => u.reason)).toEqual(["member fetch call is not covered: window.fetch(…)", "axios(config) call is not covered"]);
  });

  test("5: a receiver bound to axios.create() is a client whatever its name", async () => {
    const f = await facts(`import axios from "axios";\nconst backend = axios.create();\nexport const x = () => backend.post("/orders", {});\n`, "typescript");
    expect(f.fetches.map((x) => `${x.method} ${x.url.template}`)).toEqual(["POST /orders"]);
  });

  test("6: an absolute URL keeps its host", async () => {
    const f = await facts(`export function b() { return fetch("https://api.github.com/api/orders"); }\n`, "typescript");
    expect(f.fetches[0]?.url).toEqual({ kind: "absolute", template: "https://api.github.com/api/orders", text: '"https://api.github.com/api/orders"', base: "https://api.github.com" });
  });

  test("7: a function-local const shadowing a file-level const is dynamic", async () => {
    const f = await facts(`const BASE = "/api";\nexport async function c() { const BASE = "/other"; return fetch(BASE + "/orders"); }\nexport async function d() { return fetch(BASE + "/orders"); }\nexport async function e(BASE: string) { return fetch(BASE + "/orders"); }\n`, "typescript");
    expect(f.fetches.map((x) => `${x.url.kind} ${x.url.template}`)).toEqual(["base {*}/orders", "literal /api/orders", "base {*}/orders"]);
  });

  test("8: server-side route registration is not a fetch site", async () => {
    const f = await facts(`const app = express();\napp.get("/api/orders", (req, res) => res.send("x"));\nrouter.post("/api/x", handler);\ncache.get("/api/cached");\n`, "typescript");
    expect(f.fetches).toEqual([]);
    // a path-like literal through an unknown receiver is not guessed either way: partial
    expect(f.coverage.find((c) => c.adapter === "fetch")?.unresolved.map((u) => u.reason)).toEqual(["possible HTTP call through an unrecognised receiver: cache.get(…)"]);
  });

  test("9: an init object that spreads options without a literal method is method * and partial", async () => {
    const f = await facts(`export async function d(opts: RequestInit) { return fetch("/api/orders", { ...opts }); }\nexport async function e(opts: RequestInit) { return fetch("/api/orders", { ...opts, method: "PUT" }); }\n`, "typescript");
    expect(f.fetches.map((x) => x.method)).toEqual(["*", "PUT"]);
    expect(f.coverage.find((c) => c.adapter === "fetch")?.unresolved.map((u) => u.reason)).toEqual(["fetch init spreads options without a literal method"]);
  });
});

describe("review item 16: Kotlin vararg is part of the signature", () => {
  test("f(vararg n: Int) and f(n: Int) have different parameter text", async () => {
    const f = await facts(`package p\nfun f(vararg n: Int) {}\nfun f(n: Int) {}\nfun g(a: String, vararg rest: String?) {}\n`, "kotlin");
    expect(f.decls.map((d) => d.params)).toEqual([["vararg Int"], ["Int"], ["String", "vararg String?"]]);
  });
});

describe("review item 17: a lambda handler is named only when its body is exactly one call", () => {
  test("{ req -> getUser(req) } names getUser; wrappers and multi-statement bodies do not", async () => {
    const f = await facts(
      `package p\n${HTTP4K_IMPORTS}fun app() = routes(\n    "/a" bind GET to { req -> getUser(req) },\n    "/b" bind GET to { req -> requireAuth(req) { svc.list() } },\n    "/c" bind GET to { req -> log(req); getUser(req) },\n    "/d" bind GET to { req -> getUser(parse(req)) },\n    "/e" bind GET to handlers::list,\n    "/f" bind GET to handler,\n)\n`,
      "kotlin",
    );
    expect(f.routes.map((r) => [r.path, r.handler.name])).toEqual([
      ["/a", "getUser"],
      ["/b", null],
      ["/c", null],
      ["/d", null],
      ["/e", null],
      ["/f", null],
    ]);
  });
});

describe("re-review: references are structured, owners are declarations", () => {
  test("asServer receivers: call, local name, constructed member, filter chains; opaque otherwise", async () => {
    const src = `package p
${HTTP4K_IMPORTS}
fun main() {
    val app = createApp()
    app.asServer(SunHttp(1)).start()
    A().api().asServer(SunHttp(2)).start()
    ServerFilters.CatchAll().then(createApp()).asServer(SunHttp(3)).start()
    createApp().withFilter(f).asServer(SunHttp(4)).start()
    Api.routes.asServer(SunHttp(5)).start()
    listOf(createApp()).first().asServer(SunHttp(6)).start()
    (if (x) a else b).asServer(SunHttp(7)).start()
}
`;
    const f = await facts(src, "kotlin");
    expect(f.serverRoots.map((r) => r.ref)).toEqual([
      { kind: "name", name: "app" },
      { kind: "member", className: "A", name: "api", call: true, static: false, args: 0 },
      { kind: "call", name: "createApp", args: 0 },
      { kind: "call", name: "createApp", args: 0 },
      { kind: "member", className: "Api", name: "routes", call: false, static: true },
      // shaped like a member of class `listOf`; assembly resolves it only if such a class is declared
      { kind: "member", className: "listOf", name: "first", call: true, static: false, args: 0 },
      { kind: "opaque", text: "if (x) a else b" },
    ]);
    const main = f.decls.findIndex((d) => d.name === "main");
    expect(f.serverRoots.every((r) => r.enclosing === main)).toBe(true);
  });

  test("owners are declarations: class members carry their line; a local val group is a local owner", async () => {
    const src = `package t
${HTTP4K_IMPORTS}
class A {
    fun api() = routes("/a" bind GET to ::h)
}

class B {
    fun api() = routes("/b" bind GET to ::h)
}

fun main() {
    val local = routes("/l" bind GET to ::h)
    local.asServer(SunHttp(1)).start()
}
`;
    const f = await facts(src, "kotlin");
    expect(f.routes.map((r) => [r.path, r.owner?.name, r.owner?.line, r.owner?.local])).toEqual([
      ["/a", "api", 7, false],
      ["/b", "api", 11, false],
      ["/l", "local", 15, true],
    ]);
    const main = f.decls.findIndex((d) => d.name === "main");
    expect(f.routes[2]?.owner?.enclosing).toBe(main);
    // properties and private visibility are declarations now (names must resolve to them)
    const p = await facts(`package p\nprivate val routesA = 1\nclass K { val x = 2 }\nprivate fun hidden() {}\n`, "kotlin");
    expect(p.decls.map((d) => `${d.kind}:${[...d.container, d.name].join(".")}:${d.private === true}`)).toEqual(["property:routesA:true", "class:K:false", "property:K.x:false", "function:hidden:true"]);
    // `internal` limits visibility to the Gradle project (round 3)
    const i = await facts(`package p\ninternal fun api() = 1\ninternal class C\nfun open() = 2\n`, "kotlin");
    expect(i.decls.map((d) => `${d.name}:${d.internal === true}`)).toEqual(["api:true", "C:true", "open:false"]);
  });
});

describe("round 4: facts the pessimistic resolver relies on", () => {
  test("typealiases, extension properties, expect/actual, local classes; lambda sites", async () => {
    const src = `package p
${HTTP4K_IMPORTS}
typealias Factory = () -> Int
val String.extProp: Int get() = 1
expect fun plat(): Int
fun f() {
    class Local
    run { app().asServer(SunHttp(1)).start() }
}
`;
    const f = await facts(src, "kotlin");
    expect(f.decls.map((d) => `${d.kind}:${d.name}:${d.receiver ?? "-"}:${d.multiplatform === true}`)).toEqual(["type:Factory:-:false", "property:extProp:String:false", "function:plat:-:true", "function:f:-:false"]);
    expect(f.locals.map((l) => l.name)).toContain("Local");
    expect(f.serverRoots[0]?.inLambda).toBe(true);
  });

  test("identifiers inside unparsed regions are recorded", async () => {
    const f = await facts(`package p\n\ncontext(logger: Logger)\nfun hiddenApp() = 1\n`, "kotlin");
    expect(f.unparsedNames).toContain("hiddenApp");
  });
});

describe("round 5: facts for U15/U16", () => {
  test("argument bounds: defaults, vararg; call argument counts; spread is unknowable", async () => {
    const f = await facts(`package p\n${HTTP4K_IMPORTS}fun f(a: Int, b: Int = 2, vararg c: String) {}\nfun g() = 1\nfun main() {\n    f(1, 2).asServer(SunHttp(1))\n    f(*arr).asServer(SunHttp(2))\n}\n`, "kotlin");
    expect(f.decls.filter((d) => d.kind === "function").map((d) => [d.name, d.minArgs, d.maxArgs])).toEqual([
      ["f", 1, null],
      ["g", 0, 0],
      ["main", 0, 0],
    ]);
    expect(f.serverRoots.map((r) => r.ref)).toEqual([
      { kind: "call", name: "f", args: 2 },
      { kind: "call", name: "f" },
    ]);
  });

  test("rootNote names the unmodelled wrapper; modelled wrappers root", async () => {
    const f = await facts(`package p\n${HTTP4K_IMPORTS}fun main() {\n    routes("/a" bind GET to ::h).withBasePath("/v2").asServer(S)\n    f.then(routes("/b" bind GET to ::h)).asServer(S)\n    routes("/c" bind GET to ::h)\n}\n`, "kotlin");
    expect(f.routes.map((r) => [r.path, r.rooted, r.rootNote ?? null])).toEqual([
      ["/a", false, "served through `.withBasePath(…)`, which is not modelled"],
      ["/b", true, null],
      ["/c", false, null],
    ]);
  });
});
