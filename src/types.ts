/**
 * Local structural types for @pify/goal.
 * No imports from pi packages: src/ typechecks and runs standalone so tests
 * execute under bun/node without a pi host.
 */

export const GOAL_STATUSES = ["active", "paused", "waiting", "blocked", "complete"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** Why a goal ended up paused; decides resume semantics and footer text. */
export type PauseCause = "user" | "turn-limit" | "no-progress" | "interrupt" | "budget-limit";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

import type { GoalStep } from "./steps.ts";

export interface Goal {
  id: string;
  objective: string;
  status: GoalStatus;
  tokensUsed: number;
  /** Optional hard token ceiling; continuation pauses when exceeded (v0.2). */
  tokenBudget: number | null;
  /** Ordered steps, when the objective was written as a list (v0.4). */
  steps: GoalStep[];
  timeUsedSeconds: number;
  /** Continuation turns since the last real user prompt (safety epoch). */
  automaticTurns: number;
  /** Consecutive tool-free turns with identical visible output. */
  toolFreeRepeatCount: number;
  /** Fingerprint of the last tool-free visible output. */
  lastFingerprint: string | null;
  createdAt: number;
  updatedAt: number;
  pauseCause?: PauseCause;
  blockedReason?: string;
  waitingReason?: string;
  completionSummary?: string;
  completedAt?: number;
}

/** Safety limits. Continuation stops and pauses the goal when either trips. */
export const MAX_AUTOMATIC_TURNS = 20;
export const NO_PROGRESS_LIMIT = 3;

/** Loose shape of a session branch entry, as returned by getBranch(). */
export interface BranchEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
