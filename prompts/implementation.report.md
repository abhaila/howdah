---
id: implementation.report
version: 1
tags: [implement-ticket]
provenance: HOW-78 — the change map behind the run report. Howdah renders the report itself (core/run-report.ts) from this map and the run log, so it works on every harness and needs no hosted artifact
---
The build for this ticket has passed review. Before it is published, you will map the change so an engineer who has not read the diff can see what it does and where it lives. You do not change anything: you read the code and write down what you find.

User supplied goal:

{{ inputs.goal }}

Work scope:

{{ context.work }}

Implementation plan:

{{ context.implementation_plan }}

What the implementer says it did:

{{ context.implementation_summary }}

## Read the change

Find the commit this branch started from (`git merge-base HEAD origin/HEAD`, or the default branch's name in place of `HEAD` if that is not set) and read everything after it: `git log --stat <base>..HEAD`, then `git diff <base>..HEAD`. Open the files around each change until you can say what each part does and what calls it. Trust the code over the summary above; where they disagree, describe the code.

## Write the map

Return `change_map` as a JSON object with these fields:

- `title`: the change in a few words, as an engineer would name it ("Xero overpayment applications").
- `summary`: two to four plain sentences: what the system now does that it did not before, and why. No file names here.
- `components`: the five to twelve parts of the system this change touches or relies on, each as `{ "id", "label", "tag", "group", "status", "what", "how" }`:
  - `id`: a short unique slug (`recon`, `ledger`); `tag`: two to six capital letters drawn on the box (`RECON`, `API`).
  - `label`: its human name ("Overpayment applications").
  - `group`: the service, module or layer it belongs to ("invoices-api · payments"). Components in the same group are drawn in one lane, in the order you list them, so list each lane's components in the order a request reaches them.
  - `status`: `new` (added by this change), `changed` (edited by it), `reused` (unchanged, but the change depends on it) or `external` (outside this repository: a third-party API, a queue, another team's service).
  - `what`: one or two sentences on what it does.
  - `how`: a list of short bullets on where and how it changed, naming the file paths and the specific change ("`payments/Reconciler.kt`: compares the reported total with the held total and writes only the gap"). For a `reused` or `external` component, say why the change depends on it.
- `links`: how the components connect, as `{ "from", "to", "label", "dashed" }` using component ids, `from` being the caller. Set `"dashed": true` for an asynchronous or indirect dependency (a queue, a webhook, a scheduled job).
- `flow`: the path one request or event takes through the change, in order, as `{ "component", "text" }` — `text` is one short sentence, `component` the id it happens in.
- `risks`: up to four sentences naming what a reviewer should look hardest at, such as an edge case, a concurrency assumption or a migration. Leave it empty rather than inventing one.

Include only what the code shows. A component you could not find in the diff or around it does not belong on the map. Leave repository files and tracker records unchanged.
