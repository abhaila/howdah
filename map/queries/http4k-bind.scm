; http4k: every `<path> bind <target>` infix call (system-map 1b, http4k adapter).
; Kept to one pattern per file: combined queries silently dropped matches in the spike.
(infix_expression
  .
  (_) @path
  .
  (identifier) @op
  .
  (_) @target
  .
  (#eq? @op "bind")) @bind
