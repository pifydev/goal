import type { Goal } from "./types.ts";

export function formatElapsedSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

/** Codex-style bottom-right footer text; undefined clears the indicator. */
export function footerText(goal: Goal | null): string | undefined {
  if (!goal) return undefined;
  switch (goal.status) {
    case "active":
      return goal.timeUsedSeconds > 0
        ? `🎯 Pursuing goal (${formatElapsedSeconds(goal.timeUsedSeconds)})`
        : "🎯 Pursuing goal";
    case "paused":
      return goal.pauseCause === "user"
        ? "🎯 Goal paused (/goal resume)"
        : `🎯 Goal paused: ${pauseCauseLabel(goal)} (/goal resume)`;
    case "waiting":
      return "🎯 Goal waiting for an external event";
    case "blocked":
      return "🎯 Goal blocked";
    case "complete":
      return `🎯 Goal achieved (${formatElapsedSeconds(goal.timeUsedSeconds)})`;
  }
}

function pauseCauseLabel(goal: Goal): string {
  switch (goal.pauseCause) {
    case "turn-limit":
      return "turn limit reached";
    case "budget-limit":
      return "token budget exhausted";
    case "no-progress":
      return "no progress detected";
    case "interrupt":
      return "interrupted";
    case "error":
      return "unrecoverable error";
    default:
      return "paused";
  }
}

/** Multi-line status block for /goal (status) and tool responses. */
export function statusBlock(goal: Goal | null): string {
  if (!goal) return "No goal set. Start one with /goal <objective>.";
  const lines = [
    `Objective: ${goal.objective}`,
    `Status: ${goal.status}${goal.pauseCause ? ` (${pauseCauseLabel(goal)})` : ""}`,
    // The budget counts what each turn added; cached re-reads are shown so the
    // two numbers never look like one of them is wrong.
    `Usage: ${formatTokenCount(goal.budgetTokensUsed)} tokens` +
      (goal.tokenBudget !== null ? ` / ${formatTokenCount(goal.tokenBudget)} budget` : "") +
      (goal.tokensUsed > goal.budgetTokensUsed
        ? ` (+${formatTokenCount(goal.tokensUsed - goal.budgetTokensUsed)} cached)`
        : "") +
      ` · ${formatElapsedSeconds(goal.timeUsedSeconds)}`,
  ];
  if (goal.blockedReason) lines.push(`Blocked: ${goal.blockedReason}`);
  if (goal.waitingReason) lines.push(`Waiting: ${goal.waitingReason}`);
  if (goal.completionSummary) lines.push(`Summary: ${goal.completionSummary}`);
  return lines.join("\n");
}
