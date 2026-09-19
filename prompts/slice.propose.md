---
id: slice.propose
version: 1
tags: [implement-slice]
provenance: system-map 1c — the read-only proposer of a vertical slice, drawn on the code-derived map
---
You are designing a vertical slice on a map extracted from the real code. This step is READ-ONLY design work: do not create, edit or delete files, commits or branches. The worktree is fingerprinted — any change you make invalidates your own proposal. Read the code you need, then answer with a ghost set.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

## The map around this ticket

Everything below was extracted from the code by tree-sitter adapters (tier in [brackets]). It is bounded: absence from it is NOT evidence that something does not exist — read the code when you need more.

{{ context.map.neighbourhood }}

## Operator feedback on the previous draft

A JSON array. `source: "comment"` items are pinned to one id of your previous ghost set (`entity_id`); `source: "redesign"` items are instructions for the whole design. Address every item in this draft — change the ghost it points at, or remove it — and never silently drop one. `[]` means this is a first draft.

{{ context.slice.feedback }}

## What to return: a ghost set

`slice.ghosts` is ONE JSON object with exactly four arrays (use `[]` when there are none):

```
{
  "blocks":   [{ "id": <block key>, "op": <op>, "responsibility": <prose>, "plane"?: <string> }],
  "entities": [{ "id": <entity key>, "op": <op>, "block": <block key>, "kind": "route" | "function" | "fetch-site",
                 "expected_file": <repo-relative path>, "names"?: [<prose>] }],
  "edges":    [{ "from": <id>, "to": <id>, "kind": "import" | "call" | "route-handler" | "fe-be", "op": <op> }],
  "trace":    [{ "scenario": <prose>, "steps": [<entity id>, <entity id>, ...] }]
}
```

No other fields. Ops:

- `add` — a new block / entity / edge. Its id must follow the key grammar below and must NOT already exist in the map.
- `modify` — an existing block or entity whose body you will change. The id must be copied exactly from the map.
- `remove` — an existing block / entity / edge that the slice deletes. Exact id from the map.
- `keep` — an existing block or entity the slice relies on and must NOT change (drift reports it if it does). Exact id from the map; a kept entity's `expected_file` is the file the map has it in.

Edges have no content: use `add`, `remove` or `keep`, never `modify`. `keep` / `remove` edges must already be in the map. An `add` or `keep` edge cannot touch an endpoint this ghost set removes — an edge cannot outlive its endpoint.

The set must propose something: at least one block, entity or edge.

### Identity keys (the grammar every id must follow)

| Kind | Key | Examples |
|---|---|---|
| Block (JVM) | `<gradle project path>/<package>` | `:api/com.example.api`, `:shared:core/com.example.core` |
| Block (TS) | the nearest package.json directory, repo-relative | `web`, `.` for the repo root |
| Route | `METHOD /normalised/path` — every path parameter (`{id}`, `:id`, `${id}`) becomes `{*}` | `GET /api/users/{*}`, `DELETE /api/v1/orders/{*}` |
| Function (JVM) | `package.Class.method(ParamType,…)` using the declared parameter types; top-level: `package.<top>.name(T)`; extension: `package.<ext Recv>.name(T)` | `com.example.api.<top>.getUser(Request)`, `com.example.api.Renderer.render(User)`, `com.example.api.<ext String>.slugify()` |
| Function (TS) | `module/path#exportName` or `module/path#Class.member` — the module path is the file path without its extension | `web/src/api#getUser`, `web/src/api#ApiClient.health` |
| Fetch site | `<enclosing function id>|METHOD /normalised/path`; a fetch at module level (outside any function) is enclosed by `module/path#<module>` | `web/src/api#getUser|GET /api/users/{*}`, `web/src/boot#<module>|GET /api/config` |
| Edge | written as `from→to:kind` when pinned; in the ghost set it is the `from` / `to` / `kind` fields | `web/src/api#getUser|GET /api/users/{*}→GET /api/users/{*}:fe-be` |

Edge kinds join fixed endpoint kinds: `import` block → block, `call` function → function, `route-handler` route → function, `fe-be` fetch-site → route.

Ids marked AMBIGUOUS in the map can never be verified — do not use them; pin the change to something unambiguous next to them.

### expected_file (required on every entity)

- The repo-relative file the entity lives in now (modify / remove / keep) or will live in (add) — forward slashes, no `./`, no `..`, not absolute.
- A source file the map extracts: `.kt`, `.java`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`.
- For a TS key it must agree with the key's module path (`web/src/api#deleteUser` lives in `web/src/api.ts` or `.tsx`); a JVM key lives in a `.kt` / `.java` file whose package the key starts with (`com.example.api.<top>.deleteUser(Request)` lives in a file declaring `package com.example.api`).
- The entity's `block` is the block that file belongs to in the map: an existing file's block exactly as the map shows it; a new file's block by its location (Gradle project + package for JVM, nearest package.json directory for TS).
- Not a git-ignored or generated path: the map never extracts those, so nothing there can be verified.
- It is where the implementation will be checked: after the slice is built, the map is extracted again and each ghost is compared with the code (verified / missing / unchanged / changed-unexpectedly / still-present).

`trace` steps are entity ids (from this ghost set or the map), at least two per scenario, in call order, and none of them removed by this set.

`responsibility`, `names` and `scenario` are prose for the operator: shown, never verified.

### How to draw a good slice

- Cover the whole vertical path the goal needs (UI fetch site → route → handler → the functions it calls) and nothing else.
- Mark what must not change as `keep` — that is how an accidental edit gets caught.
- Add a `trace` per scenario the goal describes, in call order, so the operator can walk the path.
- Prefer the smallest set of ghosts that makes the design reviewable; every ghost is something the operator must read.

Return the ghost set as `slice.ghosts` (a JSON object, not a string).
