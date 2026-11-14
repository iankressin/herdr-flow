import { MAX_TIMEOUT_SEC, envName, fillTemplate, missingKeys, nodeOf, transitionFor } from "./machine.js";
/** How much command output a step keeps as its value. */
export const OUTPUT_TAIL = 8000;
const SUMMARY_LINES = 8;
/** Values for `{{key}}` in agent prompts. Inputs win over step values. */
export function templateValues(run) {
    return { ...run.context, ...run.inputs };
}
export function commandEnv(run) {
    return Object.fromEntries(Object.entries(run.context).map(([key, value]) => [envName(key), value]));
}
function isExhausted(run, node) {
    return node.maxVisits != null && (run.visits[node.id] ?? 0) >= node.maxVisits;
}
/** Moving onto a node: an end node or a spent budget finishes the run; anything else waits to begin. */
function arrive(run, target) {
    const node = nodeOf(run.machine, target);
    if (node.kind === "end") {
        return { ...run, status: { kind: "finished", end: node.id, result: node.result } };
    }
    if (!isExhausted(run, node))
        return { ...run, status: { kind: "idle", next: node.id } };
    const end = run.machine.onExhausted == null ? null : nodeOf(run.machine, run.machine.onExhausted);
    if (end?.kind !== "end") {
        return { ...run, status: { kind: "failed", node: node.id, error: `max retries exceeded at ${node.label}, and the machine has no onExhausted end` } };
    }
    return {
        ...run,
        status: { kind: "finished", end: end.id, result: end.result, note: `max retries exceeded at ${node.label}`, exhausted: node.id },
    };
}
/**
 * Whether `path` is `folder` or sits under it; pass both through realpath first. Flow refuses a run
 * folder that holds its own data folder, since agents can write where they work.
 */
export function isInside(path, folder) {
    const base = folder.replace(/\/+$/, "");
    return path === base || path.startsWith(`${base}/`);
}
export function createRun(machine, init) {
    const run = {
        id: init.id,
        machine,
        space: init.space,
        folder: init.folder,
        inputs: init.inputs,
        auto: false,
        status: { kind: "idle", next: machine.start },
        visits: {},
        context: {},
        attempts: [],
        createdAt: init.now,
        updatedAt: init.now,
    };
    return arrive(run, machine.start);
}
/** What the shell must do for the node the run is executing; `none` otherwise. Resume calls this too. */
export function pendingEffect(run) {
    if (run.status.kind !== "executing")
        return { kind: "none" };
    const node = nodeOf(run.machine, run.status.node);
    switch (node.kind) {
        case "computer":
            return {
                kind: "command",
                node: node.id,
                command: fillTemplate(node.run, run.inputs),
                env: commandEnv(run),
                timeoutSec: node.timeoutSec ?? MAX_TIMEOUT_SEC,
            };
        case "agent":
            return { kind: "agent", node: node.id, visit: run.status.visit };
        case "end":
            return { kind: "none" };
    }
}
export function begin(run, now) {
    if (run.status.kind !== "idle")
        return { run, effect: { kind: "none" } };
    const node = nodeOf(run.machine, run.status.next);
    if (node.kind === "end" || isExhausted(run, node))
        return { run: arrive(run, node.id), effect: { kind: "none" } };
    if (node.kind === "computer") {
        const missing = missingKeys(node.run, run.inputs);
        if (missing.length) {
            const names = missing.map((key) => `{{${key}}}`).join(", ");
            return {
                run: { ...run, status: { kind: "failed", node: node.id, error: `${node.label} needs ${names}, which no input set` } },
                effect: { kind: "none" },
            };
        }
    }
    const executing = {
        ...run,
        status: { kind: "executing", node: node.id, visit: (run.visits[node.id] ?? 0) + 1, startedAt: now },
    };
    return { run: executing, effect: pendingEffect(executing) };
}
export function isExecuting(run, node, visit) {
    return run.status.kind === "executing" && run.status.node === node && run.status.visit === visit;
}
export function attachAgent(run, agent) {
    if (run.status.kind !== "executing")
        return run;
    return { ...run, status: { ...run.status, agent } };
}
/** Records an attempt at the executing node (or the failed one, when a person decides it) and follows its edge. */
export function complete(run, result, now) {
    const status = run.status;
    if (status.kind !== "executing" && status.kind !== "failed")
        return run;
    const node = nodeOf(run.machine, status.node);
    const visit = (run.visits[node.id] ?? 0) + 1;
    const agent = status.kind === "executing" ? status.agent : undefined;
    const attempt = {
        node: node.id,
        visit,
        outcome: result.outcome,
        summary: result.summary,
        values: result.values,
        startedAt: status.kind === "executing" ? status.startedAt : now,
        endedAt: now,
        ...(result.exitCode != null ? { exitCode: result.exitCode } : {}),
        ...(agent?.terminal != null ? { terminal: agent.terminal } : {}),
        ...(agent != null ? { tab: agent.tab } : {}),
        by: result.by,
    };
    const recorded = {
        ...run,
        visits: { ...run.visits, [node.id]: visit },
        context: { ...run.context, ...result.values },
        attempts: [...run.attempts, attempt],
    };
    const edge = transitionFor(run.machine, node.id, result.outcome);
    if (!edge) {
        return {
            ...recorded,
            status: { kind: "failed", node: node.id, error: `${node.label} ended "${result.outcome}" and has no "${result.outcome}" transition` },
        };
    }
    return arrive(recorded, edge.to);
}
export function fail(run, error) {
    switch (run.status.kind) {
        case "executing":
            return { ...run, status: { kind: "failed", node: run.status.node, error } };
        case "idle":
            return { ...run, status: { kind: "failed", node: run.status.next, error } };
        default:
            return run;
    }
}
export function retry(run) {
    return run.status.kind === "failed" ? arrive(run, run.status.node) : run;
}
export function setAuto(run, on) {
    return run.auto === on ? run : { ...run, auto: on };
}
function tail(text) {
    return text.length <= OUTPUT_TAIL ? text : `…${text.slice(-OUTPUT_TAIL)}`;
}
/** The shell could not run the command (126 not executable, 127 not found): an infrastructure fault, not a step outcome. */
export function commandProblem(ran) {
    if ("error" in ran || (ran.exitCode !== 126 && ran.exitCode !== 127))
        return null;
    const last = tail(ran.output.trimEnd()).split("\n").slice(-SUMMARY_LINES).join("\n");
    return `Command could not run (exit ${ran.exitCode})${last ? `: ${last}` : ""}`;
}
/** A finished command as a step result: exit 0 passes; the output tail goes under each `produces` key. */
export function commandResult(node, ran) {
    const output = tail(ran.output.trimEnd());
    const values = Object.fromEntries((node.produces ?? []).map((key) => [key, output]));
    if ("error" in ran)
        return { outcome: "fail", summary: ran.error, values, by: "computer" };
    const last = output.split("\n").slice(-SUMMARY_LINES).join("\n");
    return {
        outcome: ran.exitCode === 0 ? "pass" : "fail",
        summary: `Exit code ${ran.exitCode}.${last ? `\n${last}` : ""}`,
        values,
        exitCode: ran.exitCode,
        by: "computer",
    };
}
