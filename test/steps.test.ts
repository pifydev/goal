import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_STEPS,
  allDone,
  completeCurrentStep,
  currentStep,
  currentStepIndex,
  formatSteps,
  parseSteps,
  progressLine,
} from "../src/steps.ts";
import { createGoal, editObjective, replayBranch, GOAL_STATE } from "../src/state.ts";
import { buildContinuationPrompt, buildInitialPrompt } from "../src/prompts.ts";
import { parseGoalRoute } from "../src/route.ts";

test("parseSteps reads a marked list on separate lines", () => {
  const steps = parseSteps("Ship logging\n- add the logger\n- wire it into auth\n- cover it with tests");
  assert.deepEqual(
    steps.map((s) => s.text),
    ["add the logger", "wire it into auth", "cover it with tests"],
  );
  assert.ok(steps.every((s) => !s.done));

  const numbered = parseSteps("1. first thing\n2) second thing");
  assert.deepEqual(numbered.map((s) => s.text), ["first thing", "second thing"]);
});

test("parseSteps reads a single line of separated segments", () => {
  assert.deepEqual(
    parseSteps("add the logger; wire it into auth; cover it with tests").map((s) => s.text),
    ["add the logger", "wire it into auth", "cover it with tests"],
  );
  assert.deepEqual(parseSteps("read the code -> write the fix").map((s) => s.text), ["read the code", "write the fix"]);
});

test("parseSteps leaves prose alone", () => {
  // a sentence with commas is not a plan; guessing would change how the whole
  // goal is driven
  assert.deepEqual(parseSteps("Refactor the parser, then make it faster"), []);
  assert.deepEqual(parseSteps("Ship structured logging across the auth module"), []);
  assert.deepEqual(parseSteps(""), []);
  assert.deepEqual(parseSteps("- only one bullet"), []);
});

test("parseSteps caps and cleans", () => {
  const many = parseSteps(Array.from({ length: MAX_STEPS + 5 }, (_, i) => `- step ${i}`).join("\n"));
  assert.equal(many.length, MAX_STEPS);
  const messy = parseSteps("*   spaced   out   \n•  bullet two");
  assert.deepEqual(messy.map((s) => s.text), ["spaced out", "bullet two"]);
});

test("steps advance one at a time, forward only, with evidence", () => {
  let steps = parseSteps("- a\n- b\n- c");
  assert.equal(currentStepIndex(steps), 0);
  assert.equal(progressLine(steps), "0/3 steps");

  const noEvidence = completeCurrentStep(steps, "  ", 1);
  assert.ok(noEvidence.error);
  assert.equal(noEvidence.steps, steps);

  const first = completeCurrentStep(steps, "ran bun test", 5);
  assert.equal(first.error, null);
  assert.equal(first.completed!.text, "a");
  assert.equal(first.completed!.evidence, "ran bun test");
  assert.equal(first.completed!.doneAt, 5);
  assert.equal(first.next!.text, "b");
  steps = first.steps;
  assert.equal(progressLine(steps), "1/3 steps");
  assert.equal(currentStep(steps)!.text, "b");
  assert.equal(allDone(steps), false);

  steps = completeCurrentStep(steps, "b evidence", 6).steps;
  const last = completeCurrentStep(steps, "c evidence", 7);
  assert.equal(last.next, null);
  assert.equal(allDone(last.steps), true);
  assert.ok(completeCurrentStep(last.steps, "more", 8).error);
});

test("formatSteps marks done, current, and pending", () => {
  const steps = completeCurrentStep(parseSteps("- a\n- b\n- c"), "checked", 1).steps;
  const text = formatSteps(steps);
  assert.ok(text.includes("1/3 steps"));
  assert.ok(text.includes("✔ 1. a — checked"));
  assert.ok(text.includes("▸ 2. b"));
  assert.ok(text.includes("◻ 3. c"));
  assert.equal(formatSteps([]), "This goal has no step list.");
});

test("a goal built from a list carries its steps; prose goals do not", () => {
  const listed = createGoal("- one\n- two", 1, "id");
  assert.equal(listed.steps.length, 2);
  const prose = createGoal("make the tests pass", 1, "id");
  assert.deepEqual(prose.steps, []);

  // replacing the objective replaces the plan
  const replaced = editObjective(listed, "- three\n- four\n- five", 2);
  assert.deepEqual(replaced.steps.map((s) => s.text), ["three", "four", "five"]);
});

test("prompts name the current step and hide the rest of the list", () => {
  const goal = createGoal("- add the logger\n- wire it into auth\n- cover it with tests", 1, "id");
  const initial = buildInitialPrompt(goal);
  assert.ok(initial.includes('<current_step index="1">'));
  assert.ok(initial.includes("add the logger"));
  assert.ok(initial.includes("Begin the current step."));
  // the list itself is the objective, so it is there — the cursor is what is new
  assert.ok(initial.includes("wire it into auth"));

  const midway = { ...goal, steps: completeCurrentStep(goal.steps, "done", 2).steps };
  const continuation = buildContinuationPrompt(midway);
  assert.ok(continuation.includes('<current_step index="2">'));
  assert.ok(continuation.includes("wire it into auth"));
  assert.ok(continuation.includes("Already done:"));
  assert.ok(continuation.includes("1/3 steps"));

  // a prose goal gets no step block at all
  assert.ok(!buildContinuationPrompt(createGoal("just do it", 1, "id")).includes("current_step"));
});

test("the prompt switches to completion once every step is done", () => {
  let goal = createGoal("- a\n- b", 1, "id");
  goal = { ...goal, steps: completeCurrentStep(goal.steps, "x", 2).steps };
  goal = { ...goal, steps: completeCurrentStep(goal.steps, "y", 3).steps };
  const prompt = buildContinuationPrompt(goal);
  assert.ok(prompt.includes("All 2 steps are marked done"));
  assert.ok(prompt.includes("goal_complete"));
});

test("/goal steps routes", () => {
  assert.deepEqual(parseGoalRoute("steps"), { kind: "steps" });
  assert.deepEqual(parseGoalRoute("  STEPS "), { kind: "steps" });
  // an objective that begins with the word is still an objective
  assert.equal(parseGoalRoute("steps to reproduce the bug").kind, "set");
});

test("a pre-v0.4 snapshot replays with an empty step list", () => {
  const legacy = {
    id: "g1",
    objective: "old goal",
    status: "active",
    tokensUsed: 0,
    tokenBudget: null,
    timeUsedSeconds: 0,
    automaticTurns: 0,
    toolFreeRepeatCount: 0,
    lastFingerprint: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const goal = replayBranch([{ type: "custom", customType: GOAL_STATE, data: legacy }]);
  assert.ok(goal);
  assert.deepEqual(goal!.steps, []);
  // and the prompt builders do not throw on it
  assert.ok(buildContinuationPrompt(goal!).includes("old goal"));
});
