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
