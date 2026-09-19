---
id: slice.review_repairs
version: 1
tags: [implement-slice]
provenance: system-map 1c — delivery.review_repairs plus the approved ghost set and its drift (deliveryGraph verifyAfterRepair), composed by include
---
{{> delivery.review_repairs }}

{{> slice._design }}

Also judge the repair against the approved design above: reject any repair that introduced a `new_problems` drift item, and any `unexpected` change outside the work scope. `not-checked` items are gaps in the map, not defects — check those parts by reading the code.
