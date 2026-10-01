import { test } from "node:test";
import assert from "node:assert/strict";
import goalExtension from "../extensions/goal.ts";
import { GOAL_STATE, createGoal, completeGoal } from "../src/state.ts";

/**
 * The five goal tools register inert and are revealed — merged into the
 * active set, never replacing it — the first time a live goal exists.
 */
type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

function makeHost(initialActive: string[]) {
  const handlers = new Map<string, Handler>();
  const tools: Array<{ name: string; defaultActive?: boolean }> = [];
  const setCalls: string[][] = [];
  let active = [...initialActive];
  let command: ((args: string, ctx: unknown) => Promise<void> | void) | undefined;
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    appendEntry() {},
    sendMessage() {},
    registerTool(def: { name: string; defaultActive?: boolean }) {
      tools.push(def);
    },
    registerCommand(_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> | void }) {
      command = def.handler;
    },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      setCalls.push([...names]);
      active = [...names];
    },
  };
  goalExtension(pi as never);
  return { handlers, tools, setCalls, command: command!, active: () => active };
}

const ctx = (branch: unknown[] = []) => ({
  hasUI: false,
  cwd: "/tmp",
  model: {},
  isIdle: () => true,
  hasPendingMessages: () => false,
  sessionManager: { getBranch: () => branch },
  signal: new AbortController().signal,
  ui: { notify() {}, setStatus() {}, setWidget() {} },
});

test("the goal tools register inert and a never-goal session never activates them", async () => {
  const h = makeHost(["read", "bash"]);
  const goalTools = h.tools.filter((t) => t.name.startsWith("goal_"));
  assert.equal(goalTools.length, 5);
  assert.ok(goalTools.every((t) => t.defaultActive === false), "every goal tool is defaultActive:false");
  await h.handlers.get("session_start")!({ reason: "startup" }, ctx());
  assert.deepEqual(h.setCalls, [], "no goal, no reveal");
});

test("/goal reveals the tools by merging into the active set, once", async () => {
  const h = makeHost(["read", "bash"]);
  await h.handlers.get("session_start")!({ reason: "startup" }, ctx());
  await h.command("ship the limiter", ctx());
  assert.equal(h.setCalls.length, 1);
  const names = h.active();
  assert.ok(names.includes("read") && names.includes("bash"), "the existing active set survives");
  for (const n of ["goal_status", "goal_complete", "goal_step_done", "goal_blocked", "goal_wait"]) assert.ok(names.includes(n), n);
  await h.command("status", ctx());
  assert.equal(h.setCalls.length, 1, "revealed once, never churned");
});

test("a replayed live goal reveals the tools at session start; a completed one does not", async () => {
  const live = createGoal("ship", 1, "g1");
  const h = makeHost(["read"]);
  await h.handlers.get("session_start")!({ reason: "resume" }, ctx([{ type: "custom", customType: GOAL_STATE, data: live }]));
  assert.equal(h.setCalls.length, 1);
  const done = makeHost(["read"]);
  await done.handlers.get("session_start")!({ reason: "resume" }, ctx([{ type: "custom", customType: GOAL_STATE, data: completeGoal(live, "done", 2) }]));
  assert.deepEqual(done.setCalls, []);
});
