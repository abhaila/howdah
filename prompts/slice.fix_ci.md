---
id: slice.fix_ci
version: 1
tags: [implement-slice]
provenance: system-map 1c — delivery.fix_ci plus the approved ghost set and its drift (deliveryGraph verifyAfterRepair), composed by include
---
{{> delivery.fix_ci }}

{{> slice._design }}

If a CI failure can only be fixed by departing from the approved design, do not depart from it silently: fix what you can within the design and explain the conflict in `repair_summary` so the operator can redesign.
