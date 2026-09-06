# @pify/goal

Pin a session goal and keep [pi](https://github.com/earendil-works/pi) anchored to it. The agent is re-prompted at every settled idle boundary until the objective is genuinely achieved — with safety limits, usage accounting, and evidence-gated completion.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install goal`](https://github.com/pifydev/cli) or `pi install npm:@pify/goal`.

## Usage

```
/goal ship structured logging across the auth module   # set + start
/goal                                                  # status (objective, state, usage)
/goal pause                                            # stop continuation
/goal resume                                           # continue (also resets safety limits)
/goal <new objective>                                  # supersede the objective mid-flight
/goal clear                                            # drop the goal
/goal audit on                                         # verify every completion claim (v0.3)
/goal steps                                            # progress through an ordered goal (v0.4)
```

A Codex-style footer indicator tracks the state: `🎯 Pursuing goal (5m 12s)` → `🎯 Goal achieved (23m)`.

## How it works

- **One goal per session**, persisted as session entries — it survives `/reload`, forks, branch switches, and compaction. Reopening a session with an active goal never auto-runs; the goal resumes after your next message.
- **Continuation at the settled boundary**: after queued work, retries, and compaction finish (`agent_settled`), the extension queues one hidden follow-up prompt. Nothing is injected into the system prompt, so the provider request prefix stays stable and **prompt caching keeps working**.
- **The user owns intent**: the agent has no tool to create or resume goals. It reports through three evidence-gated tools — `goal_complete` (requires a completion audit + evidence), `goal_blocked` (requires the same blocker recurring 3+ turns), `goal_wait` (external events). Your next message automatically reactivates a blocked/waiting goal.
- **Sisyphus mode** (v0.4): write the objective as a list — one step per line, or separated by `;` — and the goal is worked in order. Every continuation prompt marks which step is current (the list itself stays visible — it is your objective), `goal_step_done(evidence)` advances the cursor one step forward and only forward, and `goal_complete` is refused while steps remain: an ordered goal is finished when its list is, not when the agent feels done with the interesting part. Prose objectives are unaffected — a sentence with commas is not a plan, so it is never parsed as one.
- **Independent completion audit** (v0.3, opt-in via `/goal audit on`): the agent that did the work is the worst judge of whether it is done — it already believes it is. With the audit on, every `goal_complete` claim is handed to a second agent with read-only tools, no extensions, and instructions to *disprove* the claim against the repository as it stands. A rejection keeps the goal active and hands the agent a specific reason to fix. An auditor that times out or answers unreadably is recorded as **inconclusive** and lets the completion through — a broken auditor must never be able to trap the agent in a loop it cannot exit.
- **Safety limits**: after 20 automatic turns without user input, or 3 consecutive tool-free turns with identical output (SHA-256 over normalized visible text), the goal pauses for review instead of looping.
- **Interrupts respected**: pressing Esc during a goal turn pauses the goal — the agent never barrels on after you grabbed the wheel.
- **Prompt injection hygiene**: the objective travels wrapped in `<untrusted_objective>` tags, XML-escaped, marked as data — it cannot escalate into instructions.
- **Usage accounting**: tokens and wall time per goal, shown in the footer, `/goal` status, and every continuation prompt.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
