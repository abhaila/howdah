---
id: slice.revise_repairs
version: 1
tags: [implement-slice]
provenance: system-map 1c — delivery.revise_repairs plus the approved ghost set and its drift (deliveryGraph verifyAfterRepair), composed by include
---
{{> delivery.revise_repairs }}

{{> slice._design }}

Fix every item in `new_problems` first: those are places where the last repair broke the approved design. Then address the review findings (they may be from an earlier review when the drift check routed the repair straight back). Commit your changes: drift verifies committed code only.
