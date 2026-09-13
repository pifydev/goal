# @pify/goal

[![npm version](https://img.shields.io/npm/v/@pify/goal)](https://www.npmjs.com/package/@pify/goal) [![npm downloads](https://img.shields.io/npm/dm/@pify/goal)](https://www.npmjs.com/package/@pify/goal)

Pin a session goal and keep [pi](https://github.com/earendil-works/pi) anchored to it. The agent is re-prompted at every settled idle boundary until the objective is genuinely achieved — with safety limits, usage accounting, and evidence-gated completion.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install goal`](https://github.com/pifydev/cli) or `pi install npm:@pify/goal`.

## Why

Long work drifts. The agent finishes the interesting part, reports something that sounds like completion, and stops — or it keeps going but slowly forgets what it was for. Both failures are the same failure: nothing is holding the objective except the conversation, and conversations get compacted.

A goal is that anchor. It lives in session entries rather than context, it is re-stated at every idle boundary, and it cannot be declared finished on the agent's say-so alone.

## Usage

```
/goal ship structured logging across the auth module   # set and start
/goal                                                  # status: objective, state, usage
/goal pause                                            # stop continuing
/goal resume                                           # continue, and reset the safety limits
/goal <new objective>                                  # supersede the objective mid-flight
/goal clear                                            # drop the goal
/goal budget 500k                                      # set a token ceiling (or `off`)
/goal audit on                                         # verify every completion claim
/goal steps                                            # progress through an ordered goal
```

A footer indicator tracks the state: `🎯 Pursuing goal (5m 12s)` → `🎯 Goal achieved (23m)`.

## The loop

**One goal per session**, persisted as session entries, so it survives `/reload`, forks, branch switches and compaction. Reopening a session with an active goal never auto-runs — the goal resumes after your next message.

Continuation happens at the **settled boundary**: once queued work, retries and compaction have all finished (`agent_settled`), the extension queues exactly one hidden follow-up prompt. Nothing is injected into the system prompt, so the provider request prefix stays stable and **prompt caching keeps working**.

## The user owns intent

The agent has no tool to create or resume a goal. It reports through evidence-gated tools:

| Tool | Requires |
|---|---|
| `goal_complete` | A completion audit against actual current state, plus the evidence inspected |
| `goal_step_done` | Evidence for the step just finished; advances the cursor one step, forward only |
| `goal_blocked` | The *same* blocker recurring for 3+ consecutive goal turns |
| `goal_wait` | An external event — CI, a human, a deployment — that no further work can accelerate |
| `goal_status` | Nothing; it just reads |

Your next message automatically reactivates a blocked or waiting goal.

## Ordered goals

Write the objective as a list — one step per line, or separated by `;` — and it is worked in order. Every continuation prompt marks which step is current, while the whole list stays visible because it is your objective. `goal_step_done(evidence)` advances the cursor, and `goal_complete` is refused while steps remain: an ordered goal is finished when its list is, not when the agent feels done with the interesting part.

Prose objectives are unaffected. A sentence with commas is not a plan, so it is never parsed as one.

## Independent completion audit

Opt in with `/goal audit on`. The agent that did the work is the worst judge of whether it is done, because it already believes it is.

With the audit on, every `goal_complete` claim is handed to a second agent with read-only tools, no extensions, and instructions to *disprove* the claim against the repository as it stands. A rejection keeps the goal active and hands the first agent a specific reason to fix.

An auditor that times out or answers unreadably is recorded as **inconclusive** and lets the completion through. A broken auditor must never be able to trap the agent in a loop it cannot exit.

## A token budget that measures work, not repetition

`/goal budget 500k` sets a ceiling. It counts what each turn *adds* — new input, cache writes, output — not the cached prefix the loop re-reads on every turn.

Counting those re-reads made the budget behave like a turn limit wearing a token limit's name. In a measured run (`test/live/budget-meter.mjs`) pi reported 238,196 tokens where the turns had actually added 16,168 — a factor of 14.7 — with each steady-state turn charging around 11,000 against the ceiling while adding about 250. Cached reads are still displayed, just not billed against the number you set.

**One wrap-up turn before the ceiling stops the loop.** At 90% the agent is told the budget is nearly gone and asked to finish or cleanly back out of whatever is half-done and say what remains — and explicitly *not* to declare completion because it ran out. The ceiling only ends the loop after that turn has happened, so a budget freeze leaves the work somewhere a person can pick it up.

## Safety

- **Errors that repeating cannot fix stop the goal.** A goal drives its own turns, so an expired key, an empty balance, a context overflow, or a model the account cannot reach would otherwise be retried on every continuation, forever, at the cost of a request each time. Those pause the goal with the reason. Rate limits, overloads and dropped connections deliberately do not — riding those out is what the loop is for.
- **Turn and progress limits.** After 20 automatic turns without user input, or 3 consecutive tool-free turns with identical output (SHA-256 over normalised visible text), the goal pauses for review instead of looping.
- **Interrupts respected.** Pressing Esc during a goal turn pauses the goal. The agent never barrels on after you grabbed the wheel.
- **Prompt-injection hygiene.** The objective travels wrapped in `<untrusted_objective>` tags, XML-escaped and marked as data, so it cannot escalate into instructions.
- **Scope fidelity.** The completion audit forbids redefining success around the work already done, or substituting a narrower deliverable because it is easier to verify.

## Usage accounting

Tokens and wall time per goal, shown in the footer, in `/goal` status, and in every continuation prompt — so the agent can pace itself rather than discovering the ceiling by hitting it.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
