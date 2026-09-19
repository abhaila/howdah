; React/TS: `x.get|post|put|patch|delete|head(url, …)` — axios / ky / a wrapped client.
; Filtered in code: Map.get("k") / params.get("id") are not HTTP calls.
(call_expression
  function: (member_expression
    object: (_) @recv
    property: (property_identifier) @method)
  arguments: (arguments) @args
  (#match? @method "^(get|post|put|patch|delete|head)$")) @call
