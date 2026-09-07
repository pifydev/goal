import { isRecord, type TokenUsage } from "./types.ts";

/**
 * Per-turn token accounting (ported from code-yeongyu/pi-goal): usage is
 * collected from assistant message_end events during the turn; at agent_end
 * the authoritative run messages reconcile anything the stream missed.
 */

const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

/**
 * What a token budget should actually measure.
 *
 * pi reports `totalTokens = input + output + cacheRead + cacheWrite`, and a
 * goal loop re-reads its whole cached prefix on every single turn. Counting
 * cached reads therefore measures the conversation's length multiplied by the
 * number of turns, not the work done: a 30k-token context burns "500k tokens"
 * in about fifteen turns while the provider charges roughly a tenth of that.
 * A budget that behaves like a turn limit and calls itself a token limit is
 * worse than no budget, because the number the user typed means nothing.
 *
 * So the meter counts what a turn genuinely adds — new input, cache writes,
 * and output. Cached reads are still reported to the user, just not charged
 * against the ceiling they set.
 */
export function billableTokens(usage: TokenUsage): number {
  const billable = usage.input + usage.output + usage.cacheWrite;
  // Providers that report only a total (no breakdown) still have to count for
  // something, or their budgets would never move.
  if (billable === 0 && usage.cacheRead === 0) return Math.max(0, usage.totalTokens);
  return Math.max(0, billable);
}

export function collectAssistantUsage(messages: readonly unknown[]): TokenUsage {
  const usage = emptyUsage();
  for (const message of messages) addAssistantMessageUsage(usage, message);
  return usage;
}

export class TurnUsageTracker {
  private pending = emptyUsage();
  private flushed = emptyUsage();

  reset(): void {
    this.pending = emptyUsage();
    this.flushed = emptyUsage();
  }

  noteMessageEnd(message: unknown): void {
    addAssistantMessageUsage(this.pending, message);
  }

  takePending(): TokenUsage {
    const taken = this.pending;
    this.pending = emptyUsage();
    for (const field of USAGE_FIELDS) this.flushed[field] += taken[field];
    return taken;
  }

  /** Reconcile against the full run's messages, counting only the delta. */
  takeRemaining(agentRunMessages: readonly unknown[]): TokenUsage {
    const collected = collectAssistantUsage(agentRunMessages);
    const remaining = emptyUsage();
    for (const field of USAGE_FIELDS) {
      remaining[field] = Math.max(0, collected[field] - this.flushed[field]);
      this.flushed[field] = Math.max(this.flushed[field], collected[field]);
    }
    this.pending = emptyUsage();
    return remaining;
  }
}

function addAssistantMessageUsage(target: TokenUsage, message: unknown): void {
  if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) return;
  for (const field of USAGE_FIELDS) {
    const value = message.usage[field];
    if (typeof value === "number" && Number.isFinite(value)) target[field] += value;
  }
}
