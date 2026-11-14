import assert from "node:assert/strict";
import test from "node:test";

import { agentLook, START_GRACE_MS } from "../src/agentstate.ts";
import type { AgentInput } from "../src/agentstate.ts";

const silent: AgentInput = { status: null, live: true, sinceMs: 0, screen: null, error: null };

test("a live terminal with no agent status is starting before the grace period", () => {
  assert.deepEqual(agentLook({ ...silent, sinceMs: START_GRACE_MS - 1 }), { text: "starting", spin: true });
});

test("after the grace period it needs the person, in its tab", () => {
  const look = agentLook({ ...silent, sinceMs: START_GRACE_MS });
  assert.equal(look.text, "waiting in its tab: open it");
  assert.equal(look.blocked, true);
  assert.equal(look.notStarted, true);
});

test("the trust dialog on screen is named", () => {
  const screen = "Is this a project you created or one you trust?\n> No, exit\n  Yes, I trust this folder";
  const look = agentLook({ ...silent, sinceMs: START_GRACE_MS + 1, screen });
  assert.equal(look.text, "Claude asks to trust this folder: open it");
  assert.equal(look.blocked, true);
});

test("unrelated screen text keeps the generic message", () => {
  assert.equal(agentLook({ ...silent, sinceMs: START_GRACE_MS, screen: "Welcome back" }).text, "waiting in its tab: open it");
});

test("screen text before the grace period does not change starting", () => {
  assert.equal(agentLook({ ...silent, sinceMs: 1000, screen: "trust this folder" }).text, "starting");
});

test("once the agent reports a status the normal mapping applies, even late and with trust text", () => {
  const late = { ...silent, sinceMs: 60_000, screen: "trust this folder" };
  assert.deepEqual(agentLook({ ...late, status: "working" }), { text: "working", spin: true });
  assert.deepEqual(agentLook({ ...late, status: "blocked" }), { text: "needs you", blocked: true });
  assert.deepEqual(agentLook({ ...late, status: "idle" }), { text: "stopped without a result", stuck: true });
  assert.equal(agentLook({ ...late, status: "idle", error: "bad json" }).text, "bad result: bad json");
});

test("a terminal that is gone is closed, not waiting", () => {
  assert.deepEqual(agentLook({ ...silent, live: false, sinceMs: 60_000 }), { text: "closed", stuck: true });
});
