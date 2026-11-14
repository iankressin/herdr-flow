import { isRecord, parseMachine } from "./machine.js";
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TAB_ID = /^tb[0-9a-f]{32}$/;
const BY = ["computer", "agent", "person"];
function bad(what) {
    throw new Error(`run.json ${what}`);
}
function isTime(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function isVisit(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
function text(value, where) {
    if (typeof value !== "string")
        bad(`${where} must be a string`);
    return value;
}
function strings(value, where) {
    if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string"))
        bad(`${where} must map keys to strings`);
    return { ...value };
}
function nodeId(machine, value, where, kinds) {
    const node = machine.nodes.find((item) => item.id === value);
    if (!node || (kinds && !kinds.includes(node.kind)))
        bad(`${where} must name a${kinds ? ` ${kinds.join(" or ")}` : ""} node`);
    return node.id;
}
function parseHandle(raw) {
    if (!isRecord(raw))
        bad("status.agent must be an object");
    if (typeof raw.tab !== "string" || !TAB_ID.test(raw.tab))
        bad("status.agent.tab must be a tab id");
    return {
        tab: raw.tab,
        ...(raw.terminal != null ? { terminal: text(raw.terminal, "status.agent.terminal") } : {}),
        promptPath: text(raw.promptPath, "status.agent.promptPath"),
        resultPath: text(raw.resultPath, "status.agent.resultPath"),
    };
}
function parseStatus(raw, machine) {
    if (!isRecord(raw))
        bad("status must be an object");
    switch (raw.kind) {
        case "idle":
            return { kind: "idle", next: nodeId(machine, raw.next, "status.next") };
        case "executing": {
            if (!isVisit(raw.visit))
                bad("status.visit must be a whole number from 1");
            if (!isTime(raw.startedAt))
                bad("status.startedAt must be a time");
            const node = nodeId(machine, raw.node, "status.node", ["computer", "agent"]);
            const agent = raw.agent == null ? {} : { agent: parseHandle(raw.agent) };
            return { kind: "executing", node, visit: raw.visit, startedAt: raw.startedAt, ...agent };
        }
        case "finished": {
            if (raw.result !== "success" && raw.result !== "failure")
                bad('status.result must be "success" or "failure"');
            return {
                kind: "finished",
                end: nodeId(machine, raw.end, "status.end", ["end"]),
                result: raw.result,
                ...(raw.note != null ? { note: text(raw.note, "status.note") } : {}),
                ...(raw.exhausted != null ? { exhausted: nodeId(machine, raw.exhausted, "status.exhausted") } : {}),
            };
        }
        case "failed":
            return { kind: "failed", node: nodeId(machine, raw.node, "status.node"), error: text(raw.error, "status.error") };
        default:
            return bad("status.kind must be idle, executing, finished or failed");
    }
}
function parseAttempt(raw, index, machine) {
    const where = `attempts[${index}]`;
    if (!isRecord(raw))
        bad(`${where} must be an object`);
    if (!isVisit(raw.visit))
        bad(`${where}.visit must be a whole number from 1`);
    if (raw.outcome !== "pass" && raw.outcome !== "fail")
        bad(`${where}.outcome must be "pass" or "fail"`);
    if (!isTime(raw.startedAt) || !isTime(raw.endedAt))
        bad(`${where} needs startedAt and endedAt times`);
    if (!BY.includes(raw.by))
        bad(`${where}.by must be computer, agent or person`);
    if (raw.exitCode != null && !Number.isInteger(raw.exitCode))
        bad(`${where}.exitCode must be a whole number`);
    return {
        node: nodeId(machine, raw.node, `${where}.node`),
        visit: raw.visit,
        outcome: raw.outcome,
        summary: text(raw.summary, `${where}.summary`),
        values: strings(raw.values, `${where}.values`),
        startedAt: raw.startedAt,
        endedAt: raw.endedAt,
        ...(raw.exitCode != null ? { exitCode: raw.exitCode } : {}),
        ...(raw.terminal != null ? { terminal: text(raw.terminal, `${where}.terminal`) } : {}),
        ...(raw.tab != null ? { tab: text(raw.tab, `${where}.tab`) } : {}),
        by: raw.by,
    };
}
/**
 * The boundary for run.json. The file holds the commands the panel runs, so loading it checks the
 * embedded machine again with parseMachine and every field the engine reads.
 */
export function parseRun(raw) {
    if (!isRecord(raw))
        bad("must hold one JSON object");
    if (typeof raw.id !== "string" || !RUN_ID.test(raw.id))
        bad("id must be a plain name");
    let machine;
    try {
        machine = parseMachine(raw.machine);
    }
    catch (error) {
        return bad(`machine: ${error.message}`);
    }
    if (!isRecord(raw.space))
        bad("space must be an object");
    const space = { id: text(raw.space.id, "space.id"), name: text(raw.space.name, "space.name") };
    const folder = text(raw.folder, "folder");
    if (!folder.startsWith("/"))
        bad("folder must be an absolute path");
    const inputs = strings(raw.inputs, "inputs");
    const unset = machine.inputs.find((input) => !(input.key in inputs));
    if (unset)
        bad(`inputs lacks ${unset.key}`);
    if (typeof raw.auto !== "boolean")
        bad("auto must be true or false");
    const visits = isRecord(raw.visits) ? raw.visits : bad("visits must be an object");
    for (const [key, count] of Object.entries(visits)) {
        nodeId(machine, key, `visits.${key}`);
        if (typeof count !== "number" || !Number.isInteger(count) || count < 0)
            bad(`visits.${key} must be a whole number`);
    }
    if (!Array.isArray(raw.attempts))
        bad("attempts must be a list");
    if (!isTime(raw.createdAt) || !isTime(raw.updatedAt))
        bad("needs createdAt and updatedAt times");
    return {
        id: raw.id,
        machine,
        space,
        folder,
        inputs,
        auto: raw.auto,
        status: parseStatus(raw.status, machine),
        visits: { ...visits },
        context: strings(raw.context, "context"),
        attempts: raw.attempts.map((attempt, index) => parseAttempt(attempt, index, machine)),
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
    };
}
