/** Parse the /goal command argument into a route. */

export type GoalRoute =
  | { kind: "status" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "budget"; budget: number | null }
  | { kind: "budget-invalid" }
  | { kind: "set"; objective: string };

const KEYWORDS: Record<string, GoalRoute["kind"]> = {
  "": "status",
  status: "status",
  pause: "pause",
  resume: "resume",
  clear: "clear",
  stop: "pause",
};

/** Objectives are capped so a pasted document cannot bloat every prompt. */
export const MAX_OBJECTIVE_LENGTH = 4000;

/** Parse "500k", "1.5m", "250000", or "off" into a token count (or null). */
export function parseBudgetValue(raw: string): number | null | undefined {
  const token = raw.trim().toLowerCase();
  if (token === "off" || token === "none" || token === "clear") return null;
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(token);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]!) * (match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1);
  if (!Number.isFinite(value) || value < 1_000) return undefined;
  return Math.round(value);
}

export function parseGoalRoute(raw: string): GoalRoute {
  const trimmed = raw.trim();
  const keyword = KEYWORDS[trimmed.toLowerCase()];
  if (keyword && keyword !== "set") return { kind: keyword } as GoalRoute;

  const budgetMatch = /^budget(?:\s+(\S+))?$/i.exec(trimmed);
  if (budgetMatch) {
    if (!budgetMatch[1]) return { kind: "budget-invalid" };
    const budget = parseBudgetValue(budgetMatch[1]);
    return budget === undefined ? { kind: "budget-invalid" } : { kind: "budget", budget };
  }

  return { kind: "set", objective: trimmed.slice(0, MAX_OBJECTIVE_LENGTH) };
}
