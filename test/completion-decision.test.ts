import { test } from "node:test";
import assert from "node:assert/strict";
import { decideCompletion, type AuditVerdict } from "../src/audit.ts";

const PASS: AuditVerdict = { outcome: "pass", reason: "tests exist and run" };
const FAIL: AuditVerdict = { outcome: "fail", reason: "src/x.ts is missing" };
const INCONCLUSIVE: AuditVerdict = { outcome: "inconclusive", reason: "the audit timed out" };

test("completes when not aborted, still current, and the audit is disabled", () => {
  const decision = decideCompletion({ aborted: false, stillCurrent: true, verdict: null });
  assert.deepEqual(decision, { action: "complete", note: "" });
});

test("completes with a passed audit note", () => {
  const decision = decideCompletion({ aborted: false, stillCurrent: true, verdict: PASS });
  assert.equal(decision.action, "complete");
  if (decision.action === "complete") assert.ok(decision.note.includes("passed"));
});

test("an inconclusive audit still completes, but says so", () => {
  const decision = decideCompletion({ aborted: false, stillCurrent: true, verdict: INCONCLUSIVE });
  assert.equal(decision.action, "complete");
  if (decision.action === "complete") {
    assert.ok(decision.note.includes("inconclusive"));
    assert.ok(decision.note.includes("without independent verification"));
  }
});

test("a failed audit rejects and keeps the goal active", () => {
  const decision = decideCompletion({ aborted: false, stillCurrent: true, verdict: FAIL });
  assert.deepEqual(decision, { action: "reject", reason: "src/x.ts is missing" });
});

// ── The regression: an Esc mid-audit must not mark the goal complete ──────

test("an abort during the audit never completes, even on a passing verdict", () => {
  // Before the fix, goal_complete committed the pre-await "complete" snapshot
  // regardless of the user pressing Esc mid-audit. A passing verdict must NOT
  // win over the user's interruption.
  const decision = decideCompletion({ aborted: true, stillCurrent: true, verdict: PASS });
  assert.deepEqual(decision, { action: "aborted" });
});

test("abort wins with no audit running (audit disabled)", () => {
  const decision = decideCompletion({ aborted: true, stillCurrent: true, verdict: null });
  assert.deepEqual(decision, { action: "aborted" });
});

test("abort takes precedence over a failed verdict", () => {
  const decision = decideCompletion({ aborted: true, stillCurrent: true, verdict: FAIL });
  assert.deepEqual(decision, { action: "aborted" });
});

test("abort takes precedence over a stale goal", () => {
  const decision = decideCompletion({ aborted: true, stillCurrent: false, verdict: PASS });
  assert.deepEqual(decision, { action: "aborted" });
});

// ── A goal changed mid-audit (cleared/paused/replaced) is not completed ───

test("a goal that changed mid-audit is not completed, even on a passing verdict", () => {
  const decision = decideCompletion({ aborted: false, stillCurrent: false, verdict: PASS });
  assert.deepEqual(decision, { action: "stale" });
});

test("a stale goal is reported stale, not rejected (never 'still active')", () => {
  // A cleared/replaced goal must not be described back to the agent as "still
  // active" via the rejection path — it may be gone entirely.
  const decision = decideCompletion({ aborted: false, stillCurrent: false, verdict: FAIL });
  assert.deepEqual(decision, { action: "stale" });
});

test("a stale goal with the audit disabled is still not completed", () => {
  const decision = decideCompletion({ aborted: false, stillCurrent: false, verdict: null });
  assert.deepEqual(decision, { action: "stale" });
});
