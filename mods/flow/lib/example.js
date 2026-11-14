const FILE = "src/example.ts";
/**
 * claim runs the test. If it already passes, the run ends. Otherwise search, diagnose and fix,
 * then verify runs the test again: a failure goes back to fix (at most five fixes), a pass goes to
 * judge, which reviews the diff before the run ends at done.
 */
export const fixFailingTest = {
    id: "fix-failing-test",
    title: "Fix failing test",
    inputs: [{ key: "test_command", label: "Test command that fails now" }],
    start: "claim",
    onExhausted: "gave-up",
    nodes: [
        {
            id: "claim",
            kind: "computer",
            label: "Claim",
            source: { file: FILE, line: 18 },
            run: "{{test_command}}",
            produces: ["failure"],
        },
        {
            id: "search",
            kind: "agent",
            label: "Search",
            source: { file: FILE, line: 26 },
            requires: ["failure"],
            produces: ["findings"],
            prompt: "The test command `{{test_command}}` fails; its output is under `failure` below. " +
                "Find the code behind the failing assertion: the test, the functions it calls, and the files that can produce the wrong value. " +
                "Read only: do not create, edit or delete any file. " +
                "In findings, list each relevant file and function with one line on why it matters. " +
                'Use "fail" only if you cannot find the code under test.',
        },
        {
            id: "diagnose",
            kind: "agent",
            label: "Diagnose",
            source: { file: FILE, line: 40 },
            requires: ["failure", "findings"],
            produces: ["diagnosis"],
            prompt: "From the failing output and the search findings, name the root cause in one paragraph, " +
                "then the smallest change to the code under test that would make `{{test_command}}` pass. " +
                "Do not edit files. Put both in diagnosis. " +
                'Use "fail" if the evidence does not point at one cause.',
        },
        {
            id: "fix",
            kind: "agent",
            label: "Fix",
            source: { file: FILE, line: 53 },
            maxVisits: 5,
            requires: ["diagnosis"],
            produces: ["patch"],
            prompt: "Apply the diagnosis as the smallest change that makes `{{test_command}}` pass. " +
                "Change the code where the diagnosis located the root cause, the code under test or the test and build configuration. " +
                "Do not weaken, skip or delete assertions, change expected values, or change the test command. " +
                "Run `{{test_command}}` yourself and check that it passes before you write your result. " +
                "In patch, list each file you changed and what changed in it. " +
                'Use "fail" only if you cannot make a change you believe in.',
        },
        {
            id: "verify",
            kind: "computer",
            label: "Verify",
            source: { file: FILE, line: 69 },
            requires: ["patch"],
            run: "{{test_command}}",
            produces: ["verify_output"],
        },
        {
            id: "judge",
            kind: "agent",
            label: "Judge",
            source: { file: FILE, line: 78 },
            requires: ["diagnosis", "verify_output"],
            produces: ["verdict"],
            prompt: "`{{test_command}}` passes now. Review the change with `git diff` and `git status` against the diagnosis and the passing output below. " +
                "Pass if the original failing test now passes for a real reason: the change is small and addresses the root cause where the diagnosis located it, " +
                "in the code under test or in the test or build configuration, and no test was deleted, skipped or weakened (no changed expected values, no relaxed assertions). " +
                'Fail on a weakened or removed test, an unrelated change, or a pass that does not follow from the change. ' +
                "Do not edit files. Say why in verdict.",
        },
        {
            id: "already-passing",
            kind: "end",
            label: "Already passing",
            source: { file: FILE, line: 92 },
            result: "success",
            description: "Nothing to fix",
        },
        {
            id: "done",
            kind: "end",
            label: "Done",
            source: { file: FILE, line: 100 },
            result: "success",
            description: "The test passes and the judge accepted the change",
        },
        {
            id: "gave-up",
            kind: "end",
            label: "Gave up",
            source: { file: FILE, line: 108 },
            result: "failure",
            description: "Flow stopped without an accepted fix",
        },
    ],
    transitions: [
        { from: "claim", on: "pass", to: "already-passing" },
        { from: "claim", on: "fail", to: "search", label: "fails, as expected → Search" },
        { from: "search", on: "pass", to: "diagnose" },
        { from: "search", on: "fail", to: "gave-up" },
        { from: "diagnose", on: "pass", to: "fix" },
        { from: "diagnose", on: "fail", to: "gave-up" },
        { from: "fix", on: "pass", to: "verify" },
        { from: "fix", on: "fail", to: "gave-up" },
        { from: "verify", on: "pass", to: "judge", label: "tests pass" },
        { from: "verify", on: "fail", to: "fix", label: "tests still failing" },
        { from: "judge", on: "pass", to: "done", label: "accept" },
        { from: "judge", on: "fail", to: "gave-up", label: "reject" },
    ],
};
