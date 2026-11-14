import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { fixFailingTest, simulateFixFailingTest } from "../src/example.ts";
import { ancestors } from "../src/graph.ts";
import { layoutGraph } from "../src/layout.ts";
import { buildFocusedPrompt } from "../src/prompt.ts";
import { createRun, exportSnapshot, parseMachine, step } from "../src/runner.ts";

const machine = fixFailingTest();

test("example machine exports structure, loop, and error exits", () => {
  const snap = exportSnapshot(machine, createRun(machine));
  assert.equal(snap.machine.id, "fix-failing-test");
  assert.deepEqual(
    snap.machine.nodes.map((node) => node.id),
    ["claim", "search", "diagnose", "fix", "verify", "judge", "done", "gave-up"],
  );
  assert.ok(snap.machine.transitions.some((edge) => edge.isLoop && edge.label === "retries < 5"));
  assert.deepEqual(
    snap.machine.errorExits?.map((exit) => exit.label).sort(),
    ["max retries exceeded", "tests still failing"],
  );
  assert.equal(snap.execution.activeId, "claim");
  assert.deepEqual(snap.execution.completed, []);
  assert.deepEqual(snap.execution.visits, {});
  const raw = JSON.parse(JSON.stringify(snap)) as typeof snap;
  assert.equal(raw.machine.nodes.length, 8);
});

test("every node source line names that node", () => {
  const lines = fs.readFileSync(new URL("../src/example.ts", import.meta.url), "utf8").split("\n");
  for (const node of machine.nodes) {
    assert.ok(node.source, node.id);
    assert.equal(node.source.file, "src/example.ts");
    assert.match(lines[node.source.line - 1] ?? "", new RegExp(`id: "${node.id}"`));
  }
});

test("one failure retries fix, then the run finishes at done", () => {
  let run = createRun(machine);
  let guard = 0;
  while (run.status !== "done" && run.status !== "gave-up" && guard < 20) {
    run = step(machine, run, { failuresBeforePass: 1, simulate: simulateFixFailingTest });
    guard += 1;
  }
  assert.equal(run.status, "done");
  assert.equal(run.visits.fix, 2);
  assert.ok(run.completed.includes("search"));
  assert.ok(run.completed.includes("diagnose"));
  assert.equal(run.context["test-result"], "PASS");
  assert.equal(run.activeId, "done");
});

test("burning retries takes the max-retries exit and lands on gave-up", () => {
  let run = createRun(machine);
  let guard = 0;
  while (run.status !== "done" && run.status !== "gave-up" && guard < 40) {
    run = step(machine, run, { failuresBeforePass: 9, simulate: simulateFixFailingTest });
    guard += 1;
  }
  assert.equal(run.status, "gave-up");
  assert.ok(run.takenErrorExits.includes("max-retries"));
  assert.equal(run.visits.fix, 5);
  assert.equal(run.activeId, "gave-up");
});

test("focused prompt for fix names search and diagnose before they run", () => {
  const prompt = buildFocusedPrompt(machine, createRun(machine), "fix");
  assert.match(prompt.markdown, /Focused prompt — Fix/);
  assert.match(prompt.markdown, /search/);
  assert.match(prompt.markdown, /diagnose/);
  assert.match(prompt.markdown, /not yet run/);
  assert.ok(prompt.missing.includes("diagnosis"));
  assert.deepEqual(ancestors(machine, "fix"), ["claim", "search", "diagnose"]);
});

test("focused prompt includes search and diagnose outputs after they run", () => {
  let run = createRun(machine);
  for (let i = 0; i < 3; i++) {
    run = step(machine, run, { failuresBeforePass: 1, simulate: simulateFixFailingTest });
  }
  assert.deepEqual(run.completed, ["claim", "search", "diagnose"]);
  assert.equal(run.activeId, "fix");
  const prompt = buildFocusedPrompt(machine, run, "fix");
  assert.match(prompt.markdown, /applyRefund mixes a float/);
  assert.match(prompt.markdown, /Root cause/);
  assert.equal(prompt.missing.length, 0);
  assert.doesNotMatch(prompt.markdown, /Search[\s\S]*not yet run/);
});

test("structural steps never take the retry", () => {
  let run = createRun(machine);
  for (let i = 0; i < 8; i++) run = step(machine, run, { structural: true });
  assert.equal(run.visits.fix, 1);
  assert.equal(run.status, "done");
});

test("layout shows the loop pill and both error exits", () => {
  const layout = layoutGraph(machine);
  assert.equal(layout.nodes.length, machine.nodes.length);
  assert.ok(layout.pills.some((pill) => pill.kind === "loop" && /retries < 5/.test(pill.text)));
  assert.ok(layout.pills.some((pill) => pill.exitId === "max-retries"));
  assert.ok(layout.pills.some((pill) => pill.exitId === "still-failing"));
  assert.ok(layout.spine);
});

test("adding a node and a transition changes the layout", () => {
  const extra = parseMachine({
    ...machine,
    nodes: [
      ...machine.nodes,
      {
        id: "note",
        kind: "computer",
        label: "Note",
        promptOrDescription: "Write the postmortem.",
        source: { file: "src/example.ts", line: 1 },
      },
    ],
    transitions: [...machine.transitions, { from: "done", to: "note" }],
  });
  const before = layoutGraph(machine).nodes.map((box) => box.id);
  const after = layoutGraph(extra).nodes.map((box) => box.id);
  assert.ok(!before.includes("note"));
  assert.ok(after.includes("note"));
  assert.ok(after.indexOf("note") > after.indexOf("done"));
});

test("parseMachine rejects a dangling transition", () => {
  assert.throws(() => parseMachine({ id: "x", nodes: machine.nodes, transitions: [{ from: "claim", to: "nope" }] }), /unknown node/);
});
