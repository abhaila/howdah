# Mission: TypeSafe System One models (Jev)

## Why

Howdah routes real decisions — ship or reject, hop harness, fan out N runs — on values a
coding agent reported about its own work, with no uncertainty attached. Jev returns typed
answers with calibrated probabilities in ~100ms for ~nothing. I want to know the model well
enough to decide, with evidence rather than enthusiasm, which of Howdah's judgement calls
should become System One decisions — and to build the ones that should.

## Success looks like

- I can pick the right primitive (Choice / Score / Noul) for a decision without looking it up,
  and say why the other two are wrong.
- I can write a question that survives Jev's literal reading, and spot one that won't.
- I can read a `probabilities` distribution and decide what my code should do at that level of
  confidence, including "park and ask a human".
- I can look at a piece of Howdah and say which parts are System One, which are System Two,
  and which are neither and belong in plain code.
- I ship at least one Jev-backed decision in Howdah that measurably beats the regex it replaced.

## Constraints

- Learning happens inside the Howdah repo; examples must be real `file:line`, not toy tickets.
- `jev-1.13` limits are hard: 32k state, 255 Choice options, 2–10 Score levels, text only.
- No API key yet, so early lessons are design-and-reasoning, not live queries.
- Howdah runs on subscription CLIs offline; anything learned must survive "the API is down".

## Out of scope

- Training or fine-tuning models. Jev is consumed, not built.
- Replacing the coding harness. Jev cannot generate text; that question is closed.
- The broader calibration literature beyond what's needed to use `confidence` correctly.
