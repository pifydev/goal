import { test } from "node:test";
import assert from "node:assert/strict";
import goalExtension from "../extensions/goal.ts";
import { GOAL_STATE } from "../src/state.ts";
import type { Goal } from "../src/types.ts";

/**
 * Stub-host wiring tests: drive the real extension through a fake pi so the
 * agent_end/agent_settled ordering can be replayed without a live session.
 *
 * These cover the hook-ordering rules pi imposes but src/ cannot see: pi emits
 * the per-attempt agent_end from inside the agent loop BEFORE its own
 * compact-and-retry runs, so a context overflow that pi recovers must NOT pause
 * the goal, and pi's transient retries (429/529) must not count as no-progress.
 */

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

interface Entry {
  type: string;
  data: unknown;
}

interface Sent {
  msg: { customType?: string; content?: string };
}

function makeHost() {
  const handlers = new Map<string, Handler>();
  const entries: Entry[] = [];
  const sent: Sent[] = [];
  const command: { handler?: (args: string, ctx: unknown) => Promise<void> | void } = {};

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
    sendMessage(msg: Sent["msg"]) {
      sent.push({ msg });
    },
    registerTool() {},
    registerCommand(_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> | void }) {
      command.handler = def.handler;
    },
  };

  goalExtension(pi as never);

  return { handlers, entries, sent, command };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    hasUI: false,
    cwd: "/tmp",
    model: {},
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => [] },
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** The goal state after the most recent snapshot commit. */
function currentGoal(entries: Entry[]): Goal | null | undefined {
  const snapshots = entries.filter((e) => e.type === GOAL_STATE);
  return snapshots.length ? (snapshots[snapshots.length - 1]!.data as Goal | null) : undefined;
}

function goalSnapshotCount(entries: Entry[]): number {
  return entries.filter((e) => e.type === GOAL_STATE).length;
}

function continuationCount(sent: Sent[]): number {
  return sent.filter((s) => s.msg.customType === "goal-continuation").length;
}

const overflowTurn = {
  messages: [
    {
      role: "assistant",
      stopReason: "error",
      errorMessage: "prompt is too long: maximum context length exceeded",
      content: [],
    },
  ],
};

const rateLimitTurn = {
  messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 Too Many Requests", content: [] }],
};

const successTurn = {
  messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "did the work" }] }],
};

async function setGoal(host: ReturnType<typeof makeHost>, objective: string, ctx: unknown) {
  await host.command.handler!(objective, ctx);
}

test("a context overflow that pi recovers keeps the goal running", async () => {
  const host = makeHost();
  const ctx = makeCtx();
  await setGoal(host, "ship the widget", ctx);
  assert.equal(currentGoal(host.entries)?.status, "active");

  // Attempt 1: the overflow. pi will compact and retry after this agent_end.
  await host.handlers.get("agent_start")!({}, ctx);
  await host.handlers.get("agent_end")!(overflowTurn, ctx);
  // Attempt 2: pi's compacted retry succeeds.
  await host.handlers.get("agent_start")!({}, ctx);
  await host.handlers.get("agent_end")!(successTurn, ctx);
  // Only now does the run settle.
  await host.handlers.get("agent_settled")!({}, ctx);

  const goal = currentGoal(host.entries);
  assert.equal(goal?.status, "active", "the recovered turn does not pause the goal");
  assert.notEqual(goal?.pauseCause, "error");
  assert.ok(continuationCount(host.sent) >= 2, "the loop queued another continuation");
});

test("a context overflow pi cannot recover pauses the goal at the settled boundary", async () => {
  const host = makeHost();
  const ctx = makeCtx();
  await setGoal(host, "ship the widget", ctx);
  const before = continuationCount(host.sent);

  await host.handlers.get("agent_start")!({}, ctx);
  await host.handlers.get("agent_end")!(overflowTurn, ctx);
  await host.handlers.get("agent_settled")!({}, ctx);

  const goal = currentGoal(host.entries);
  assert.equal(goal?.status, "paused");
  assert.equal(goal?.pauseCause, "error");
  assert.equal(continuationCount(host.sent), before, "a paused goal queues no continuation");
});

test("exhausted transient retries do not trip the no-progress detector", async () => {
  const host = makeHost();
  const ctx = makeCtx();
  await setGoal(host, "ship the widget", ctx);

  // Four 429 attempts inside one turn (default maxRetries exhausted).
  for (let i = 0; i < 4; i++) {
    await host.handlers.get("agent_start")!({}, ctx);
    await host.handlers.get("agent_end")!(rateLimitTurn, ctx);
  }
  await host.handlers.get("agent_settled")!({}, ctx);

  const goal = currentGoal(host.entries);
  assert.equal(goal?.status, "active", "a rate limit is ridden out, not paused");
  assert.equal(goal?.toolFreeRepeatCount, 0, "error attempts are not counted as tool-free repeats");
});

test("Esc during a goal turn still pauses as an interrupt", async () => {
  const host = makeHost();
  const controller = new AbortController();
  const ctx = makeCtx({ signal: controller.signal });
  await setGoal(host, "ship the widget", ctx);

  await host.handlers.get("agent_start")!({}, ctx);
  controller.abort();
  await host.handlers.get("agent_end")!(successTurn, ctx);

  const goal = currentGoal(host.entries);
  assert.equal(goal?.status, "paused");
  assert.equal(goal?.pauseCause, "interrupt");
});

test("an inactive goal appends no redundant snapshot on later turns", async () => {
  const host = makeHost();
  const ctx = makeCtx();
  await setGoal(host, "ship the widget", ctx);
  await host.command.handler!("pause", ctx);
  assert.equal(currentGoal(host.entries)?.status, "paused");

  const snapshotsAfterPause = goalSnapshotCount(host.entries);
  // Keep working in the same session; the goal is inactive.
  for (let i = 0; i < 3; i++) {
    await host.handlers.get("agent_start")!({}, ctx);
    await host.handlers.get("agent_end")!(successTurn, ctx);
    await host.handlers.get("agent_settled")!({}, ctx);
  }

  assert.equal(
    goalSnapshotCount(host.entries),
    snapshotsAfterPause,
    "no goal-state snapshot is appended while the goal is inactive",
  );
});
