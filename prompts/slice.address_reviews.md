---
id: slice.address_reviews
version: 1
tags: [implement-slice]
provenance: system-map 1c — delivery.address_reviews plus the approved ghost set and its drift (deliveryGraph verifyAfterRepair), composed by include
---
{{> delivery.address_reviews }}

{{> slice._design }}

If a reviewer asks for a change that departs from the approved design, do not make it silently: explain the conflict in the thread and in `repair_summary` so the operator can redesign.
