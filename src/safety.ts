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

/**
 * Errors a goal must stop on, versus errors it should ride out.
 *
 * A goal drives turns by itself, so an error the user has to fix turns into
 * an unattended retry loop: an expired key, an empty balance, or a model the
 * account cannot reach will fail identically on every continuation, forever,
 * and each attempt still costs a request. Transient failures — a rate limit,
 * an overloaded provider, a dropped connection — are exactly what a retry
 * loop is for, so they deliberately match nothing here.
 *
 * (The classification is from ilovepixelart/pi-code's /goal.)
 */
export type UnrecoverableKind =
  | "authentication"
  | "credits"
  | "context overflow"
  | "model unavailable";

const UNRECOVERABLE: ReadonlyArray<[UnrecoverableKind, RegExp]> = [
  [
    // "Incorrect API key provided: sk-…" is what OpenAI actually returns.
    "authentication",
    /\b40[13]\b|unauthori[sz]ed|authentication|(?:invalid|incorrect|expired|missing)\s+(?:api[ -]?)?key|x-api-key/i,
  ],
  ["credits", /\bcredits?\b|billing|insufficient[ _](?:funds|balance|quota)|payment required|\b402\b/i],
  [
    "context overflow",
    /context (?:window|length)|too (?:long|many tokens)|maximum (?:context|input) (?:length|tokens)/i,
  ],
  [
    "model unavailable",
    /model.*(?:not found|unavailable|does not exist|not available|unsupported)|no such model|not_found_error/i,
  ],
];

export function classifyUnrecoverable(message: string): UnrecoverableKind | null {
  if (!message) return null;
  return UNRECOVERABLE.find(([, pattern]) => pattern.test(message))?.[0] ?? null;
}

/** The error text carried by a turn's messages, if any. */
export function turnErrorMessage(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; stopReason?: string; errorMessage?: unknown } | null;
    if (!message || message.role !== "assistant") continue;
    if (message.stopReason !== "error") continue;
    return typeof message.errorMessage === "string" ? message.errorMessage : "unknown error";
  }
  return "";
}
