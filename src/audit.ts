/**
 * Independent completion audit (tmonk's idea): before a goal is marked
 * achieved, a second agent re-checks the claim against the repository with
 * read-only tools. The agent that did the work is the worst judge of whether
 * it is done — it already believes it is.
 *
 * Pure prompt building and verdict parsing live here so both are testable
 * without an LLM; the session wiring is in extensions/goal.ts.
 */

export type AuditOutcome = "pass" | "fail" | "inconclusive";

export interface AuditVerdict {
  outcome: AuditOutcome;
  reason: string;
}

export const AUDIT_SYSTEM_PROMPT = [
  "You are an independent completion auditor. Another agent claims it finished a goal.",
  "Your job is to disprove that claim, not to confirm it.",
  "Use the read-only tools (read, grep, find, ls) to check the evidence against the actual",
  "current state of the repository. Evidence that only describes intent, restates the goal,",
  "or cites work you cannot verify does not count.",
  'Answer with ONE line of JSON and nothing else: {"verdict":"pass","reason":"…"}',
  'or {"verdict":"fail","reason":"…"}. Keep the reason under 300 characters and make it',
  "actionable: say what is missing or unverified.",
].join(" ");

/** Untrusted text is fenced so an objective cannot rewrite the instructions. */
function fence(label: string, body: string): string {
  return [`<${label}>`, body.trim(), `</${label}>`].join("\n");
}

export function buildAuditPrompt(objective: string, summary: string, evidence: string): string {
  return [
    "Audit this completion claim.",
    "",
    fence("goal", objective),
    "",
    fence("claimed_summary", summary),
    "",
    fence("claimed_evidence", evidence),
    "",
    "Verify the claim against the repository as it is right now. Then answer with the JSON line.",
  ].join("\n");
}

const MAX_REASON = 300;

const FAIL_WORDS =
  /\b(fail(s|ed|ure|ing)?|invalid|incorrect|unverified|unsubstantiated|rejected|inaccurate|missing|absent|no such|does not (exist|contain|include)|not (found|verified|confirmed|present|implemented))\b/i;
const PASS_WORDS = /\b(pass(es|ed|ing)?|valid|verified|confirmed|correct|accurate|substantiated|supported)\b/i;

/**
 * Classify a sentence when the model answered in prose. Models rename the
 * JSON field and sometimes put a whole verdict sentence in it — read the
 * words rather than give up. Ambiguous text (both signals, or neither)
 * returns null, which the caller reports as inconclusive.
 */
function classifyProse(text: string): AuditOutcome | null {
  const fails = FAIL_WORDS.test(text);
  const passes = PASS_WORDS.test(text);
  if (fails && !passes) return "fail";
  if (passes && !fails) return "pass";
  return null;
}

/**
 * Read the auditor's verdict. Anything unreadable is `inconclusive`, not a
 * failure: a broken auditor must not trap the agent in a loop it cannot exit,
 * so completion proceeds with the uncertainty stated.
 */
export function parseAuditVerdict(text: string): AuditVerdict {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { outcome: "inconclusive", reason: "the auditor returned nothing" };

  // Last JSON object wins — models like to think out loud first, and they
  // rename the field: asked for "verdict", real models also answer with
  // "success": true/false or "result": "pass". Read all of those.
  const objects = [...trimmed.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]).reverse();
  for (const raw of objects) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, MAX_REASON) : "";

    for (const key of ["verdict", "result", "status", "outcome"]) {
      const value = typeof parsed[key] === "string" ? (parsed[key] as string).trim() : "";
      if (!value) continue;
      const keyword = value.toLowerCase();
      if (keyword === "pass" || keyword === "passed" || keyword === "ok") {
        return { outcome: "pass", reason: reason || "the auditor confirmed the claim" };
      }
      if (keyword === "fail" || keyword === "failed" || keyword === "rejected") {
        return { outcome: "fail", reason: reason || "the auditor rejected the claim" };
      }
      // The field sometimes holds the whole verdict sentence instead.
      const prose = classifyProse(value);
      if (prose) return { outcome: prose, reason: reason || value.slice(0, MAX_REASON) };
    }
    for (const key of ["success", "pass", "passed", "verified", "ok", "valid"]) {
      if (typeof parsed[key] === "boolean") {
        return parsed[key]
          ? { outcome: "pass", reason: reason || "the auditor confirmed the claim" }
          : { outcome: "fail", reason: reason || "the auditor rejected the claim" };
      }
    }
  }

  const prose = classifyProse(trimmed);
  if (prose) return { outcome: prose, reason: trimmed.slice(0, MAX_REASON) };
  return { outcome: "inconclusive", reason: `unreadable auditor answer: ${trimmed.slice(0, 120)}` };
}

/**
 * The auditor's last spoken word. Pulled out of the run messages so the
 * cancellation orchestration below can be tested without a live session, and so
 * the shape the pi `AgentSession` exposes (`messages`) has one reader, not two.
 */
export function readAssistantText(messages: unknown): string {
  const arr = Array.isArray(messages)
    ? (messages as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>)
    : [];
  const last = [...arr].reverse().find((m) => m.role === "assistant");
  return (last?.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

/**
 * The slice of pi's `AgentSession` the audit orchestration touches. Kept
 * structural so the real session satisfies it and a fake can stand in.
 */
export interface AuditSessionLike {
  prompt(text: string): Promise<unknown>;
  readonly messages: unknown;
  abort(): unknown;
  dispose(): unknown;
}

/**
 * Run the audit prompt against a session and turn its answer into a verdict,
 * enforcing the deadline and honouring cancellation.
 *
 * pi 0.85's `PromptOptions` has no `signal`, so `prompt()` cannot be cancelled
 * through its arguments — a deadline has to be a timer that calls
 * `session.abort()`, and `prompt()` resolves *normally* after an abort. So the
 * caller cannot trust the returned answer once anything fired: we check the
 * combined signal after the await and report inconclusive rather than parse a
 * half-streamed reply. The abort listener is armed before the session exists so
 * a cancel during creation is not lost; if the session was still null when it
 * fired, the post-create check catches it.
 *
 * Any failure to reach a verdict is inconclusive, never a rejection — a broken
 * or cancelled auditor must not be able to trap the agent in a loop.
 */
export async function runAuditWithSession(input: {
  create: () => Promise<AuditSessionLike>;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<AuditVerdict> {
  let session: AuditSessionLike | null = null;
  // The deadline is a plain timer we own, not AbortSignal.timeout: that uses an
  // unref'd timer that will not fire if the audit is the only thing keeping the
  // event loop alive, and we clear this one in finally so a completed audit
  // leaves nothing armed.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), input.timeoutMs);
  const timeout = deadline.signal;
  const combined = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const onAbort = () => {
    void session?.abort();
  };
  combined.addEventListener("abort", onAbort, { once: true });
  try {
    session = await input.create();
    if (combined.aborted) {
      // Fired while the session was being built — the listener was a no-op then.
      return { outcome: "inconclusive", reason: cancellationReason(timeout, input.timeoutMs) };
    }
    await session.prompt(input.prompt);
    if (combined.aborted) {
      return { outcome: "inconclusive", reason: cancellationReason(timeout, input.timeoutMs) };
    }
    return parseAuditVerdict(readAssistantText(session.messages));
  } catch (err) {
    return {
      outcome: "inconclusive",
      reason: `the audit could not run (${err instanceof Error ? err.message : String(err)})`,
    };
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", onAbort);
    try {
      session?.dispose();
    } catch {
      // disposal is best-effort
    }
  }
}

function cancellationReason(timeout: AbortSignal, timeoutMs: number): string {
  return timeout.aborted
    ? `the audit timed out after ${Math.round(timeoutMs / 1000)}s`
    : "the audit was cancelled";
}

/** Message the agent gets when the audit rejects its claim. */
export function rejectionMessage(reason: string): string {
  return [
    `The independent completion audit rejected this claim: ${reason}`,
    "The goal is still active. Address exactly what the audit found, verify it yourself, then call goal_complete again with the new evidence.",
  ].join(" ");
}

/** Suffix appended to a successful completion, so the audit is visible. */
export function auditNote(verdict: AuditVerdict): string {
  if (verdict.outcome === "pass") return `\nCompletion audit: passed — ${verdict.reason}`;
  return `\nCompletion audit: inconclusive — ${verdict.reason}. Accepted without independent verification.`;
}

/** What goal_complete should do once the (possibly long) audit await returns. */
export type CompletionDecision =
  | { action: "complete"; note: string }
  | { action: "reject"; reason: string }
  | { action: "aborted" }
  | { action: "stale" };

/**
 * Decide whether a completion claim may be committed AFTER the audit await
 * returns. The audit can run ~180s; in that window the user may press Esc
 * (aborting the turn) or change the goal from a command. Committing the
 * pre-await "complete" snapshot then would mark the goal done against the
 * user's interruption, or resurrect a goal they cleared/paused/replaced.
 *
 * Pure so the precedence is testable without a live session. Order matters:
 *  - aborted wins — the user asked for control back; nothing is completed;
 *  - a stale goal (cleared/paused/replaced mid-audit) is not completed, and
 *    is never described as "still active" (it may be gone);
 *  - a failed audit rejects the claim and leaves the goal active;
 *  - otherwise the claim stands, with the audit note attached (empty when the
 *    audit was disabled, i.e. verdict is null).
 */
export function decideCompletion(input: {
  aborted: boolean;
  stillCurrent: boolean;
  verdict: AuditVerdict | null;
}): CompletionDecision {
  if (input.aborted) return { action: "aborted" };
  if (!input.stillCurrent) return { action: "stale" };
  if (input.verdict && input.verdict.outcome === "fail") {
    return { action: "reject", reason: input.verdict.reason };
  }
  return { action: "complete", note: input.verdict ? auditNote(input.verdict) : "" };
}
