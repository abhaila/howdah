/** The scripted words of the demo runs — kept apart from seed.ts so the run list there reads as a list. */
import { text, think, tool, type NodeScript } from "./lib";

export const PLAN_MD = `# Plan: stop the login redirect loop for SSO users

## Problem
Users who sign in through SSO with an expired refresh cookie are bounced between \`/login\` and \`/auth/callback\` until the browser gives up (ERR_TOO_MANY_REDIRECTS). The callback handler treats *any* missing session as "not logged in" and redirects to \`/login\`, which sees the still-valid IdP session and redirects straight back.

## Approach
1. **Detect the loop** — carry a \`rt\` (redirect-ttl) counter in the signed \`state\` parameter; refuse to redirect a third time and render the "We could not sign you in" page instead.
2. **Fix the cause** — in \`SessionService.exchange()\`, when the refresh cookie is expired, clear it (\`Set-Cookie: rt=; Max-Age=0\`) *before* redirecting, so the next round-trip starts a clean authorisation.
3. **Make it observable** — emit \`auth.redirect_loop_broken\` with the tenant id so we can see how often step 1 fires after step 2 ships.

## Files
| File | Change |
|---|---|
| \`api/src/main/kotlin/com/example/api/auth/Callback.kt\` | read and bump \`rt\`, branch to the error page at 2 |
| \`api/src/main/kotlin/com/example/api/auth/SessionService.kt\` | clear the expired refresh cookie |
| \`api/src/test/kotlin/com/example/api/auth/CallbackTest.kt\` | three new cases |
| \`web/src/pages/SignInFailed.tsx\` | the new page (copy from design) |

## Risks
- The \`state\` parameter is signed with the tenant key; adding a field changes its length. Verified the IdP limit is 2 KB, we are at ~310 bytes.
- An old tab holding a pre-deploy \`state\` has no \`rt\`. Treat absent as 0.

## Out of scope
- Rotating the tenant signing keys.
- The mobile client, which does not use the cookie flow.
`;

export const ACCEPTANCE_OPEN = [
  { id: "ac-1", text: "An SSO user with an expired refresh cookie lands on the dashboard after one redirect round-trip", source: "ticket", passes: false, evidence: null, check: "tests" },
  { id: "ac-2", text: "A third consecutive redirect renders the \"We could not sign you in\" page instead of redirecting again", source: "ticket", passes: false, evidence: null, check: "tests" },
  { id: "ac-3", text: "The sign-in failure page matches the design at 1440px and 390px wide", source: "plan", passes: false, evidence: null, check: "screenshot" },
  { id: "ac-4", text: "auth.redirect_loop_broken is visible in the production dashboard within one day of release, tagged with the tenant id", source: "plan", passes: false, evidence: null, check: "after-publish" },
  { id: "ac-5", text: "Product has confirmed the copy on the failure page", source: "ticket", passes: false, evidence: null, check: "human" },
];
export const ACCEPTANCE_REVIEWED = [
  { ...ACCEPTANCE_OPEN[0]!, passes: true, evidence: { kind: "verify.result", note: "CallbackTest > expired refresh cookie is cleared and the next exchange succeeds" } },
  { ...ACCEPTANCE_OPEN[1]!, passes: true, evidence: { kind: "verify.result", note: "CallbackTest > third redirect renders the failure page (status 200, no Location header)" } },
  { ...ACCEPTANCE_OPEN[2]!, passes: true, evidence: { kind: "command", command: "bun test web/src/pages/SignInFailed.test.tsx", output: "3 pass, 0 fail — snapshot matches at 1440 and 390" } },
  ACCEPTANCE_OPEN[3]!,
  ACCEPTANCE_OPEN[4]!,
];

export const VERIFY_PASS = {
  outcome: "pass", command: "./gradlew test && bun test", exit_code: 0, duration_ms: 84_210, commit: "8c41f0e2b7aa", dirty: false,
  output_tail: "BUILD SUCCESSFUL in 1m 12s\n142 tests completed, 0 failed\nbun test v1.3.2\n 38 pass\n 0 fail\n 96 expect() calls\nRan 38 tests across 7 files. [2.41s]",
};
export const VERIFY_FAIL = {
  outcome: "fail", command: "./gradlew test && bun test", exit_code: 1, duration_ms: 61_930, commit: "1d9e33ab04c7", dirty: true,
  output_tail: "CallbackTest > third redirect renders the failure page FAILED\n    org.opentest4j.AssertionFailedError: expected: <200> but was: <302>\n        at com.example.api.auth.CallbackTest.third redirect renders the failure page(CallbackTest.kt:88)\n\n142 tests completed, 1 failed\n\nFAILURE: Build failed with an exception.\n* What went wrong:\nExecution failed for task ':api:test'.\n> There were failing tests. See the report at: file:///work/api/build/reports/tests/test/index.html",
};

export const CHANGE_MAP = {
  title: "Break the SSO redirect loop",
  summary: "The auth callback now counts redirects in the signed state and clears an expired refresh cookie, so an SSO user is signed in on the next round-trip or shown a failure page instead of looping.",
  flow_name: "One SSO sign-in",
  components: [
    { id: "browser", label: "Browser", tag: "WEB", group: "Client", status: "external", kind: "User agent", what: "Follows the redirects between the app and the identity provider.", in_flow: "Starts at /login with an expired refresh cookie.", how: [] },
    { id: "callback", label: "Callback handler", tag: "API", group: "API", status: "changed", kind: "GET /auth/callback", what: "Exchanges the authorisation code for a session. Now reads and bumps the redirect counter and branches to the failure page on the third pass.", in_flow: "Receives the code, asks SessionService for a session.", how: ["api/src/main/kotlin/com/example/api/auth/Callback.kt — parse `rt` from state, default 0", "branch to SignInFailed at rt >= 2"] },
    { id: "session", label: "SessionService", tag: "API", group: "API", status: "changed", kind: "Kotlin service", what: "Owns the refresh cookie. Clears an expired one before any redirect.", in_flow: "Finds the cookie expired, clears it, asks for a clean authorisation.", how: ["SessionService.exchange(): Set-Cookie rt=; Max-Age=0 on RefreshExpired"] },
    { id: "failed", label: "SignInFailed page", tag: "WEB", group: "Web", status: "new", kind: "React page", what: "Tells the user sign-in failed and offers a retry and a support link.", in_flow: "Shown only when the counter reaches 2.", how: ["web/src/pages/SignInFailed.tsx", "web/src/pages/SignInFailed.test.tsx"] },
    { id: "idp", label: "Identity provider", tag: "EXT", group: "External", status: "external", kind: "OIDC", what: "Authenticates the user.", in_flow: "Returns a fresh code.", how: [] },
    { id: "metrics", label: "Metrics", tag: "OBS", group: "External", status: "reused", kind: "StatsD", what: "Counts auth.redirect_loop_broken per tenant.", in_flow: "Incremented when the failure page renders.", how: ["existing Metrics.count()"] },
  ],
  links: [
    { from: "browser", to: "callback", label: "code + state" },
    { from: "callback", to: "session", label: "exchange" },
    { from: "session", to: "idp", label: "re-authorise" },
    { from: "callback", to: "failed", label: "rt >= 2" },
    { from: "callback", to: "metrics", label: "count", dashed: true },
  ],
  flow: [
    { component: "browser", text: "GET /auth/callback?code=…&state=… (rt=0)" },
    { component: "callback", text: "asks SessionService to exchange the code" },
    { component: "session", text: "refresh cookie expired → cleared → redirect to the IdP with rt=1" },
    { component: "idp", text: "returns a fresh code" },
    { component: "callback", text: "exchange succeeds → 302 /dashboard" },
  ],
  risks: ["state grows by ~8 bytes; IdP limit is 2 KB", "an old tab's state has no rt — treated as 0"],
  example: { title: "Tenant acme, cookie expired 3 days ago", body: "Before: 21 redirects, then the browser error page.", steps: ["GET /login", "GET /auth/callback (rt=0) → cookie cleared", "GET /auth/callback (rt=1) → session"], outcome: { label: "After", body: "Signed in after 2 redirects." } },
  diff: { files: 6, additions: 214, deletions: 37 },
};

const BIG_JSON = JSON.stringify({
  data: { repository: { pullRequest: { number: 4127, title: "Break the SSO redirect loop (HOW-412)", state: "OPEN", mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED",
    commits: { nodes: [{ commit: { oid: "8c41f0e2b7aa", statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [
      { name: "build", conclusion: "SUCCESS", detailsUrl: "https://github.com/acme/acme-api/actions/runs/118822331/job/1" },
      { name: "test (jvm 21)", conclusion: "SUCCESS", detailsUrl: "https://github.com/acme/acme-api/actions/runs/118822331/job/2" },
      { name: "test (web)", conclusion: "SUCCESS", detailsUrl: "https://github.com/acme/acme-api/actions/runs/118822331/job/3" },
      { name: "sonarqube", conclusion: "NEUTRAL", detailsUrl: "https://sonar.acme.example/dashboard?id=acme-api&pullRequest=4127" }] } } } }] },
    reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [{ author: { login: "priya-raman" }, path: "api/src/main/kotlin/com/example/api/auth/Callback.kt", line: 61, body: "Should `rt` be capped server-side as well? A hand-edited state with rt=-1 would get an extra lap." }] } }] } } } },
}, null, 2);

export const ticketScripts: Record<string, (visit: number) => NodeScript> = {
  "implementation.plan": () => ({
    steps: [
      think("The ticket says SSO users loop between /login and /auth/callback. Before planning I need to see how the callback decides a session is missing, and where the refresh cookie is read."),
      text("I'll read the ticket and find the callback handler first."),
      tool("mcp__linear__get_issue", { id: "HOW-412" }, JSON.stringify({ identifier: "HOW-412", title: "SSO users get ERR_TOO_MANY_REDIRECTS after the refresh cookie expires", priority: 1, labels: ["bug", "auth"], description: "Reported by 14 tenants since Tuesday. Repro: sign in with SSO, wait for the refresh cookie to expire (or delete `rt_exp`), reload.\n\n- [ ] user lands on the dashboard after one round-trip\n- [ ] a third redirect shows a failure page\n- [ ] product confirms the copy" }, null, 2)),
      tool("Grep", { pattern: "auth/callback", path: "api/src", output_mode: "content" }, "api/src/main/kotlin/com/example/api/auth/Callback.kt:22:  \"/auth/callback\" bind GET to { req -> callback(req) }\napi/src/main/kotlin/com/example/api/App.kt:14:    authRoutes(),\napi/src/test/kotlin/com/example/api/auth/CallbackTest.kt:31:    val res = app(Request(GET, \"/auth/callback?code=abc&state=$state\"))"),
      tool("Read", { file_path: "api/src/main/kotlin/com/example/api/auth/Callback.kt" }, "     1\tpackage com.example.api.auth\n     2\t\n     3\timport org.http4k.core.*\n     4\t\n     5\tfun callback(req: Request): Response {\n     6\t    val code = req.query(\"code\") ?: return Response(Status.BAD_REQUEST)\n     7\t    val session = sessions.exchange(code) ?: return Response(Status.FOUND).header(\"Location\", \"/login\")\n     8\t    return Response(Status.FOUND).header(\"Location\", \"/dashboard\").cookie(session.cookie())\n     9\t}"),
      tool("TodoWrite", { todos: [
        { content: "Read the ticket and the callback handler", status: "completed", activeForm: "Reading the ticket" },
        { content: "Trace where the refresh cookie is read and cleared", status: "completed", activeForm: "Tracing the refresh cookie" },
        { content: "Write the plan with files, risks and what is out of scope", status: "in_progress", activeForm: "Writing the plan" },
      ] }, "Todos have been modified successfully."),
    ],
    say: "The plan is below. The loop has one cause (an expired refresh cookie is never cleared) and I'm adding a guard so a future cause cannot loop either.",
    writes: { implementation_plan: PLAN_MD },
  }),
  "implementation.criteria": () => ({
    steps: [think("Three checkboxes on the ticket; the plan adds a page and a metric, so two more rows. The metric can only be seen after release — after-publish."), text("Turning the ticket's checkboxes and the plan's additions into criteria, each with how it will be checked.")],
    say: "Five criteria: three from the ticket, two from the plan. Two of them cannot be proven inside this run and say so.",
    writes: { acceptance: ACCEPTANCE_OPEN },
  }),
  "implementation.implement": () => ({
    steps: [
      tool("TodoWrite", { todos: [
        { content: "Add the rt counter to the signed state (parse, default 0, bump)", status: "completed", activeForm: "Adding the rt counter" },
        { content: "Clear the expired refresh cookie in SessionService.exchange()", status: "completed", activeForm: "Clearing the expired cookie" },
        { content: "Render SignInFailed at rt >= 2 and count auth.redirect_loop_broken", status: "completed", activeForm: "Rendering the failure page" },
        { content: "Three CallbackTest cases + the page snapshot test", status: "completed", activeForm: "Writing tests" },
        { content: "Run the whole suite and commit", status: "completed", activeForm: "Running the suite" },
      ] }, "Todos have been modified successfully."),
      text("Starting with the state parameter, since both halves of the fix read it."),
      tool("Edit", { file_path: "api/src/main/kotlin/com/example/api/auth/Callback.kt", old_string: "    val session = sessions.exchange(code) ?: return Response(Status.FOUND).header(\"Location\", \"/login\")", new_string: "    val state = State.parse(req.query(\"state\"))\n    val session = sessions.exchange(code)\n    if (session == null) {\n        if (state.rt >= 2) { metrics.count(\"auth.redirect_loop_broken\", \"tenant\" to state.tenant); return signInFailed() }\n        return Response(Status.FOUND).header(\"Location\", \"/login?state=${state.bump().sign()}\").clearRefreshCookie()\n    }" }, "The file api/src/main/kotlin/com/example/api/auth/Callback.kt has been updated."),
      tool("Bash", { command: "./gradlew :api:test --tests '*CallbackTest*' 2>&1 | tail -20", description: "Run the callback tests" }, "> Task :api:test\n\nCallbackTest > expired refresh cookie is cleared and the next exchange succeeds PASSED\nCallbackTest > third redirect renders the failure page FAILED\n    org.opentest4j.AssertionFailedError: expected: <200> but was: <302>\n        at com.example.api.auth.CallbackTest.third redirect renders the failure page(CallbackTest.kt:88)\n\n3 tests completed, 1 failed", true),
      think("rt is bumped after the comparison, so the third pass still sees 1. Compare against the incoming value, bump only on the redirect branch — which is what I wrote; the test builds state with rt=1 and expects the page. So the threshold in the test is wrong, not the code? No: the plan says a THIRD redirect is refused; passes 0 and 1 redirect, pass 2 renders. The test should send rt=2."),
      tool("Edit", { file_path: "api/src/test/kotlin/com/example/api/auth/CallbackTest.kt", old_string: "State(tenant = \"acme\", rt = 1)", new_string: "State(tenant = \"acme\", rt = 2)" }, "The file api/src/test/kotlin/com/example/api/auth/CallbackTest.kt has been updated."),
      tool("Bash", { command: "./gradlew test && bun test", description: "Run the whole suite" }, VERIFY_PASS.output_tail),
      tool("Bash", { command: "gh api graphql -f query='query { repository(owner:\"acme\", name:\"acme-api\") { pullRequest(number: 4127) { number title state mergeable reviewDecision commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:20){nodes{... on CheckRun{name conclusion detailsUrl}}}}}}} reviewThreads(first:50){nodes{isResolved comments(first:10){nodes{author{login} path line body}}}} } } }'" }, BIG_JSON),
      tool("Bash", { command: "git add -A && git commit -q -m 'Break the SSO redirect loop (HOW-412)' && git log --oneline -1" }, "8c41f0e Break the SSO redirect loop (HOW-412)"),
    ],
    say: "Implemented and committed as `8c41f0e`. Both halves are in: the expired cookie is cleared before the redirect, and a third pass renders the failure page and counts `auth.redirect_loop_broken`. 142 JVM tests and 38 web tests pass.",
    writes: { implementation_summary: "Cleared the expired refresh cookie in `SessionService.exchange()`, added a signed `rt` counter to the auth state and a `SignInFailed` page rendered on the third pass. 6 files, +214 −37, commit `8c41f0e`. One test threshold was wrong (rt=1 → rt=2) and is fixed." },
  }),
  "implementation.local_review": (visit) => ({
    steps: [
      text("Reading the diff against the plan, then the test output."),
      tool("Bash", { command: "git diff main...HEAD --stat" }, " api/src/main/kotlin/com/example/api/auth/Callback.kt        | 31 ++++--\n api/src/main/kotlin/com/example/api/auth/SessionService.kt  | 12 ++-\n api/src/main/kotlin/com/example/api/auth/State.kt           | 44 ++++++++\n api/src/test/kotlin/com/example/api/auth/CallbackTest.kt    | 71 ++++++++++++\n web/src/pages/SignInFailed.tsx                              | 58 ++++++++++\n web/src/pages/SignInFailed.test.tsx                         | 35 ++++++\n 6 files changed, 214 insertions(+), 37 deletions(-)"),
    ],
    say: visit === 1 ? "The change does what the plan says, the suite is green, and three of five criteria are proven. The other two cannot be proven by this run: one needs production, one needs a person." : "Second look after the revision: unchanged verdict.",
    writes: { review_verdict: "pass", review_findings: [{ severity: "nit", file: "api/src/main/kotlin/com/example/api/auth/State.kt", line: 19, note: "`rt` is parsed with toInt(); a negative value would get extra laps. Clamp to 0..2." }, { severity: "note", note: "ac-4 and ac-5 are not provable here; listed for the PR description." }], acceptance: ACCEPTANCE_REVIEWED },
  }),
  "implementation.report": () => ({ steps: [text("Mapping the change for the report.")], say: "The change map is ready.", writes: { change_map: CHANGE_MAP } }),
  "delivery.publish": (visit) => ({
    steps: [
      tool("Bash", { command: "git push -u origin HEAD 2>&1 | tail -3" }, "remote: Create a pull request for 'howdah/implement-ticket-how412' on GitHub by visiting:\nremote:      https://github.com/acme/acme-api/pull/new/howdah/implement-ticket-how412\nBranch 'howdah/implement-ticket-how412' set up to track remote branch."),
      tool("Bash", { command: "gh pr create --title 'Break the SSO redirect loop (HOW-412)' --body-file /tmp/pr-body.md" }, "https://github.com/acme/acme-api/pull/4127"),
    ],
    say: visit === 1 ? "Opened https://github.com/acme/acme-api/pull/4127 with Why / What / Notes for testing, and a \"Not proven by this run\" section naming the two criteria that need production and product." : "Pushed the review fix to the same PR.",
    writes: { publication_summary: "PR https://github.com/acme/acme-api/pull/4127 — \"Break the SSO redirect loop (HOW-412)\". Description lists two criteria not proven by this run (ac-4 after release, ac-5 product sign-off)." },
  }),
  "delivery.address_reviews": () => ({
    steps: [
      text("One unresolved thread from priya-raman on Callback.kt:61 — clamp `rt`. That is also the local reviewer's nit; fixing both."),
      tool("Edit", { file_path: "api/src/main/kotlin/com/example/api/auth/State.kt", old_string: "rt = parts[2].toInt()", new_string: "rt = parts[2].toIntOrNull()?.coerceIn(0, 2) ?: 0" }, "The file api/src/main/kotlin/com/example/api/auth/State.kt has been updated."),
      tool("Bash", { command: "./gradlew :api:test -q && git commit -qam 'Clamp rt to 0..2' && git push -q && git log --oneline -1" }, "b77d1c4 Clamp rt to 0..2"),
    ],
    say: "Clamped `rt` to 0..2, added a test for a negative value, pushed `b77d1c4` and replied on the thread.",
    writes: { repair_summary: "Clamped the redirect counter to 0..2 (review thread on Callback.kt:61), one new test, pushed b77d1c4, replied on the thread." },
  }),
  "delivery.review_repairs": () => ({ steps: [tool("Bash", { command: "git diff 8c41f0e..HEAD --stat" }, " api/src/main/kotlin/com/example/api/auth/State.kt        | 2 +-\n api/src/test/kotlin/com/example/api/auth/StateTest.kt    | 9 +++++++++\n 2 files changed, 10 insertions(+), 1 deletion(-)")], say: "The repair is the one-line clamp and its test. Nothing else changed.", writes: { review_verdict: "pass", review_findings: [] } }),
  complete_ticket: () => ({ steps: [tool("mcp__linear__get_issue", { id: "HOW-412" }, "{\"identifier\":\"HOW-412\",\"state\":\"In Review\"}")], say: "Moved HOW-412 to Done and linked the merged PR.", writes: { completion_summary: "HOW-412 closed; PR #4127 merged as 3fa9c21." } }),
};

export const LONG_PUBLISH_REASON = `"delivery.publish" requires the acceptance criteria to be met: 2 of 5 criteria are not met and have not been waived — ac-4 "auth.redirect_loop_broken is visible in the production dashboard within one day of release, tagged with the tenant id" (after-publish: this run cannot observe production), ac-5 "Product has confirmed the copy on the failure page" (human: nobody has said so on the ticket). Publishing is held until every criterion passes or you waive the ones this run cannot prove. Waive them with \`howdah waive implement-ticket-mhv2k9qd --unprovable "<reason>"\`, or reply here with what the reviewer should accept as evidence and the run will retry the step.`;

export const LONG_FAIL_REASON = `output contract violation: the final message of "implementation.implement" did not end with {"outputs": {...}} carrying exactly [implementation_summary]. The agent's last words were: "I have made the rate-limit middleware change but I am not confident about the Retry-After semantics for burst tenants — the ticket says 'reset at the window boundary' and the existing gateway code uses a sliding window, so the header would be wrong for roughly 8% of requests. I would rather stop and ask than ship a header that lies. Options: (a) switch the limiter to fixed windows for the public API only, (b) compute Retry-After from the sliding window's oldest entry, (c) omit Retry-After and send only X-RateLimit-Remaining." Asked once more on the same session; the repair turn also ended in prose.`;

export const QUESTIONS = [
  {
    id: "q1", header: "Window", multiSelect: false,
    question: "The ticket says Retry-After should be \"the window boundary\", but the gateway limiter is a sliding window. Which behaviour do you want for the public API?",
    options: [
      { label: "Fixed windows for the public API", description: "Switch only the public routes to fixed 60s windows. Retry-After is exact; bursts at the boundary become possible (2x for an instant)." },
      { label: "Keep sliding, compute Retry-After", description: "Derive Retry-After from the oldest entry in the sliding window. No behaviour change for tenants; ~40 lines more code and one Redis read per 429." },
      { label: "Omit Retry-After", description: "Send only X-RateLimit-Limit / -Remaining / -Reset. Smallest change; SDKs that back off on Retry-After will fall back to their default." },
    ],
  },
  {
    id: "q2", header: "Docs", multiSelect: true,
    question: "Where should the new headers be documented?",
    options: [
      { label: "OpenAPI spec", description: "Add the headers to every 2xx and 429 response in openapi.yaml" },
      { label: "Public docs site", description: "A new \"Rate limits\" page under docs/api/" },
      { label: "Changelog", description: "One entry in CHANGELOG.md" },
    ],
  },
];

export const RESEARCH_REPORT = `# How other harnesses notify the operator

**Question.** What do comparable agent harnesses do when a run needs a human, and what should Howdah copy?

## Findings

1. **Native notifications beat scripted ones.** Every tool surveyed that ships a desktop app uses the platform notification centre (UNUserNotificationCenter on macOS, the Notifications API in the browser) with a click action that deep-links to the ask. Tools that shell out to \`osascript\` show the *Script Editor* icon and cannot be clicked through.
2. **Sound is opt-in and short.** Where a sound exists it is under 400 ms, plays once per ask, and has a visible mute. Nobody loops.
3. **The inbox is the source of truth.** A badge count and a list survive a missed notification; the notification is only a nudge.

| Tool | Notification | Sound | Deep link |
|---|---|---|---|
| A | native (app) | optional, 1 short tone | yes |
| B | browser Notifications API | none | yes |
| C | terminal bell | bell | no |

## Recommendation
Use the browser Notifications API from the viewer (it is already open), keep the watchdog's OS notification as the fallback for a closed tab, and replace the three-note chime with a single short tone that is off by default.
`;
