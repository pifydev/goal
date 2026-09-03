/** Parse the /goal command argument into a route. */

export type GoalRoute =
  | { kind: "status" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
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

export function parseGoalRoute(raw: string): GoalRoute {
  const trimmed = raw.trim();
  const keyword = KEYWORDS[trimmed.toLowerCase()];
  if (keyword && keyword !== "set") return { kind: keyword } as GoalRoute;
  return { kind: "set", objective: trimmed.slice(0, MAX_OBJECTIVE_LENGTH) };
}
