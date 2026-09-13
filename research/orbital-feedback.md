# Orbital feedback — Areeb, captured 2026-09-12

Verbatim from the feedback doc, grouped. Original was a two-column
Question/Comment + Evidence/Context table.

## A. Observability of a long-running agent (7 of 15 items — the dominant theme)

- The turn delta in the debug steps is noisy and for some reason cuts the text across many lines
- Quick button to scroll down to the bottom of steps on a long run
- Sometimes in a review process, I just lose the agent for like 1hr 2hr and its really hard to
  work out what's going on in the review process. The process delta is not helpful due to being
  broken down
- Context tab in steps never shows anything
- Doesn't tell you when its out of tokens - doesn't offer to change model
- Some sense of where commits are e.g. whats not committed, committed, pushed etc
- Got a need attention - Not obvious where to add answer

## B. Recorded state drifts from reality (3 items, one root cause)

- For Sequence-Web didn't record the PR because I requested for a different branch name so when
  reviews came in - just bugged out saying I can't find the PR. Even though it was in its output
- When you request a suggested branch name - and then it does implement it. It doesn't update its
  record of branch - So PR reviews are broken as looking for reviews against the original branch
  name which is orbital/{id}
- Clean up pending always fails

## C. Model and config ergonomics

- Being able to use models from dropdowns or some guidance on where to get specific type names
  from (currently just full text)
- Doesn't tell you when its out of tokens - doesn't offer to change model

## D. Conceptual clarity

- What is the difference between goal and input.work. Do you just put the linear prompt in
  the input.work?

## E. Integrations and ergonomics

- Being able to set up your IDE command to be able to open the worktree with a single button
- Would be nice to have customised tools like Slack, Notion or Drive

## F. Trust

- How is the data stored? Will it save it locally?

---

## Reading

**The dominant complaint is not features, it is not being able to see what the agent is
doing.** Seven of fifteen items are observability. The sharpest one is losing an agent for
one to two hours inside a review with no way to tell what is happening.

**The second cluster is one bug wearing three hats.** Branch name is recorded at worktree
creation and never reconciled with what the agent actually did. Everything downstream that
keys off it (PR lookup, review fetch, cleanup) then fails, and fails confusingly, because the
correct value is visible in the agent's own output. The system trusts its own record over
observable reality.

**Notably absent: anything about prompts.** Nothing in this doc asks for prompt editing,
versioning or improvement. That is the stated design goal for the new harness, and it does not
appear in the lived complaints at all. Worth reconciling before designing around it.

**The bridge between them:** prompts are templated from context (`{{ context.work }}`), the
Context tab never shows anything, and goal vs inputs.work is unclear. So you cannot see what a
prompt rendered to, with what inputs. Improving a prompt from feedback requires exactly that
visibility first. Observability is a prerequisite for prompt improvement, not a competing
priority.
