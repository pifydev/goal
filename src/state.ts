import { parseSteps, type GoalStep } from "./steps.ts";
import { billableTokens } from "./usage.ts";
import {
  BUDGET_WARN_RATIO,
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
    budgetTokensUsed: 0,
    budgetWarned: false,
    tokenBudget: null,
    steps: parseSteps(objective),
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
    // A replaced objective replaces its plan: keeping half-ticked steps from
    // the old one would drive the agent through work nobody asked for again.
    steps: parseSteps(objective),
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
    budgetTokensUsed: goal.budgetTokensUsed + billableTokens(usage),
    timeUsedSeconds: goal.timeUsedSeconds + Math.max(0, elapsedSeconds),
    updatedAt: now,
  };
}

/** Fraction of the budget spent, or null when no budget is set. */
export function budgetRatio(goal: Goal): number | null {
  if (goal.tokenBudget === null || goal.tokenBudget <= 0) return null;
  return goal.budgetTokensUsed / goal.tokenBudget;
}

export function noteBudgetWarned(goal: Goal): Goal {
  return { ...goal, budgetWarned: true };
}

/**
 * True when this turn should be the one that tells the agent to wrap up.
 * Fires once, at 90% — late enough that most goals never see it, early enough
 * that there is room to leave the work somewhere a person can pick it up.
 */
export function needsBudgetWarning(goal: Goal): boolean {
  const ratio = budgetRatio(goal);
  return ratio !== null && ratio >= BUDGET_WARN_RATIO && !goal.budgetWarned;
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
  // The budget only ends the loop after the agent has been told it is nearly
  // gone. Cutting a run off at the ceiling with no warning leaves the work in
  // whatever state the last turn happened to reach; one wrap-up turn is the
  // difference between "stopped" and "stopped somewhere usable".
  const ratio = budgetRatio(goal);
  if (ratio !== null && ratio >= 1 && goal.budgetWarned) {
    return {
      ok: false,
      cause: "budget-limit",
      detail: `token budget exhausted (${goal.budgetTokensUsed} of ${goal.tokenBudget} billable tokens)`,
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
      // Snapshots written before v0.4 have no steps array; every read of
      // goal.steps assumes one, so fill it in rather than crash on replay.
      const restored = data as unknown as Goal;
      goal = {
        ...restored,
        steps: Array.isArray(restored.steps) ? restored.steps : [],
        // Snapshots written before v0.6 metered the budget with every token
        // the provider reported. Carrying that number over keeps their meter
        // where it was rather than silently handing them a fresh allowance.
        budgetTokensUsed:
          typeof restored.budgetTokensUsed === "number" ? restored.budgetTokensUsed : restored.tokensUsed,
        budgetWarned: restored.budgetWarned === true,
      };
    }
  }
  return goal;
}

/** Record a finished step on the goal (Sisyphus mode, v0.4). */
export function setSteps(goal: Goal, steps: GoalStep[], now: number): Goal {
  return { ...goal, steps, updatedAt: now };
}
