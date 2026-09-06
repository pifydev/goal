import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyUnrecoverable,
  turnErrorMessage,
  fingerprintVisibleAssistantOutput,
  hasAssistantToolCall,
  normalizeVisibleAssistantOutput,
  noteTurnProgress,
} from "../src/safety.ts";
import { createGoal } from "../src/state.ts";

function assistant(text: string, extra: object[] = []) {
  return { role: "assistant", content: [{ type: "text", text }, ...extra] };
}

const toolCall = { type: "toolCall", toolName: "read" };

test("hasAssistantToolCall detects tool blocks", () => {
  assert.equal(hasAssistantToolCall([assistant("hi")]), false);
  assert.equal(hasAssistantToolCall([assistant("hi", [toolCall])]), true);
  assert.equal(hasAssistantToolCall([{ role: "user", content: [] }]), false);
});

test("normalization collapses whitespace, case, and control chars", () => {
  const a = normalizeVisibleAssistantOutput([assistant("Hello   World\n\n")]);
  const b = normalizeVisibleAssistantOutput([assistant("hello world")]);
  assert.equal(a, b);
});

test("pure punctuation output normalizes to empty (always a repeat)", () => {
  assert.equal(normalizeVisibleAssistantOutput([assistant("...!?")]), "");
  assert.equal(normalizeVisibleAssistantOutput([]), "");
});

test("fingerprints differ for different content", () => {
  assert.notEqual(
    fingerprintVisibleAssistantOutput([assistant("plan A")]),
    fingerprintVisibleAssistantOutput([assistant("plan B")]),
  );
});

test("noteTurnProgress: tool use resets the repeat counter", () => {
  let g = createGoal("x", 0, "g");
  g = noteTurnProgress(g, [assistant("thinking...")]);
  assert.equal(g.toolFreeRepeatCount, 1);
  g = noteTurnProgress(g, [assistant("working", [toolCall])]);
  assert.equal(g.toolFreeRepeatCount, 0);
  assert.equal(g.lastFingerprint, null);
});

test("noteTurnProgress: identical tool-free output increments; new output resets to 1", () => {
  let g = createGoal("x", 0, "g");
  g = noteTurnProgress(g, [assistant("same text")]);
  g = noteTurnProgress(g, [assistant("Same   TEXT")]); // normalizes equal
  g = noteTurnProgress(g, [assistant("same text")]);
  assert.equal(g.toolFreeRepeatCount, 3);
  g = noteTurnProgress(g, [assistant("different now")]);
  assert.equal(g.toolFreeRepeatCount, 1);
});

test("v0.5 errors the user must fix are separated from ones worth retrying", () => {
  // repeating these would fail identically every time, forever
  assert.equal(classifyUnrecoverable("401 Unauthorized"), "authentication");
  assert.equal(classifyUnrecoverable("Incorrect API key provided: sk-xxx"), "authentication");
  assert.equal(classifyUnrecoverable("403 Forbidden"), "authentication");
  assert.equal(classifyUnrecoverable("Insufficient credits to run this request"), "credits");
  assert.equal(classifyUnrecoverable("402 Payment Required"), "credits");
  assert.equal(classifyUnrecoverable("prompt is too long: 210000 tokens"), "context overflow");
  assert.equal(classifyUnrecoverable("maximum context length exceeded"), "context overflow");
  assert.equal(classifyUnrecoverable("model gpt-9 does not exist"), "model unavailable");

  // a retry loop is exactly what these want
  assert.equal(classifyUnrecoverable("429 rate limit exceeded"), null);
  assert.equal(classifyUnrecoverable("Overloaded"), null);
  assert.equal(classifyUnrecoverable("socket hang up"), null);
  assert.equal(classifyUnrecoverable("ETIMEDOUT"), null);
  assert.equal(classifyUnrecoverable("500 Internal Server Error"), null);
  assert.equal(classifyUnrecoverable(""), null);
});

test("v0.5 turnErrorMessage reads the failure off the turn", () => {
  assert.equal(
    turnErrorMessage([
      { role: "user", content: "go" },
      { role: "assistant", stopReason: "error", errorMessage: "401 Unauthorized" },
    ]),
    "401 Unauthorized",
  );
  // the newest assistant error wins
  assert.equal(
    turnErrorMessage([
      { role: "assistant", stopReason: "error", errorMessage: "first" },
      { role: "assistant", stopReason: "error", errorMessage: "second" },
    ]),
    "second",
  );
  assert.equal(turnErrorMessage([{ role: "assistant", stopReason: "endTurn" }]), "");
  assert.equal(turnErrorMessage([]), "");
  assert.equal(turnErrorMessage([null, "junk", 42]), "");
  assert.equal(
    turnErrorMessage([{ role: "assistant", stopReason: "error" }]),
    "unknown error",
    "an error with no text still reports as one",
  );
});
