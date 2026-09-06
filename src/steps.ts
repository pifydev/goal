/**
 * Sisyphus mode (capyup/tmonk): a goal that is a list of steps, worked in
 * order, instead of one open-ended objective.
 *
 * The point is not decoration. A long objective invites the agent to pick the
 * part it likes, declare that part done, and drift; naming one current step in
 * every continuation prompt removes the choice, and completion is gated on
 * reaching the end of the list rather than on the agent's own sense of
 * finished.
 */

export interface GoalStep {
  text: string;
  done: boolean;
  /** What was verified when the step was marked done. */
  evidence?: string;
  doneAt?: number;
}

export const MAX_STEPS = 20;
const MAX_STEP_LENGTH = 300;

function clean(text: string): string {
  return text
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_STEP_LENGTH);
}

/**
 * Read an ordered step list out of an objective. Recognises the two ways a
 * person actually types one: markers on separate lines, or a single line of
 * segments separated by `;` / `->`. Prose stays prose — a sentence containing
 * a comma is not a plan, and guessing wrong would silently change how the
 * whole goal is driven.
 */
export function parseSteps(objective: string): GoalStep[] {
  const text = (objective ?? "").trim();
  if (!text) return [];

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const marked = lines.filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l));
  if (marked.length >= 2) {
    return marked.slice(0, MAX_STEPS).map((line) => ({ text: clean(line), done: false })).filter((s) => s.text);
  }

  if (lines.length === 1) {
    const segments = text
      .split(/\s*(?:;|->|→)\s*/)
      .map((s) => clean(s))
      .filter(Boolean);
    if (segments.length >= 2) {
      return segments.slice(0, MAX_STEPS).map((step) => ({ text: step, done: false }));
    }
  }

  return [];
}

export function currentStepIndex(steps: GoalStep[]): number {
  return steps.findIndex((s) => !s.done);
}

export function currentStep(steps: GoalStep[]): GoalStep | null {
  const index = currentStepIndex(steps);
  return index === -1 ? null : steps[index]!;
}

export function allDone(steps: GoalStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.done);
}

export interface StepResult {
  steps: GoalStep[];
  completed: GoalStep | null;
  next: GoalStep | null;
  error: string | null;
}

/**
 * Mark the current step done. Steps advance one at a time and only forward:
 * an agent that could pick the index would pick the easy one.
 */
export function completeCurrentStep(steps: GoalStep[], evidence: string, now: number): StepResult {
  const index = currentStepIndex(steps);
  if (index === -1) {
    return { steps, completed: null, next: null, error: "every step is already done" };
  }
  if (!evidence.trim()) {
    return { steps, completed: null, next: null, error: "completing a step requires evidence of what you verified" };
  }
  const updated = steps.map((step, i) =>
    i === index ? { ...step, done: true, evidence: evidence.trim(), doneAt: now } : step,
  );
  return {
    steps: updated,
    completed: updated[index]!,
    next: currentStep(updated),
    error: null,
  };
}

export function progressLine(steps: GoalStep[]): string {
  const done = steps.filter((s) => s.done).length;
  return `${done}/${steps.length} steps`;
}

export function formatSteps(steps: GoalStep[]): string {
  if (steps.length === 0) return "This goal has no step list.";
  const cursor = currentStepIndex(steps);
  const lines = steps.map((step, i) => {
    const mark = step.done ? "✔" : i === cursor ? "▸" : "◻";
    const evidence = step.done && step.evidence ? ` — ${step.evidence}` : "";
    return `${mark} ${i + 1}. ${step.text}${evidence}`;
  });
  return [progressLine(steps), ...lines].join("\n");
}
