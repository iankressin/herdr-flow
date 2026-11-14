import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { attachAgent, begin, commandResult, complete, createRun, fail, retry } from "../src/engine.ts";
import type { Run } from "../src/engine.ts";
import { fixFailingTest } from "../src/example.ts";
import { layoutGraph } from "../src/layout.ts";
import type { ComputerNode, Machine, Outcome } from "../src/machine.ts";
import { fillTemplate, nodeOf, parseMachine } from "../src/machine.ts";
import { buildAgentPrompt } from "../src/prompt.ts";
import { parseAgentResult } from "../src/result.ts";

const machine = fixFailingTest;
let clock = 1_000;

function newRun(m: Machine = machine): Run {
  return createRun(m, {
    id: "run-1",
    space: { id: "sp1", name: "repo" },
    folder: "/work/repo",
    inputs: { test_command: "npm test -- money" },
    now: clock,
  });
}

/** Runs each scripted [node, outcome], checking the engine asked for that node first. */
function play(run: Run, script: [string, Outcome][]): Run {
  for (const [expected, outcome] of script) {
    const started = begin(run, ++clock);
    assert.equal(started.run.status.kind, "executing", `begin ${expected}`);
    assert.equal(started.effect.kind === "none" ? null : started.effect.node, expected);
    const node = nodeOf(machine, expected);
    const visit = (started.run.visits[expected] ?? 0) + 1;
    const result =
      node.kind === "computer"
        ? commandResult(node, { exitCode: outcome === "pass" ? 0 : 1, output: `${expected} output ${visit}` })
        : {
            outcome,
            summary: `${expected} summary ${visit}`,
            values: Object.fromEntries((node.produces ?? []).map((key) => [key, `${key} value ${visit}`])),
            by: "agent" as const,
          };
    run = complete(started.run, result, ++clock);
  }
  return run;
}

function rawExample(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(machine));
}

test("parseMachine accepts the example unchanged", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(parseMachine(rawExample()))), rawExample());
});

test("parseMachine rejects a dangling edge", () => {
  const raw = rawExample();
  raw.transitions = [...(raw.transitions as object[]), { from: "judge", on: "fail", to: "nowhere" }];
  assert.throws(() => parseMachine(raw), /unknown node nowhere/);
});

test("parseMachine rejects a working node without a pass edge", () => {
  const raw = rawExample();
  raw.transitions = (raw.transitions as { from: string; on: string }[]).filter((e) => !(e.from === "diagnose" && e.on === "pass"));
  assert.throws(() => parseMachine(raw), /diagnose has no "pass" transition/);
});

test("parseMachine rejects an edge out of an end node", () => {
  const raw = rawExample();
  raw.transitions = [...(raw.transitions as object[]), { from: "done", on: "pass", to: "claim" }];
  assert.throws(() => parseMachine(raw), /leaves end node done/);
});

test("parseMachine rejects maxVisits without onExhausted", () => {
  const raw = rawExample();
  delete raw.onExhausted;
  assert.throws(() => parseMachine(raw), /needs onExhausted/);
});

test("claim passing ends the run at already-passing", () => {
  const run = play(newRun(), [["claim", "pass"]]);
  assert.deepEqual(run.status, { kind: "finished", end: "already-passing", result: "success" });
});

test("one verify failure sends the run back to fix, then it finishes at done", () => {
  const run = play(newRun(), [
    ["claim", "fail"],
    ["search", "pass"],
    ["diagnose", "pass"],
    ["fix", "pass"],
    ["verify", "fail"],
    ["fix", "pass"],
    ["verify", "pass"],
    ["judge", "pass"],
  ]);
  assert.deepEqual(run.status, { kind: "finished", end: "done", result: "success" });
  assert.equal(run.visits.fix, 2);
  assert.equal(run.context.patch, "patch value 2");
  assert.equal(run.attempts.length, 8);
});

test("five verify failures exhaust fix and end at gave-up", () => {
  const loop: [string, Outcome][] = [];
  for (let i = 0; i < 5; i++) loop.push(["fix", "pass"], ["verify", "fail"]);
  const run = play(newRun(), [["claim", "fail"], ["search", "pass"], ["diagnose", "pass"], ...loop]);
  assert.deepEqual(run.status, {
    kind: "finished",
    end: "gave-up",
    result: "failure",
    note: "max retries exceeded at Fix",
    exhausted: "fix",
  });
  assert.equal(run.visits.fix, 5);
  assert.equal(begin(run, ++clock).effect.kind, "none");
});

test("a computer node runs its command filled from inputs", () => {
  const started = begin(newRun(), ++clock);
  assert.deepEqual(started.effect, { kind: "command", node: "claim", command: "npm test -- money", env: {}, timeoutSec: 600 });
});

test("step values reach a command only as FLOW_ environment variables", () => {
  const hostile = 'x"; touch /tmp/pwned; "';
  let run = play(newRun(), [["claim", "fail"], ["search", "pass"], ["diagnose", "pass"]]);
  run = begin(run, ++clock).run;
  run = complete(run, { outcome: "pass", summary: "Patched.", values: { patch: hostile }, by: "agent" }, ++clock);
  const { effect } = begin(run, ++clock);
  assert.equal(effect.kind, "command");
  if (effect.kind !== "command") return;
  assert.equal(effect.command, "npm test -- money");
  assert.ok(!effect.command.includes("pwned"));
  assert.equal(effect.env.FLOW_PATCH, hostile);
  assert.equal(effect.env.FLOW_VERIFY_OUTPUT, undefined);
});

test("parseMachine keeps step values out of command text and off input keys", () => {
  const raw = rawExample();
  (raw.nodes as { id: string; run?: string }[])[4]!.run = "echo {{diagnosis}}";
  assert.throws(() => parseMachine(raw), /verify run uses \{\{diagnosis\}\}, but only inputs can fill a command; read a step value from \$FLOW_DIAGNOSIS/);

  const shadow = rawExample();
  (shadow.nodes as { id: string; produces?: string[] }[])[3]!.produces = ["patch", "test_command"];
  assert.throws(() => parseMachine(shadow), /fix produces "test_command", which is an input key/);
});

test("a step value under an input's key cannot override the input", () => {
  let run = play(newRun(), [["claim", "fail"]]);
  const values = { findings: "money.ts", test_command: "rm -rf ~" };
  run = complete(begin(run, ++clock).run, { outcome: "pass", summary: "Found it.", values, by: "agent" }, ++clock);
  const prompt = buildAgentPrompt(begin(run, ++clock).run, "diagnose", { resultPath: "/r" });
  assert.match(prompt, /would make `npm test -- money` pass/);
  assert.match(prompt, /Test command that fails now \(`test_command`\): npm test -- money/);
  assert.doesNotMatch(prompt, /rm -rf/);
});

test("a command whose input is unset fails the run instead of running", () => {
  const raw = rawExample();
  raw.inputs = [...(raw.inputs as object[]), { key: "shard", label: "Shard" }];
  (raw.nodes as { id: string; run?: string }[])[0]!.run = "{{test_command}} {{shard}}";
  const started = begin(newRun(parseMachine(raw)), ++clock);
  assert.equal(started.effect.kind, "none");
  assert.deepEqual(started.run.status, { kind: "failed", node: "claim", error: "Claim needs {{shard}}, which no input set" });
});

test("a person can decide a failed step, and retry runs it again", () => {
  let run = play(newRun(), [["claim", "fail"]]);
  const started = begin(run, ++clock);
  run = fail(attachAgent(started.run, { tab: "tb1", terminal: "t9", promptPath: "/p", resultPath: "/r" }), "launch failed");
  assert.deepEqual(run.status, { kind: "failed", node: "search", error: "launch failed" });
  assert.deepEqual(retry(run).status, { kind: "idle", next: "search" });
  run = complete(run, { outcome: "pass", summary: "Found it by hand.", values: { findings: "money.ts" }, by: "person" }, ++clock);
  assert.deepEqual(run.status, { kind: "idle", next: "diagnose" });
  assert.equal(run.attempts.at(-1)!.by, "person");
});

test("commandResult keeps the output tail under each produces key", () => {
  const verify = nodeOf(machine, "verify") as ComputerNode;
  const long = `${"x".repeat(9000)}\nlast line`;
  const failed = commandResult(verify, { exitCode: 2, output: long });
  assert.equal(failed.outcome, "fail");
  assert.equal(failed.exitCode, 2);
  assert.ok(failed.values.verify_output!.endsWith("last line"));
  assert.ok(failed.values.verify_output!.length <= 8001);
  assert.match(failed.summary, /^Exit code 2\.\n[\s\S]*last line$/);
  assert.deepEqual(commandResult(verify, { error: "timed out", output: "" }).outcome, "fail");
});

test("the fix prompt on a revisit carries the diagnosis, the latest verify output and the result contract", () => {
  let run = play(newRun(), [
    ["claim", "fail"],
    ["search", "pass"],
    ["diagnose", "pass"],
    ["fix", "pass"],
    ["verify", "fail"],
  ]);
  run = begin(run, ++clock).run;
  const prompt = buildAgentPrompt(run, "fix", { resultPath: "/runs/run-1/fix-2.result.json" });
  assert.match(prompt, /^You are the Fix step of the Flow run "Fix failing test" \(run-1\)\. This is visit 2 of this step, out of at most 5\./);
  assert.match(prompt, /diagnosis value 1/);
  assert.match(prompt, /Verify ended "fail" on attempt 1/);
  assert.match(prompt, /verify output 1/);
  assert.match(prompt, /`\/runs\/run-1\/fix-2\.result\.json`/);
  assert.ok(prompt.includes('{"outcome":"pass"|"fail","summary":"<2-5 sentences>","values":{"patch":"<string>"}}'));
  assert.match(prompt, /Apply the diagnosis as the smallest change that makes `npm test -- money` pass/);

  run = complete(run, { outcome: "pass", summary: "fix summary 2", values: { patch: "patch value 2" }, by: "agent" }, ++clock);
  run = begin(play(run, [["verify", "fail"]]), ++clock).run;
  const third = buildAgentPrompt(run, "fix", { resultPath: "/r" });
  assert.match(third, /verify output 2/);
  assert.doesNotMatch(third, /verify output 1/);
});

test("parseAgentResult accepts the contract and rejects a bad outcome or a missing value", () => {
  assert.deepEqual(parseAgentResult('{"outcome":"pass","summary":"Done.","values":{"patch":"a.ts","extra":"x"}}', ["patch"]), {
    outcome: "pass",
    summary: "Done.",
    values: { patch: "a.ts" },
  });
  assert.match((parseAgentResult('{"outcome":"ok","summary":"Done.","values":{"patch":"a.ts"}}', ["patch"]) as { error: string }).error, /outcome/);
  assert.match((parseAgentResult('{"outcome":"pass","summary":"Done.","values":{}}', ["patch"]) as { error: string }).error, /values\.patch is missing/);
  assert.match((parseAgentResult('{"outcome":"pass",', ["patch"]) as { error: string }).error, /not valid JSON/);
});

test("layout shows the retry pill, the red fail pills and the exhaustion pill, and marks the ones taken", () => {
  const plain = layoutGraph(machine);
  assert.deepEqual(plain.nodes.map((box) => box.id), [
    "claim", "search", "diagnose", "fix", "verify", "judge", "already-passing", "done", "gave-up",
  ]);
  const text = (kind: string) => plain.pills.filter((pill) => pill.kind === kind).map((pill) => `${pill.node}: ${pill.text}`);
  assert.deepEqual(text("budget"), ["fix: retries < 5"]);
  assert.ok(text("fail").includes("verify: tests still failing"));
  assert.ok(text("fail").includes("judge: reject"));
  assert.ok(text("fail").includes("claim: on fail → Search"));
  assert.deepEqual(text("exhausted"), ["fix: max retries → Gave up"]);
  assert.ok(plain.pills.every((pill) => !pill.taken));

  const loop: [string, Outcome][] = [];
  for (let i = 0; i < 5; i++) loop.push(["fix", "pass"], ["verify", "fail"]);
  const run = play(newRun(), [["claim", "fail"], ["search", "pass"], ["diagnose", "pass"], ...loop]);
  const taken = layoutGraph(machine, run).pills.filter((pill) => pill.taken).map((pill) => `${pill.node}: ${pill.text}`);
  assert.deepEqual(taken, ["claim: on fail → Search", "fix: max retries → Gave up", "verify: tests still failing"]);
});

test("every example node's source line sets that node's id", () => {
  const lines = fs.readFileSync(new URL("../src/example.ts", import.meta.url), "utf8").split("\n");
  for (const node of machine.nodes) {
    assert.equal(node.source?.file, "src/example.ts", node.id);
    assert.match(lines[node.source.line - 1] ?? "", new RegExp(`id: "${node.id}"`), node.id);
  }
});

test("fillTemplate fills known keys and leaves unknown ones", () => {
  assert.equal(fillTemplate("run {{ a }} then {{b}}", { a: "x" }), "run x then {{b}}");
});
