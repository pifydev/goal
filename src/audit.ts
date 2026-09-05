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
