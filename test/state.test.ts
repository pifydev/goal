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
