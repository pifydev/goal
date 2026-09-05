import {
  MAX_AUTOMATIC_TURNS,
  NO_PROGRESS_LIMIT,
  isRecord,
  type BranchEntryLike,
  type Goal,
  type PauseCause,
  type TokenUsage,
} from "./types.ts";

export const GOAL_STATE = "goal-state";

/** Pure state transitions. Every mutation returns a new Goal (or null). */

export function createGoal(objective: string, now: number, id: string): Goal {
  return {
    id,
    objective,
    status: "active",
    tokensUsed: 0,
    tokenBudget: null,
    timeUsedSeconds: 0,
    automaticTurns: 0,
    toolFreeRepeatCount: 0,
    lastFingerprint: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Editing the objective supersedes the old one and resets the safety epoch. */
export function editObjective(goal: Goal, objective: string, now: number): Goal {
  return {
    ...resetSafetyEpoch(goal),
    objective,
    status: "active",
    pauseCause: undefined,
    blockedReason: undefined,
    waitingReason: undefined,
    updatedAt: now,
  };
}

export function pauseGoal(goal: Goal, cause: PauseCause, now: number): Goal {
  return { ...goal, status: "paused", pauseCause: cause, updatedAt: now };
}

export function resumeGoal(goal: Goal, now: number): Goal {
  return {
    ...resetSafetyEpoch(goal),
    status: "active",
    pauseCause: undefined,
    blockedReason: undefined,
    waitingReason: undefined,
    updatedAt: now,
  };
}

export function blockGoal(goal: Goal, reason: string, now: number): Goal {
  return { ...goal, status: "blocked", blockedReason: reason, updatedAt: now };
}

export function waitGoal(goal: Goal, reason: string, now: number): Goal {
  return { ...goal, status: "waiting", waitingReason: reason, updatedAt: now };
}

export function completeGoal(goal: Goal, summary: string, now: number): Goal {
  return {
    ...goal,
    status: "complete",
    completionSummary: summary,
    completedAt: now,
    updatedAt: now,
  };
}

export function accountUsage(goal: Goal, usage: TokenUsage, elapsedSeconds: number, now: number): Goal {
  return {
    ...goal,
    tokensUsed: goal.tokensUsed + Math.max(0, usage.totalTokens),
    timeUsedSeconds: goal.timeUsedSeconds + Math.max(0, elapsedSeconds),
    updatedAt: now,
  };
}

/** A real user prompt starts a fresh safety epoch. */
export function resetSafetyEpoch(goal: Goal): Goal {
  return {
    ...goal,
    automaticTurns: 0,
    toolFreeRepeatCount: 0,
    lastFingerprint: null,
  };
}

export function noteAutomaticTurn(goal: Goal): Goal {
  return { ...goal, automaticTurns: goal.automaticTurns + 1 };
}

export type SafetyVerdict =
  | { ok: true }
  | { ok: false; cause: Extract<PauseCause, "turn-limit" | "no-progress" | "budget-limit">; detail: string };

/** Set or clear the token budget on a goal. */
export function setBudget(goal: Goal, budget: number | null, now: number): Goal {
  return { ...goal, tokenBudget: budget, updatedAt: now };
}

/** Check the safety limits BEFORE queueing another automatic continuation. */
export function checkSafety(goal: Goal): SafetyVerdict {
  if (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
    return {
      ok: false,
      cause: "budget-limit",
      detail: `token budget exhausted (${goal.tokensUsed} of ${goal.tokenBudget} tokens)`,
    };
  }
  if (goal.automaticTurns >= MAX_AUTOMATIC_TURNS) {
    return {
      ok: false,
      cause: "turn-limit",
      detail: `${goal.automaticTurns} automatic turns without user input`,
    };
  }
  if (goal.toolFreeRepeatCount >= NO_PROGRESS_LIMIT) {
    return {
      ok: false,
      cause: "no-progress",
      detail: `${goal.toolFreeRepeatCount} consecutive turns with no tools and identical output`,
    };
  }
  return { ok: true };
}

/**
 * Rebuild goal state from the branch: last goal-state entry wins.
 * Snapshot-based (not event-sourced) so replay is trivial and branch
 * switches / forks / compaction all resolve to the right state.
 */
export function replayBranch(entries: BranchEntryLike[]): Goal | null {
  let goal: Goal | null = null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== GOAL_STATE) continue;
    const data = entry.data;
    if (data === null) {
      goal = null;
      continue;
    }
    if (isRecord(data) && typeof data.id === "string" && typeof data.objective === "string") {
      goal = data as unknown as Goal;
    }
  }
  return goal;
}
