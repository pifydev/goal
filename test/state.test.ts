import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GOAL_STATE,
  accountUsage,
  blockGoal,
  checkSafety,
  completeGoal,
  createGoal,
  editObjective,
  noteAutomaticTurn,
  pauseGoal,
  replayBranch,
  resumeGoal,
  waitGoal,
} from "../src/state.ts";
import { MAX_AUTOMATIC_TURNS, NO_PROGRESS_LIMIT, type Goal } from "../src/types.ts";
import { emptyUsage } from "../src/usage.ts";

const NOW = 1_000_000;

function goal(overrides: Partial<Goal> = {}): Goal {
  return { ...createGoal("ship the feature", NOW, "g1"), ...overrides };
}

test("createGoal starts active with zeroed counters", () => {
  const g = createGoal("obj", NOW, "id");
  assert.equal(g.status, "active");
  assert.equal(g.tokensUsed, 0);
  assert.equal(g.automaticTurns, 0);
  assert.equal(g.toolFreeRepeatCount, 0);
});

test("pause/resume round-trip clears cause and resets the safety epoch", () => {
  const paused = pauseGoal(goal({ automaticTurns: 15 }), "turn-limit", NOW + 1);
  assert.equal(paused.status, "paused");
  assert.equal(paused.pauseCause, "turn-limit");
  const resumed = resumeGoal(paused, NOW + 2);
  assert.equal(resumed.status, "active");
  assert.equal(resumed.pauseCause, undefined);
  assert.equal(resumed.automaticTurns, 0);
});

test("blocked and waiting keep their reasons; resume clears them", () => {
  const blocked = blockGoal(goal(), "missing API key", NOW);
  assert.equal(blocked.blockedReason, "missing API key");
  const waiting = waitGoal(goal(), "CI run #42", NOW);
  assert.equal(waiting.waitingReason, "CI run #42");
  const resumed = resumeGoal(blocked, NOW);
  assert.equal(resumed.blockedReason, undefined);
});

test("editObjective supersedes, reactivates, and resets the epoch", () => {
  const edited = editObjective(
    pauseGoal(goal({ automaticTurns: 9 }), "user", NOW),
    "new objective",
    NOW + 5,
  );
  assert.equal(edited.objective, "new objective");
  assert.equal(edited.status, "active");
  assert.equal(edited.automaticTurns, 0);
});

test("completeGoal records summary and timestamp", () => {
  const done = completeGoal(goal(), "shipped it", NOW + 9);
  assert.equal(done.status, "complete");
  assert.equal(done.completionSummary, "shipped it");
  assert.equal(done.completedAt, NOW + 9);
});

test("accountUsage accumulates tokens and seconds, never negative", () => {
  const used = accountUsage(goal(), { ...emptyUsage(), totalTokens: 500 }, 12, NOW);
  assert.equal(used.tokensUsed, 500);
  assert.equal(used.timeUsedSeconds, 12);
  const again = accountUsage(used, { ...emptyUsage(), totalTokens: -5 }, -3, NOW);
  assert.equal(again.tokensUsed, 500);
  assert.equal(again.timeUsedSeconds, 12);
});

test("checkSafety trips at the automatic-turn ceiling", () => {
  assert.deepEqual(checkSafety(goal({ automaticTurns: MAX_AUTOMATIC_TURNS - 1 })), { ok: true });
  const verdict = checkSafety(goal({ automaticTurns: MAX_AUTOMATIC_TURNS }));
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.cause, "turn-limit");
});

test("checkSafety trips at the no-progress limit", () => {
  const verdict = checkSafety(goal({ toolFreeRepeatCount: NO_PROGRESS_LIMIT }));
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.cause, "no-progress");
});

test("noteAutomaticTurn increments the epoch counter", () => {
  assert.equal(noteAutomaticTurn(goal()).automaticTurns, 1);
});

test("replayBranch: last snapshot wins; null clears; junk skipped", () => {
  const g1 = goal({ id: "a" });
  const g2 = goal({ id: "b", status: "paused" });
  const entries = [
    { type: "custom", customType: GOAL_STATE, data: g1 },
    { type: "message" },
    { type: "custom", customType: GOAL_STATE, data: { bogus: true } },
    { type: "custom", customType: "other", data: g1 },
    { type: "custom", customType: GOAL_STATE, data: g2 },
  ];
  const restored = replayBranch(entries);
  assert.equal(restored?.id, "b");
  assert.equal(restored?.status, "paused");

  const cleared = replayBranch([
    { type: "custom", customType: GOAL_STATE, data: g1 },
    { type: "custom", customType: GOAL_STATE, data: null },
  ]);
  assert.equal(cleared, null);
});

test("the budget warns once, then stops on the next turn past the ceiling", async () => {
  const { setBudget, needsBudgetWarning, noteBudgetWarned } = await import("../src/state.ts");
  let g = goal({ tokensUsed: 400_000, budgetTokensUsed: 400_000 });
  assert.equal(g.tokenBudget, null);
  assert.deepEqual(checkSafety(g), { ok: true });
  assert.equal(needsBudgetWarning(g), false, "no budget, nothing to warn about");

  g = setBudget(g, 500_000, NOW);
  assert.deepEqual(checkSafety(g), { ok: true });
  // 80% is not yet the deadline.
  assert.equal(needsBudgetWarning(g), false);

  g = accountUsage(g, { ...emptyUsage(), totalTokens: 60_000 }, 0, NOW);
  assert.equal(needsBudgetWarning(g), true, "92% asks for the wrap-up turn");

  g = accountUsage(g, { ...emptyUsage(), totalTokens: 100_000 }, 0, NOW);
  // Over the ceiling, but the agent was never told — cutting it off here
  // freezes the work wherever the last turn happened to end.
  assert.equal(checkSafety(g).ok, true, "past the ceiling still runs one wrap-up turn");
  assert.equal(needsBudgetWarning(g), true);

  g = noteBudgetWarned(g);
  assert.equal(needsBudgetWarning(g), false, "the warning is sent once, not every turn");
  const verdict = checkSafety(g);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.cause, "budget-limit");
    assert.ok(verdict.detail.includes("560000 of 500000"));
  }

  assert.equal(checkSafety(setBudget(g, null, NOW)).ok, true);
});

test("cached reads are reported but not charged against the budget", () => {
  // A goal loop re-reads its whole cached prefix every turn. Counting that
  // made a 500k budget behave like a turn limit.
  let g = goal({ tokenBudget: 500_000 });
  const turn = { input: 800, output: 1_200, cacheRead: 40_000, cacheWrite: 0, totalTokens: 42_000 };
  for (let i = 0; i < 10; i++) g = accountUsage(g, turn, 1, NOW);

  assert.equal(g.tokensUsed, 420_000, "the user still sees every token");
  assert.equal(g.budgetTokensUsed, 20_000, "the meter counts what the turns added");
  assert.equal(checkSafety(g).ok, true, "ten cheap turns do not exhaust a 500k budget");
});

test("a provider that reports only a total still moves the meter", () => {
  const g = accountUsage(goal(), { ...emptyUsage(), totalTokens: 9_000 }, 0, NOW);
  assert.equal(g.budgetTokensUsed, 9_000);
});

test("goals saved before the split keep the meter where it was", () => {
  // Restarting their allowance at zero would quietly hand them a second budget.
  const before = { ...goal({ tokensUsed: 300_000, tokenBudget: 400_000 }) } as Record<string, unknown>;
  delete before.budgetTokensUsed;
  delete before.budgetWarned;
  const restored = replayBranch([
    { type: "custom", customType: GOAL_STATE, data: before } as never,
  ]);
  assert.equal(restored?.budgetTokensUsed, 300_000);
  assert.equal(restored?.budgetWarned, false);
});
