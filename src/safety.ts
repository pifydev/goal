import { createHash } from "node:crypto";
import { isRecord, type Goal } from "./types.ts";

/**
 * No-progress detection (ported from @narumitw/pi-goal): a turn that attempts
 * no tools and produces the same visible output as the previous tool-free
 * turn is counted as a repeat; N repeats in a row pauses the goal.
 */

export function hasAssistantToolCall(messages: readonly unknown[]): boolean {
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    if (message.content.some((block) => isRecord(block) && block.type === "toolCall")) return true;
  }
  return false;
}

export function normalizeVisibleAssistantOutput(messages: readonly unknown[]): string {
  const text: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
      text.push(block.text);
    }
  }
  const normalized = text
    .join("\n")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
  // Pure punctuation/whitespace output counts as empty (always a repeat).
  return normalized === "" || /^[\p{P}\s]+$/u.test(normalized) ? "" : normalized;
}

export function fingerprintVisibleAssistantOutput(messages: readonly unknown[]): string {
  return createHash("sha256")
    .update(normalizeVisibleAssistantOutput(messages), "utf8")
    .digest("hex");
}

/** Fold one finished turn into the goal's no-progress counters. */
export function noteTurnProgress(goal: Goal, messages: readonly unknown[]): Goal {
  if (hasAssistantToolCall(messages)) {
    return { ...goal, toolFreeRepeatCount: 0, lastFingerprint: null };
  }
  const fingerprint = fingerprintVisibleAssistantOutput(messages);
  return {
    ...goal,
    toolFreeRepeatCount: fingerprint === goal.lastFingerprint ? goal.toolFreeRepeatCount + 1 : 1,
    lastFingerprint: fingerprint,
  };
}
