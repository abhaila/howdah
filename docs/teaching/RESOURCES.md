# TypeSafe System One (Jev) Resources

## Knowledge

- [Introducing System One Models & Jev — TypeSafe blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
  The launch post: what a System One model is, RLCD, the speed/cost claims and their caveats.
  Use for: the thesis and the benchmark numbers, read with the stated biases in mind.
- [Primitives (Questions)](https://docs.typesafe.ai/primitives.md)
  Choice, Score and Noul; what each returns; asking several at once. Use for: picking a primitive.
- [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)
  The nine documented failure modes, each with a "do this instead". Use for: before writing any
  question, and when an answer is wrong and you can't see why. The highest-value page in the docs.
- [Confidence](https://docs.typesafe.ai/confidence.md)
  How `confidence` is derived from `probabilities`, and the three-band routing pattern.
  Use for: choosing thresholds; understanding why calibration is a population property.
- [API reference](https://docs.typesafe.ai/api.md)
  Exact request/response fields and limits. Use for: writing the client, checking a field name.
- [Models](https://docs.typesafe.ai/models.md)
  Context window, rate limits, pricing, aliases. Use for: sizing a state, budgeting.
- [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md)
  The "AI-powered software" architecture: code owns control flow, the model makes narrow calls.
  Use for: deciding what should NOT be a model call.
- [Cookbooks index](https://docs.typesafe.ai/cookbooks.md)
  Worked end-to-end recipes. Use for: a pattern close to a problem you already have.
- [Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents.md)
  Short and load-bearing: Jev is not a coding-agent LLM. Use for: resetting expectations.

## Wisdom (Communities)

- [TypeSafe Discord](https://discord.com/invite/WUujKYBp8s)
  The vendor's own channel; the jaggedness page explicitly solicits new failure modes here.
  Use for: checking whether a failure you found is known, and reporting one that isn't.

## Gaps

- No independent (non-vendor) evaluation of Jev's calibration found. Every number so far is
  TypeSafe's own, on TypeSafe's own workflows, with biases they disclose. Treat accordingly.
- No worked example of a System One model inside an agent ORCHESTRATOR (as opposed to inside
  an app). Howdah may have to be its own first reference.
