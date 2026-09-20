; http4k: every `routes(...)` call — a route group whose arguments must all be binds.
(call_expression
  (identifier) @fn
  (value_arguments) @args
  (#eq? @fn "routes")) @call
