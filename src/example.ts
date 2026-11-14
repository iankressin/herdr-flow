import type { Machine, MachineNode, ProduceResult, RunState } from "./types.ts";
import type { StepOptions } from "./runner.ts";

const FILE = "src/example.ts";

/**
 * Fix a failing test.
 * claim → search → diagnose → fix → verify → judge → done
 * fix loops while retries < 5. verify can return to fix, or the run gives up.
 */
export function fixFailingTest(): Machine {
  return {
    id: "fix-failing-test",
    nodes: [
      {
        id: "claim",
        kind: "computer",
        label: "Claim",
        promptOrDescription:
          "Claim the failing test. Record the file, the assertion, and the exact command that reproduces it. Do not edit code yet.",
        source: { file: FILE, line: 16 },
        produces: ["claim"],
      },
      {
        id: "search",
        kind: "agent",
        label: "Search",
        promptOrDescription:
          "Search the repo for the code behind the failing assertion. Report the functions and files that can produce the bad value. Do not patch yet.",
        source: { file: FILE, line: 25 },
        requires: ["claim"],
        produces: ["findings"],
      },
      {
        id: "diagnose",
        kind: "agent",
        label: "Diagnose",
        promptOrDescription:
          "From the search findings, name the root cause in one paragraph and the smallest change that would make the test pass.",
        source: { file: FILE, line: 35 },
        requires: ["findings"],
        produces: ["diagnosis"],
      },
      {
        id: "fix",
        kind: "agent",
        label: "Fix",
        promptOrDescription:
          "Apply the diagnosis as a minimal patch. Stay inside the files the diagnosis named. Do not weaken the test.",
        source: { file: FILE, line: 45 },
        requires: ["diagnosis"],
        produces: ["patch"],
      },
      {
        id: "verify",
        kind: "computer",
        label: "Verify",
        promptOrDescription:
          "Run the claimed test command. Record pass or fail and the relevant assertion output. Do not edit code.",
        source: { file: FILE, line: 55 },
        requires: ["patch"],
        produces: ["test-result"],
      },
      {
        id: "judge",
        kind: "agent",
        label: "Judge",
        promptOrDescription:
          "Read the test result. Accept only a real pass of the original assertion. Otherwise say the run should stop.",
        source: { file: FILE, line: 65 },
        requires: ["test-result"],
        produces: ["verdict"],
      },
      {
        id: "done",
        kind: "computer",
        label: "Done",
        promptOrDescription: "The original test passes. Stop. Summarize the patch in two sentences.",
        source: { file: FILE, line: 75 },
        requires: ["verdict"],
      },
      {
        id: "gave-up",
        kind: "computer",
        label: "Gave up",
        promptOrDescription:
          "Stop without a green test. State which exit fired and what is still wrong. Do not keep editing.",
        source: { file: FILE, line: 83 },
      },
    ],
    transitions: [
      { from: "claim", to: "search" },
      { from: "search", to: "diagnose" },
      { from: "diagnose", to: "fix" },
      { from: "fix", to: "fix", label: "retries < 5", isLoop: true },
      { from: "fix", to: "verify" },
      { from: "verify", to: "judge", label: "tests pass" },
      { from: "verify", to: "fix", label: "tests still failing", isError: true },
      { from: "judge", to: "done", label: "accept" },
      { from: "judge", to: "gave-up", label: "reject", isError: true },
    ],
    errorExits: [
      { id: "max-retries", label: "max retries exceeded", from: "fix" },
      { id: "still-failing", label: "tests still failing", from: "verify" },
    ],
  };
}

export function simulateFixFailingTest(
  node: MachineNode,
  run: RunState,
  options: StepOptions,
): ProduceResult {
  const failures = options.failuresBeforePass ?? 1;
  switch (node.id) {
    case "claim":
      return {
        output:
          "Claimed checkout.test.ts: refund drops one cent. Command: npm test -- checkout.test.ts",
        values: { claim: "checkout.test.ts refund drops one cent" },
        hint: "ok",
      };
    case "search":
      return {
        output:
          "Searched refund and money helpers. applyRefund mixes a float dollar amount with integer cents.",
        values: { findings: "applyRefund mixes float dollars with integer cents" },
        hint: "ok",
      };
    case "diagnose":
      return {
        output:
          "Root cause: applyRefund subtracts a float from integer cents, so checkout.test.ts fails by 1.",
        values: { diagnosis: "coerce applyRefund to integer cents before subtracting" },
        hint: "ok",
      };
    case "fix": {
      const attempt = run.visits.fix ?? 1;
      return {
        output: `Patch attempt ${attempt}: coerce the refund to integer cents before subtracting.`,
        values: { patch: `attempt ${attempt}: integer cents` },
        hint: "ok",
      };
    }
    case "verify": {
      const attempts = run.visits.fix ?? 0;
      if (attempts <= failures) {
        return {
          output: `FAIL checkout.test.ts — refund still off by 1 cent (attempt ${attempts}).`,
          values: { "test-result": `FAIL attempt ${attempts}` },
          hint: "error",
        };
      }
      return {
        output: "PASS checkout.test.ts (12 tests).",
        values: { "test-result": "PASS" },
        hint: "ok",
      };
    }
    case "judge": {
      const result = run.context["test-result"] ?? "";
      if (result.startsWith("PASS")) {
        return {
          output: "Verdict: the original assertion passes. Accept.",
          values: { verdict: "accept" },
          hint: "ok",
        };
      }
      return {
        output: "Verdict: the original assertion still fails. Reject.",
        values: { verdict: "reject" },
        hint: "give-up",
      };
    }
    case "done":
      return { output: "Exit: done. The refund test passes.", values: {}, hint: "ok" };
    case "gave-up":
      return {
        output: "Exit: gave up. The test is still red or the retry budget is spent.",
        values: {},
        hint: "ok",
      };
    default:
      return { output: node.promptOrDescription, values: {}, hint: "ok" };
  }
}
