import { canRetry, nodeById, startNodeId } from "./graph.js";
export function emptyContext() {
    return {};
}
export function createRun(machine) {
    return {
        activeId: startNodeId(machine) || null,
        completed: [],
        visits: {},
        context: {},
        status: "ready",
        log: [],
        note: null,
        takenErrorExits: [],
    };
}
export function defaultProduce(node) {
    const output = node.promptOrDescription;
    const values = {};
    for (const key of node.produces ?? [])
        values[key] = output;
    return { output, values, hint: "ok" };
}
function errorExit(machine, from, pattern) {
    return (machine.errorExits?.find((exit) => from != null && exit.from === from && pattern.test(exit.label)) ??
        machine.errorExits?.find((exit) => pattern.test(exit.label)));
}
function chooseNext(machine, run, node, hint) {
    if (node.id === "done")
        return { activeId: "done", status: "done", note: "done" };
    if (node.id === "gave-up")
        return { activeId: "gave-up", status: "gave-up", note: "gave up" };
    const forward = machine.transitions.filter((edge) => edge.from === node.id && !edge.isLoop && !edge.isError);
    const loops = machine.transitions.filter((edge) => edge.isLoop && edge.from === node.id);
    const errors = machine.transitions.filter((edge) => edge.isError && edge.from === node.id);
    if (hint === "ok") {
        const next = forward[0];
        if (!next)
            return { activeId: node.id, status: "done", note: null };
        return { activeId: next.to, status: "running", note: null };
    }
    if (hint === "retry") {
        const loop = loops[0];
        const target = loop?.to ?? node.id;
        if (canRetry(machine, target, run.visits[target] ?? 0)) {
            return { activeId: target, status: "running", note: loop?.label ?? "retry" };
        }
        const exit = errorExit(machine, target, /max retries/i);
        const dest = nodeById(machine, "gave-up") ? "gave-up" : null;
        return {
            activeId: dest,
            status: dest ? "running" : "blocked",
            note: exit?.label ?? "max retries exceeded",
            taken: exit?.id,
        };
    }
    if (hint === "error") {
        const edge = errors[0];
        if (edge && canRetry(machine, edge.to, run.visits[edge.to] ?? 0)) {
            return { activeId: edge.to, status: "running", note: edge.label ?? "error" };
        }
        const exit = errorExit(machine, edge?.to ?? node.id, /max retries/i);
        const dest = nodeById(machine, "gave-up") ? "gave-up" : null;
        return {
            activeId: dest,
            status: dest ? "running" : "blocked",
            note: exit?.label ?? edge?.label ?? "error",
            taken: exit?.id,
        };
    }
    const reject = errors[0];
    if (reject && nodeById(machine, reject.to)) {
        return { activeId: reject.to, status: "running", note: reject.label ?? "give up", taken: undefined };
    }
    const dest = nodeById(machine, "gave-up") ? "gave-up" : null;
    return { activeId: dest, status: dest ? "running" : "blocked", note: "gave up" };
}
export function step(machine, run, options = {}) {
    if (run.status === "done" || run.status === "gave-up")
        return run;
    const id = run.activeId;
    if (!id)
        return run;
    const node = nodeById(machine, id);
    if (!node)
        return { ...run, status: "blocked", note: `Missing node ${id}` };
    const visits = { ...run.visits, [id]: (run.visits[id] ?? 0) + 1 };
    const mid = { ...run, visits };
    const produced = options.structural
        ? defaultProduce(node)
        : (options.simulate ?? defaultProduce)(node, mid, options);
    const context = { ...run.context, ...produced.values };
    const completed = run.completed.includes(id) ? run.completed : [...run.completed, id];
    const log = [...run.log, { nodeId: id, output: produced.output }];
    const hint = options.structural ? "ok" : produced.hint;
    const next = chooseNext(machine, { ...mid, context, completed, log }, node, hint);
    return {
        activeId: next.activeId,
        completed,
        visits,
        context,
        status: next.status,
        log,
        note: next.note,
        takenErrorExits: next.taken ? [...run.takenErrorExits, next.taken] : run.takenErrorExits,
    };
}
export function exportSnapshot(machine, run) {
    return {
        machine,
        execution: {
            activeId: run.activeId,
            completed: [...run.completed],
            visits: { ...run.visits },
            status: run.status,
            note: run.note,
            takenErrorExits: [...run.takenErrorExits],
            context: { ...run.context },
        },
    };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asStringList(value) {
    if (value == null)
        return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error("Expected a list of strings");
    }
    return value;
}
export function parseMachine(input) {
    if (!isRecord(input))
        throw new Error("Machine must be an object");
    if (typeof input.id !== "string" || !input.id)
        throw new Error("Machine id is required");
    if (!Array.isArray(input.nodes) || input.nodes.length === 0)
        throw new Error("Machine needs nodes");
    const nodes = input.nodes.map((raw, index) => {
        if (!isRecord(raw))
            throw new Error(`Node ${index} is not an object`);
        if (typeof raw.id !== "string" || !raw.id)
            throw new Error(`Node ${index} is missing id`);
        if (raw.kind !== "computer" && raw.kind !== "agent") {
            throw new Error(`Node ${raw.id} kind must be computer or agent`);
        }
        if (typeof raw.label !== "string")
            throw new Error(`Node ${raw.id} is missing label`);
        if (typeof raw.promptOrDescription !== "string") {
            throw new Error(`Node ${raw.id} is missing promptOrDescription`);
        }
        let source;
        if (raw.source != null) {
            if (!isRecord(raw.source) || typeof raw.source.file !== "string" || typeof raw.source.line !== "number") {
                throw new Error(`Node ${raw.id} has a bad source reference`);
            }
            source = { file: raw.source.file, line: raw.source.line };
        }
        return {
            id: raw.id,
            kind: raw.kind,
            label: raw.label,
            promptOrDescription: raw.promptOrDescription,
            source,
            requires: asStringList(raw.requires),
            produces: asStringList(raw.produces),
        };
    });
    const ids = new Set(nodes.map((node) => node.id));
    if (ids.size !== nodes.length)
        throw new Error("Node ids must be unique");
    if (!Array.isArray(input.transitions))
        throw new Error("Machine needs transitions");
    const transitions = input.transitions.map((raw, index) => {
        if (!isRecord(raw) || typeof raw.from !== "string" || typeof raw.to !== "string") {
            throw new Error(`Transition ${index} needs from and to`);
        }
        if (!ids.has(raw.from) || !ids.has(raw.to)) {
            throw new Error(`Transition ${raw.from} -> ${raw.to} points at an unknown node`);
        }
        return {
            from: raw.from,
            to: raw.to,
            label: typeof raw.label === "string" ? raw.label : undefined,
            isLoop: raw.isLoop === true ? true : undefined,
            isError: raw.isError === true ? true : undefined,
        };
    });
    let errorExits;
    if (input.errorExits != null) {
        if (!Array.isArray(input.errorExits))
            throw new Error("errorExits must be a list");
        errorExits = input.errorExits.map((raw, index) => {
            if (!isRecord(raw) ||
                typeof raw.id !== "string" ||
                typeof raw.label !== "string" ||
                typeof raw.from !== "string") {
                throw new Error(`Error exit ${index} needs id, label, and from`);
            }
            if (!ids.has(raw.from))
                throw new Error(`Error exit ${raw.id} leaves unknown node ${raw.from}`);
            return { id: raw.id, label: raw.label, from: raw.from };
        });
    }
    return { id: input.id, nodes, transitions, errorExits };
}
