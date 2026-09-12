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
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  getAgentDir,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  AUDIT_SYSTEM_PROMPT,
  auditNote,
  buildAuditPrompt,
  parseAuditVerdict,
  rejectionMessage,
  type AuditVerdict,
} from "../src/audit.ts";
import { footerText, statusBlock } from "../src/format.ts";
import {
  buildContinuationPrompt,
  buildInitialPrompt,
  buildObjectiveUpdatedPrompt,
  buildResumePrompt,
} from "../src/prompts.ts";
import { parseGoalRoute } from "../src/route.ts";
import {
  allDone as allStepsDone,
  completeCurrentStep,
  currentStep,
  formatSteps,
  progressLine,
} from "../src/steps.ts";
import { classifyUnrecoverable, noteTurnProgress, turnErrorMessage } from "../src/safety.ts";
import {
  GOAL_STATE,
  accountUsage,
  blockGoal,
  checkSafety,
  needsBudgetWarning,
  noteBudgetWarned,
  setBudget,
  completeGoal,
  createGoal,
  editObjective,
  noteAutomaticTurn,
  pauseGoal,
  setSteps,
  replayBranch,
  resumeGoal,
  waitGoal,
} from "../src/state.ts";
import type { Goal } from "../src/types.ts";
import { TurnUsageTracker } from "../src/usage.ts";

const CONTINUATION_TYPE = "goal-continuation";
const GOAL_AUDIT = "goal-audit";
const AUDIT_TOOLS = ["read", "grep", "find", "ls"];
const AUDIT_TIMEOUT_MS = 180_000;

type UiContext = ExtensionContext;

export default function goalExtension(pi: ExtensionAPI) {
  let goal: Goal | null = null;
  /** Opt-in: an audit costs a second model call per completion claim. */
  let auditEnabled = false;
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

  /**
   * Run the independent completion audit: a second agent, read-only tools,
   * no goal extension of its own, checking the claim against the repository.
   * Any failure to reach a verdict is inconclusive, never a rejection — a
   * broken auditor must not be able to trap the agent.
   */
  async function runAudit(
    ctx: UiContext,
    objective: string,
    summary: string,
    evidence: string,
    signal?: AbortSignal,
  ): Promise<AuditVerdict> {
    let session: AgentSession | null = null;
    const timeout = AbortSignal.timeout(AUDIT_TIMEOUT_MS);
    try {
      // `reload()` is not optional. `createAgentSession` only loads a resource
      // loader it builds itself; one passed in is used exactly as handed over,
      // and a fresh DefaultResourceLoader resolves neither `systemPrompt` nor
      // `appendSystemPrompt` until it loads. Without it the child ran with no
      // instructions at all — the call succeeds, the model answers, and it
      // answers as a generic assistant with nothing to say it went wrong.
      const loader = new DefaultResourceLoader({
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        // No extensions: the auditor must not inherit this goal, or any
        // tool that could make its verdict true after the fact.
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
        // The session's own system prompt is deliberately not inherited:
        // the auditor answers to the audit instructions, nothing else.
        appendSystemPrompt: [AUDIT_SYSTEM_PROMPT],
      } as never);
      await loader.reload();
      const created = await createAgentSession({
      sessionManager: SessionManager.inMemory(ctx.cwd),
      model: ctx.model as never,
      tools: AUDIT_TOOLS,
      resourceLoader: loader,
      });
      session = created.session;
      await session.prompt(buildAuditPrompt(objective, summary, evidence), {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      } as never);

      const messages = session.messages as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
      const last = [...messages].reverse().find((m) => m.role === "assistant");
      const text = (last?.content ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("")
        .trim();
      return parseAuditVerdict(text);
    } catch (err) {
      return {
        outcome: "inconclusive",
        reason: `the audit could not run (${err instanceof Error ? err.message : String(err)})`,
      };
    } finally {
      try {
        session?.dispose();
      } catch {
        // disposal is best-effort
      }
    }
  }

  /** Queue a hidden, model-visible prompt that triggers a turn when idle. */
  function queuePrompt(content: string): void {
    pi.sendMessage(
      { customType: CONTINUATION_TYPE, content, display: false },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  // ── Lifecycle events ─────────────────────────────────────────────────

  /** Last audit-toggle entry on the branch wins (same shape as the goal snapshot). */
  function replayAudit(entries: readonly unknown[]): boolean {
    let enabled = false;
    for (const entry of entries) {
      const e = entry as { type?: string; customType?: string; data?: { enabled?: unknown } };
      if (e.type === "custom" && e.customType === GOAL_AUDIT && typeof e.data?.enabled === "boolean") {
        enabled = e.data.enabled;
      }
    }
    return enabled;
  }

  pi.on("session_start", async (_event, ctx) => {
    goal = replayBranch(ctx.sessionManager.getBranch() as never);
    auditEnabled = replayAudit(ctx.sessionManager.getBranch() as never);
    updateFooter(ctx);
    if (goal?.status === "active") {
      // Never auto-run on open (surprise token spend); the goal resumes
      // naturally at the next settled boundary after the user says anything.
      notify(ctx, "Goal still active — it continues after your next message. /goal pause to stop.", "info");
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    goal = replayBranch(ctx.sessionManager.getBranch() as never);
    auditEnabled = replayAudit(ctx.sessionManager.getBranch() as never);
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
      // An error the user has to fix would otherwise be retried on every
      // continuation, forever, at the cost of a request each time.
      const failure = turnErrorMessage(event.messages as readonly unknown[]);
      const kind = classifyUnrecoverable(failure);
      if (kind) {
        commit(ctx, pauseGoal(goal, "error", Date.now()));
        notify(
          ctx,
          `Goal paused — ${kind}. Continuing would repeat the same failure. Fix it, then /goal resume.
${failure.slice(0, 200)}`,
          "error",
        );
        return;
      }
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

    // One wrap-up turn before the ceiling, so the run stops somewhere usable
    // rather than wherever the last turn happened to end.
    const wrapUp = needsBudgetWarning(goal);
    const next = wrapUp ? noteBudgetWarned(noteAutomaticTurn(goal)) : noteAutomaticTurn(goal);
    commit(ctx, next);
    if (wrapUp) {
      notify(ctx, "The goal's token budget is nearly spent — asking the agent to wrap up.", "warning");
    }
    queuePrompt(buildContinuationPrompt(next, wrapUp));
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
    promptSnippet: "Where the current goal stands: steps, evidence, and remaining budget",
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
    promptSnippet: "Finish the current goal, stating the evidence that it is done",
    description:
      "Mark the active goal achieved. Call ONLY after a completion audit against the actual current state. " +
      "Both fields are required: a user-facing summary and the concrete evidence you inspected " +
      "(files read, commands run, test output). Never call this merely because you are stopping work.",
    parameters: Type.Object({
      summary: Type.String({ description: "What was achieved, for the user" }),
      evidence: Type.String({ description: "Concrete evidence inspected during the completion audit" }),
    }),
    async execute(_id, params: { summary: string; evidence: string }, signal, _onUpdate, ctx) {
      const current = requireActiveGoal();
      if (!params.summary.trim() || !params.evidence.trim()) {
        throw new Error("goal_complete requires both a non-empty summary and non-empty evidence.");
      }
      // Sisyphus discipline: an ordered goal is finished when its list is,
      // not when the agent feels done with the interesting part.
      if (current.steps.length > 0 && !allStepsDone(current.steps)) {
        const next = currentStep(current.steps);
        throw new Error(
          `This goal is an ordered list and ${progressLine(current.steps)} are done. ` +
            `Finish the current step first — "${next!.text}" — and mark it with goal_step_done.`,
        );
      }

      let note = "";
      if (auditEnabled) {
        notify(ctx as UiContext, "Auditing the completion claim…", "info");
        const verdict = await runAudit(
          ctx as UiContext,
          current.objective,
          params.summary.trim(),
          params.evidence.trim(),
          signal,
        );
        if (verdict.outcome === "fail") {
          notify(ctx as UiContext, `Completion audit rejected the claim: ${verdict.reason}`, "warning");
          // The goal stays active: a rejected claim is unfinished work.
          throw new Error(rejectionMessage(verdict.reason));
        }
        note = auditNote(verdict);
      }

      commit(ctx as UiContext, completeGoal(current, params.summary.trim(), Date.now()));
      notify(ctx as UiContext, `🎯 Goal achieved\n${statusBlock(goal)}${note}`, "info");
      return {
        content: [{ type: "text", text: `Goal marked complete. Report the result to the user.${note}` }],
        details: { goal },
      };
    },
  });

  pi.registerTool({
    name: "goal_step_done",
    label: "Finish goal step",
    promptSnippet: "Mark one goal step finished, with what verified it",
    description:
      "Mark the CURRENT step of an ordered goal finished and receive the next one. Requires evidence: " +
      "what you actually verified for this step (command output, file state, test results). Steps advance " +
      "one at a time and only forward — you cannot choose which step to complete.",
    parameters: Type.Object({
      evidence: Type.String({ description: "What you verified for this step" }),
    }),
    async execute(_id, params: { evidence: string }, _signal, _onUpdate, ctx) {
      const current = requireActiveGoal();
      if (current.steps.length === 0) {
        throw new Error("This goal has no step list — report progress with goal_complete when it is achieved.");
      }
      const result = completeCurrentStep(current.steps, params.evidence ?? "", Date.now());
      if (result.error) throw new Error(result.error);

      commit(ctx as UiContext, setSteps(current, result.steps, Date.now()));
      notify(ctx as UiContext, `Step done (${progressLine(result.steps)}): ${result.completed!.text}`, "info");
      return {
        content: [
          {
            type: "text",
            text: result.next
              ? `Step ${result.steps.indexOf(result.completed!) + 1} done — ${progressLine(result.steps)}.\nNext step: ${result.next.text}`
              : `Every step is done (${progressLine(result.steps)}). Run the completion audit over the objective as a whole, then call goal_complete.`,
          },
        ],
        details: { steps: result.steps, next: result.next },
      };
    },
  });

  pi.registerTool({
    name: "goal_blocked",
    label: "Block goal",
    promptSnippet: "Record that the goal cannot proceed, and why",
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
    promptSnippet: "Pause the goal until a named condition is met",
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
    description: "Pin a session goal: /goal <objective> | status | steps | pause | resume | clear | budget <Nk|N.Nm|off> | audit [on|off]",
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
        case "budget-invalid": {
          notify(ctx, "Usage: /goal budget <tokens|Nk|N.Nm|off> (min 1k), e.g. /goal budget 500k", "warning");
          return;
        }
        case "steps": {
          if (!goal) {
            notify(ctx, "No goal set. Start one with /goal <objective>.", "warning");
            return;
          }
          notify(
            ctx,
            goal.steps.length === 0
              ? "This goal has no step list. Write the objective as a list (one step per line, or separated by ';') to work it in order."
              : formatSteps(goal.steps),
            "info",
          );
          return;
        }
        case "audit": {
          if (route.enabled === null) {
            notify(
              ctx,
              [
                `Completion audit: ${auditEnabled ? "on" : "off"}.`,
                auditEnabled
                  ? "Every goal_complete claim is re-checked by an independent read-only agent before it counts."
                  : "Turn it on with /goal audit on — each completion claim then costs one extra model call.",
              ].join("\n"),
              "info",
            );
            return;
          }
          auditEnabled = route.enabled;
          pi.appendEntry(GOAL_AUDIT, { enabled: auditEnabled });
          notify(
            ctx,
            auditEnabled
              ? "Completion audit ON — goal_complete claims are verified by an independent agent."
              : "Completion audit OFF.",
            "info",
          );
          return;
        }
        case "budget": {
          if (!goal || goal.status === "complete") {
            notify(ctx, "No active goal. Start one first with /goal <objective>.", "warning");
            return;
          }
          commit(ctx, setBudget(goal, route.budget, Date.now()));
          notify(
            ctx,
            route.budget === null
              ? "Goal budget cleared."
              : `Goal budget set: ${route.budget} tokens (${goal!.tokensUsed} used so far).`,
            "info",
          );
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
