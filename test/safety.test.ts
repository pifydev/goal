import { test } from "node:test";
import assert from "node:assert/strict";
import {
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
