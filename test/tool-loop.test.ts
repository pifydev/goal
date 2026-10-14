import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolLoopRing } from "../src/tool-loop.ts";

test("five identical tool calls in a row trip once, then the ring clears", () => {
  const ring = new ToolLoopRing();
  for (let i = 0; i < 4; i++) assert.equal(ring.push("bash", { command: "pytest" }), null, `call ${i + 1}`);
  const reason = ring.push("bash", { command: "pytest" });
  assert.match(reason ?? "", /the same `bash` call repeated 5 times in a row/);
  // Cleared: it does not re-fire on the very next identical call.
  assert.equal(ring.push("bash", { command: "pytest" }), null);
});

test("argument order does not matter, but different arguments or tools reset the run", () => {
  const ring = new ToolLoopRing();
  ring.push("read", { path: "a.ts", offset: 1 });
  assert.equal(ring.push("read", { offset: 1, path: "a.ts" }), null, "same call, keys reordered");
  assert.equal(ring.push("read", { path: "b.ts" }), null, "a different file breaks the run");
  // Different tools never trip, however many.
  const mix = new ToolLoopRing();
  for (const t of ["read", "bash", "read", "bash", "read"]) assert.equal(mix.push(t, {}), null);
});

test("the window is configurable and floored at two; reset() clears a partial run", () => {
  const ring = new ToolLoopRing(3);
  assert.equal(ring.push("x", {}), null, "1 of 3");
  ring.reset();
  assert.equal(ring.push("x", {}), null, "1 of 3 after reset");
  assert.equal(ring.push("x", {}), null, "2 of 3");
  assert.match(ring.push("x", {}) ?? "", /repeated 3 times/, "3 of 3 trips");
  // A window below two is floored at two: two identical calls trip.
  const floored = new ToolLoopRing(1);
  assert.equal(floored.push("x", {}), null);
  assert.match(floored.push("x", {}) ?? "", /repeated 2 times/);
});
