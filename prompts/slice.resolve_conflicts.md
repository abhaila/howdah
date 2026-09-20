---
id: slice.resolve_conflicts
version: 1
tags: [implement-slice]
provenance: system-map 1c — delivery.resolve_conflicts plus the approved ghost set and its drift (deliveryGraph verifyAfterRepair), composed by include
---
{{> delivery.resolve_conflicts }}

{{> slice._design }}

When resolving conflicts, keep the approved design intact: a resolution that drops an `add` / `modify` ghost or changes a `keep` ghost is a new drift problem.
