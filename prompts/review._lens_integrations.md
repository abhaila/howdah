---
id: review._lens_integrations
version: 1
tags: [review-panel, partial]
provenance: review panel lens (after Orbital's implement-epic-with-panel review-integrations); a partial, never run on its own; included by review._panel
---
You review the change's boundaries: calls to other services, APIs, queues, databases, files and other modules, and the contracts others call in through. Reject each of these:

- "Cannot tell" collapsed into "missing" or "none", so a failed lookup, a timeout or an error looks like an answer.
- An error swallowed, logged and dropped, or turned into a default value that the caller then acts on.
- A call with no timeout, or a retry with no bound, no backoff or no idempotency key.
- A partial or paginated response treated as complete.
- A null, empty or unknown value from the other side that the code does not handle, where the other side's contract allows it.
- A contract the change alters (an API schema, an event payload, a column, a public function) without updating every caller, or in a way existing clients or stored data cannot read.
- An identifier from one system used as if it were another's, or compared across systems without mapping.

Every finding needs a concrete failure: what the other side returns or does, and the wrong result the code produces from it. If the change does not touch a boundary, return an empty array.
