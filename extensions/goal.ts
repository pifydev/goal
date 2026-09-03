/**
 * @pify/goal — pin a session goal and keep the agent anchored to it.
 *
 * One goal per session. The agent is driven by hidden follow-up prompts
 * queued at settled idle boundaries (never via the system prompt, so provider
 * prompt caching stays effective), gated by safety limits: an automatic-turn
 * ceiling and no-progress detection. The agent reports back through
 * evidence-gated tools (goal_complete / goal_blocked / goal_wait); only the
 * user can create, pause, resume, or clear a goal — the user owns intent.
 *
 * Design synthesis: continuation-at-settled + safety epochs + cache-stable
 * prompts (@narumitw/pi-goal); footer indicator, usage accounting, untrusted
 * objective wrapping, blocked-recurrence discipline (code-yeongyu/pi-goal);
 * user-owns-intent principle (@capyup/pi-goal).
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { footerText, statusBlock } from "../src/format.ts";
import {
  buildContinuationPrompt,
  buildInitialPrompt,
  buildObjectiveUpdatedPrompt,
  buildResumePrompt,
} from "../src/prompts.ts";
import { parseGoalRoute } from "../src/route.ts";
import { noteTurnProgress } from "../src/safety.ts";
import {
  GOAL_STATE,
  accountUsage,
  blockGoal,
  checkSafety,
  completeGoal,
  createGoal,
  editObjective,
  noteAutomaticTurn,
  pauseGoal,
  replayBranch,
  resumeGoal,
  waitGoal,
} from "../src/state.ts";
import type { Goal } from "../src/types.ts";
import { TurnUsageTracker } from "../src/usage.ts";

const CONTINUATION_TYPE = "goal-continuation";

type UiContext = ExtensionContext;

export default function goalExtension(pi: ExtensionAPI) {
  let goal: Goal | null = null;
  let turnStartedAt: number | null = null;
  let agentAbortSignal: AbortSignal | undefined;
  const turnUsage = new TurnUsageTracker();

  // ── Persistence & UI ─────────────────────────────────────────────────

  /** Persist a full snapshot (last-wins replay) and refresh the footer. */
  function commit(ctx: UiContext, next: Goal | null): void {
    goal = next;
    pi.appendEntry(GOAL_STATE, next);
    updateFooter(ctx);
  }

  function updateFooter(ctx: UiContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("goal", footerText(goal));
  }

  function notify(ctx: UiContext, message: string, level: "info" | "warning" | "error"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  }

  /** Queue a hidden, model-visible prompt that triggers a turn when idle. */
  function queuePrompt(content: string): void {
    pi.sendMessage(
      { customType: CONTINUATION_TYPE, content, display: false },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  // ── Lifecycle events ─────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    goal = replayBranch(ctx.sessionManager.getBranch() as never);
    updateFooter(ctx);
    if (goal?.status === "active") {
      // Never auto-run on open (surprise token spend); the goal resumes
      // naturally at the next settled boundary after the user says anything.
      notify(ctx, "Goal still active — it continues after your next message. /goal pause to stop.", "info");
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    goal = replayBranch(ctx.sessionManager.getBranch() as never);
    updateFooter(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    // Fires only for real user prompts: start a fresh safety epoch, and
    // auto-reactivate blocked/waiting goals (the user's input may be exactly
    // what unblocks them — code-yeongyu semantics). Paused stays paused.
    if (!goal) return;
    if (goal.status === "blocked" || goal.status === "waiting") {
      commit(ctx, resumeGoal(goal, Date.now()));
      notify(ctx, "Goal reactivated by your message.", "info");
    } else if (goal.status === "active") {
      commit(ctx, { ...resumeGoal(goal, Date.now()), status: "active" });
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    agentAbortSignal = ctx.signal;
    turnUsage.reset();
    if (goal?.status === "active") turnStartedAt = Date.now();
  });

  pi.on("message_end", async (event) => {
    turnUsage.noteMessageEnd(event.message);
  });

  pi.on("agent_end", async (event, ctx) => {
    const aborted = agentAbortSignal?.aborted === true;
    agentAbortSignal = undefined;
    if (!goal) return;

    // Account this turn's usage and time against the goal.
    if (turnStartedAt !== null) {
      const elapsed = (Date.now() - turnStartedAt) / 1000;
      turnStartedAt = null;
      const usage = turnUsage.takeRemaining(event.messages as readonly unknown[]);
      goal = accountUsage(goal, usage, elapsed, Date.now());
    }

    if (goal.status === "active") {
      if (aborted) {
        // Esc during a goal turn = the user wants control back. Pause, do not
        // continue. (The published API cannot distinguish abort sources; a
        // system abort may be mislabeled — acceptable, resume is one command.)
        commit(ctx, pauseGoal(goal, "interrupt", Date.now()));
        notify(ctx, "Goal paused — turn was interrupted. /goal resume to continue.", "warning");
        return;
      }
      goal = noteTurnProgress(goal, event.messages as readonly unknown[]);
    }
    commit(ctx, goal);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // The sole continuation trigger: fires after queued work, retries, and
    // compaction have finished. Continue exactly once per settled boundary.
    if (!goal || goal.status !== "active") return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

    const verdict = checkSafety(goal);
    if (!verdict.ok) {
      commit(ctx, pauseGoal(goal, verdict.cause, Date.now()));
      notify(
        ctx,
        `Goal paused (${verdict.detail}). Review the work, then /goal resume to continue.`,
        "warning",
      );
      return;
    }

    commit(ctx, noteAutomaticTurn(goal));
    queuePrompt(buildContinuationPrompt(goal));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("goal", undefined);
  });

  // ── Agent tools (report-only; the user owns intent) ──────────────────

  function requireActiveGoal(): Goal {
    if (!goal) throw new Error("No goal is set. Only the user can start one with /goal <objective>.");
    if (goal.status !== "active") {
      throw new Error(`The goal is ${goal.status}, not active. Do not call goal tools now.`);
    }
    return goal;
  }

  pi.registerTool({
    name: "goal_status",
    label: "Goal status",
    description: "Read the current session goal: objective, status, and usage.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: statusBlock(goal) }],
        details: { goal },
      };
    },
  });

  pi.registerTool({
    name: "goal_complete",
    label: "Complete goal",
    description:
      "Mark the active goal achieved. Call ONLY after a completion audit against the actual current state. " +
      "Both fields are required: a user-facing summary and the concrete evidence you inspected " +
      "(files read, commands run, test output). Never call this merely because you are stopping work.",
    parameters: Type.Object({
      summary: Type.String({ description: "What was achieved, for the user" }),
      evidence: Type.String({ description: "Concrete evidence inspected during the completion audit" }),
    }),
    async execute(_id, params: { summary: string; evidence: string }, _signal, _onUpdate, ctx) {
      const current = requireActiveGoal();
      if (!params.summary.trim() || !params.evidence.trim()) {
        throw new Error("goal_complete requires both a non-empty summary and non-empty evidence.");
      }
      commit(ctx as UiContext, completeGoal(current, params.summary.trim(), Date.now()));
      notify(ctx as UiContext, `🎯 Goal achieved\n${statusBlock(goal)}`, "info");
      return {
        content: [{ type: "text", text: "Goal marked complete. Report the result to the user." }],
        details: { goal },
      };
    },
  });

  pi.registerTool({
    name: "goal_blocked",
    label: "Block goal",
    description:
      "Mark the active goal blocked. Call ONLY after the SAME blocking condition has recurred for at " +
      "least 3 consecutive goal turns. Do not block because work is hard, slow, or uncertain. " +
      "The next user message automatically reactivates the goal.",
    parameters: Type.Object({
      reason: Type.String({ description: "The recurring blocking condition" }),
    }),
    async execute(_id, params: { reason: string }, _signal, _onUpdate, ctx) {
      const current = requireActiveGoal();
      if (!params.reason.trim()) throw new Error("goal_blocked requires a non-empty reason.");
      commit(ctx as UiContext, blockGoal(current, params.reason.trim(), Date.now()));
      notify(ctx as UiContext, `Goal blocked: ${params.reason.trim()}`, "warning");
      return {
        content: [{ type: "text", text: "Goal marked blocked. Explain the blocker to the user." }],
        details: { goal },
      };
    },
  });

  pi.registerTool({
    name: "goal_wait",
    label: "Goal wait",
    description:
      "Pause goal continuation while progress depends on an external event (CI, a human, a deployment) " +
      "that no further work can accelerate. The next user message automatically reactivates the goal.",
    parameters: Type.Object({
      reason: Type.String({ description: "What external event the goal is waiting for" }),
    }),
    async execute(_id, params: { reason: string }, _signal, _onUpdate, ctx) {
      const current = requireActiveGoal();
      if (!params.reason.trim()) throw new Error("goal_wait requires a non-empty reason.");
      commit(ctx as UiContext, waitGoal(current, params.reason.trim(), Date.now()));
      notify(ctx as UiContext, `Goal waiting: ${params.reason.trim()}`, "info");
      return {
        content: [{ type: "text", text: "Goal is now waiting. Tell the user what it waits for." }],
        details: { goal },
      };
    },
  });

  // ── Command ──────────────────────────────────────────────────────────

  pi.registerCommand("goal", {
    description: "Pin a session goal: /goal <objective> | status | pause | resume | clear",
    handler: async (args, ctx) => {
      const route = parseGoalRoute(args ?? "");
      switch (route.kind) {
        case "status": {
          notify(ctx, statusBlock(goal), "info");
          return;
        }
        case "pause": {
          if (!goal || goal.status === "complete") {
            notify(ctx, "No active goal to pause.", "warning");
            return;
          }
          commit(ctx, pauseGoal(goal, "user", Date.now()));
          notify(ctx, "Goal paused. /goal resume to continue.", "info");
          return;
        }
        case "resume": {
          if (!goal) {
            notify(ctx, "No goal set. Start one with /goal <objective>.", "warning");
            return;
          }
          if (goal.status === "active") {
            notify(ctx, "Goal is already active.", "info");
            return;
          }
          if (goal.status === "complete") {
            notify(ctx, "Goal is complete. Start a new one with /goal <objective>.", "warning");
            return;
          }
          const previous = goal.status;
          commit(ctx, resumeGoal(goal, Date.now()));
          notify(ctx, "Goal resumed.", "info");
          queuePrompt(buildResumePrompt(goal!, previous));
          return;
        }
        case "clear": {
          if (!goal) {
            notify(ctx, "No goal to clear.", "warning");
            return;
          }
          commit(ctx, null);
          notify(ctx, "Goal cleared.", "info");
          return;
        }
        case "set": {
          if (goal && goal.status !== "complete") {
            // Live goal: this is an objective edit that supersedes the old one.
            commit(ctx, editObjective(goal, route.objective, Date.now()));
            notify(ctx, "Goal objective updated.", "info");
            queuePrompt(buildObjectiveUpdatedPrompt(goal!));
            return;
          }
          const created = createGoal(route.objective, Date.now(), crypto.randomUUID());
          commit(ctx, created);
          notify(ctx, `🎯 Goal set\n${statusBlock(created)}`, "info");
          queuePrompt(buildInitialPrompt(created));
          return;
        }
      }
    },
  });
}
