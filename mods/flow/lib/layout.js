import { nodeOf } from "./machine.js";
const NODE_W = 248;
const NODE_H = 84;
const PILL_H = 26;
const PILL_GAP = 6;
const GAP = 20;
const PAD_X = 48;
const PAD_Y = 16;
const SPINE_X = 26;
export function displayOrder(machine) {
    const order = [];
    let cursor = machine.start;
    while (cursor && !order.includes(cursor) && nodeOf(machine, cursor).kind !== "end") {
        order.push(cursor);
        const from = cursor;
        cursor = machine.transitions.find((edge) => edge.from === from && edge.on === "pass")?.to;
    }
    const rest = machine.nodes.filter((node) => !order.includes(node.id));
    return [
        ...order,
        ...rest.filter((node) => node.kind !== "end").map((node) => node.id),
        ...rest.filter((node) => node.kind === "end").map((node) => node.id),
    ];
}
function failTaken(run, edge) {
    return Boolean(run?.attempts.some((attempt) => attempt.node === edge.from && attempt.outcome === "fail"));
}
export function layoutGraph(machine, run = null) {
    const nodes = [];
    const pills = [];
    let y = PAD_Y;
    const pill = (node, kind, text, taken) => {
        pills.push({ id: `${kind}-${node}-${pills.length}`, node, kind, text, taken, x: PAD_X, y, w: NODE_W, h: PILL_H });
        y += PILL_H + PILL_GAP;
    };
    for (const id of displayOrder(machine)) {
        const node = nodeOf(machine, id);
        nodes.push({ id, x: PAD_X, y, w: NODE_W, h: NODE_H });
        y += NODE_H + 8;
        if (node.maxVisits != null)
            pill(id, "budget", `retries < ${node.maxVisits}`, false);
        for (const edge of machine.transitions) {
            if (edge.from !== id || edge.on !== "fail")
                continue;
            pill(id, "fail", edge.label ?? `on fail → ${nodeOf(machine, edge.to).label}`, failTaken(run, edge));
        }
        if (node.maxVisits != null && machine.onExhausted != null) {
            const exhausted = run?.status.kind === "finished" && run.status.exhausted === id;
            pill(id, "exhausted", `max retries → ${nodeOf(machine, machine.onExhausted).label}`, exhausted);
        }
        y += GAP;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    return {
        width: PAD_X + NODE_W + 20,
        height: Math.max(PAD_Y + NODE_H, y),
        spine: first && last && first !== last ? { x: SPINE_X, y1: first.y + NODE_H / 2, y2: last.y + NODE_H / 2 } : null,
        nodes,
        pills,
    };
}
