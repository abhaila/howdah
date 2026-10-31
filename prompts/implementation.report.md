---
id: implementation.report
version: 2
tags: [implement-ticket]
provenance: HOW-78 — the change map behind the run report. Howdah renders the report itself (core/run-report.ts) from this map and the run log, so it works on every harness and needs no hosted artifact. v2 asks for what the page is built around — the request path through the change, what each part does, how each part is built, and a worked example — after v1's report read as run bookkeeping
---
The build for this ticket has passed review. Before it is published, you will map the change so an engineer who has not read the diff can see how it works: which parts of the system it touches, the path a request takes through them, what each part does, and how each part was built. Howdah draws your map as an interactive system diagram — lanes of components, a token that travels the request path step by step, and a panel per component with "What it does" and "How it's built". You do not change anything: you read the code and write down what you find.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

Implementation plan:

{{ context.implementation_plan }}

What the implementer says it did:

{{ context.implementation_summary }}

## Read the change

Find the commit this branch started from (`git merge-base HEAD origin/HEAD`, or the default branch's name in place of `HEAD` if that is not set) and read everything after it: `git diff --shortstat <base>..HEAD`, `git log --stat <base>..HEAD`, then `git diff <base>..HEAD`. Open the files around each change until you can say what each part does, what calls it and what it calls. Trust the code over the summary above; where they disagree, describe the code.

## Write the map

Return `change_map` as a JSON object with these fields:

- `title`: the change in a few words, as an engineer would name it ("Xero overpayment applications").
- `summary`: two to four plain sentences: what the system now does that it did not before, and why. No file names here.
- `flow_name`: what one pass along the flow is called, in a few words ("One invoice update", "Saving a customer address").
- `diff`: `{ "files", "additions", "deletions" }` from `git diff --shortstat`.
- `components`: the five to twelve parts of the system the change touches or relies on, each as an object with:
  - `id`: a short unique slug (`recon`, `ledger`); `tag`: two to six capital letters drawn on the box (`RECON`, `API`).
  - `label`: its human name ("Overpayment applications").
  - `kind`: what sort of thing it is, in a few words ("INVOICE UPDATE webhook", "React form hook", "Postgres table").
  - `group`: the service, module or layer it belongs to ("invoices-api · payments"). Each group is drawn as one lane, in the order groups first appear, so list components in the order a request reaches them.
  - `status`: `new` (added by this change), `changed` (edited by it), `reused` (unchanged, but the change depends on it) or `external` (outside this repository: a third-party API, a queue, another team's service).
  - `what`: its responsibility, in one to three sentences — what it is for, whatever this change did to it.
  - `in_flow`: one or two sentences on what it does in the flow below, specific to this change ("Compares the total Xero reports with what the ledger holds and passes on only the difference"). Leave it out for a component the flow does not pass through.
  - `how`: how it is built and how this change built it — a list of short bullets naming the file paths in backticks and the specific change ("`payments/Reconciler.kt`: new; compares reported and held totals and writes only the gap", "`InvoiceTask.kt`: now reads `Overpayments[]` before grouping by tenant"). For a `reused` or `external` component, one bullet on what the change relies on it for.
- `links`: how the components connect, as `{ "from", "to", "label", "dashed" }` using component ids, `from` being the caller. Set `"dashed": true` for an asynchronous or indirect dependency (a queue, a webhook, a scheduled job).
- `flow`: the path one request or event takes through the change, in order, four to ten steps, each `{ "component", "text" }` — `text` is one short sentence of what happens at that step, `component` the id it happens in. This is the spine of the page: the reader steps through it on the diagram.
- `example`: a worked example a reviewer can check against the code — `{ "title", "body", "steps", "outcome" }`: `title` names the scenario ("One 809.50 overpayment, five updates"), `body` sets it up in one or two sentences, `steps` are the concrete inputs in order ("Xero: 300.00 applied to invoice A"), and `outcome` is `{ "label", "body" }` — what the system does with them, with `label` a short code or state name from the code when one exists (`IN_SYNC`). Choose the case that best shows the change's core rule, including an edge case when there is one.
- `risks`: up to four sentences naming what a reviewer should look hardest at, such as an edge case, a concurrency assumption or a migration. Leave it empty rather than inventing one.

Include only what the code shows. A component you could not find in the diff or around it does not belong on the map, and a step you cannot point to in the code does not belong in the flow. Leave repository files and tracker records unchanged.
