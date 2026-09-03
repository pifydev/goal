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
```

A Codex-style footer indicator tracks the state: `🎯 Pursuing goal (5m 12s)` → `🎯 Goal achieved (23m)`.

## How it works

- **One goal per session**, persisted as session entries — it survives `/reload`, forks, branch switches, and compaction. Reopening a session with an active goal never auto-runs; the goal resumes after your next message.
- **Continuation at the settled boundary**: after queued work, retries, and compaction finish (`agent_settled`), the extension queues one hidden follow-up prompt. Nothing is injected into the system prompt, so the provider request prefix stays stable and **prompt caching keeps working**.
- **The user owns intent**: the agent has no tool to create or resume goals. It reports through three evidence-gated tools — `goal_complete` (requires a completion audit + evidence), `goal_blocked` (requires the same blocker recurring 3+ turns), `goal_wait` (external events). Your next message automatically reactivates a blocked/waiting goal.
- **Safety limits**: after 20 automatic turns without user input, or 3 consecutive tool-free turns with identical output (SHA-256 over normalized visible text), the goal pauses for review instead of looping.
- **Interrupts respected**: pressing Esc during a goal turn pauses the goal — the agent never barrels on after you grabbed the wheel.
- **Prompt injection hygiene**: the objective travels wrapped in `<untrusted_objective>` tags, XML-escaped, marked as data — it cannot escalate into instructions.
- **Usage accounting**: tokens and wall time per goal, shown in the footer, `/goal` status, and every continuation prompt.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
