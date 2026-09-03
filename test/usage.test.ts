import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnUsageTracker, collectAssistantUsage, emptyUsage } from "../src/usage.ts";

function assistantWith(totalTokens: number, output = 0) {
  return {
    role: "assistant",
    usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, totalTokens },
  };
}

test("collectAssistantUsage sums only assistant messages with usage", () => {
  const usage = collectAssistantUsage([
    assistantWith(100),
    { role: "user" },
    assistantWith(50, 20),
    { role: "assistant" }, // no usage
    { role: "toolResult", usage: { totalTokens: 999 } },
  ]);
  assert.equal(usage.totalTokens, 150);
  assert.equal(usage.output, 20);
});

test("tracker reconciles: takeRemaining counts only the uncounted delta", () => {
  const tracker = new TurnUsageTracker();
  tracker.reset();
  tracker.noteMessageEnd(assistantWith(100));
  const pending = tracker.takePending();
  assert.equal(pending.totalTokens, 100);

  // Full run had 100 (already flushed) + 40 new.
  const remaining = tracker.takeRemaining([assistantWith(100), assistantWith(40)]);
  assert.equal(remaining.totalTokens, 40);
});

test("takeRemaining never goes negative when the run reports less", () => {
  const tracker = new TurnUsageTracker();
  tracker.noteMessageEnd(assistantWith(500));
  tracker.takePending();
  const remaining = tracker.takeRemaining([assistantWith(200)]);
  assert.equal(remaining.totalTokens, 0);
});

test("reset drops all counters", () => {
  const tracker = new TurnUsageTracker();
  tracker.noteMessageEnd(assistantWith(500));
  tracker.reset();
  assert.deepEqual(tracker.takePending(), emptyUsage());
});

test("non-finite usage fields are ignored", () => {
  const usage = collectAssistantUsage([
    { role: "assistant", usage: { totalTokens: Number.NaN, output: Infinity } },
    assistantWith(10),
  ]);
  assert.equal(usage.totalTokens, 10);
});
