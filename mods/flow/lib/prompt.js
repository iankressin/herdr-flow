import { templateValues } from "./engine.js";
import { fillTemplate, nodeOf, transitionFor } from "./machine.js";
/** Nodes that reach `id` through `pass` edges, in machine order. */
export function passAncestors(machine, id) {
    const seen = new Set();
    const queue = [id];
    while (queue.length) {
        const current = queue.shift();
        for (const edge of machine.transitions) {
            if (edge.on === "pass" && edge.to === current && edge.from !== id && !seen.has(edge.from)) {
                seen.add(edge.from);
                queue.push(edge.from);
            }
        }
    }
    return machine.nodes.map((node) => node.id).filter((nodeId) => seen.has(nodeId));
}
function fence(text) {
    const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
    const bar = "`".repeat(longest + 1);
    return `${bar}\n${text}\n${bar}`;
}
function lastWhere(attempts, test) {
    for (let i = attempts.length - 1; i >= 0; i--)
        if (test(attempts[i]))
            return attempts[i];
    return undefined;
}
function consequence(machine, node, on) {
    const edge = transitionFor(machine, node, on);
    if (!edge)
        return `"${on}" has no next step; the run stops for a person.`;
    const to = nodeOf(machine, edge.to).label;
    return `"${on}" sends the run to ${to}${edge.label ? ` (${edge.label})` : ""}.`;
}
/** The whole message an agent node starts with: its task, what earlier steps found, and how to report back. */
export function buildAgentPrompt(run, nodeId, options) {
    const machine = run.machine;
    const node = nodeOf(machine, nodeId);
    if (node.kind !== "agent")
        throw new Error(`${node.label} is not an agent step`);
    const visit = run.status.kind === "executing" && run.status.node === node.id ? run.status.visit : (run.visits[node.id] ?? 0) + 1;
    const values = templateValues(run);
    const out = [
        `# ${node.label}`,
        "",
        `You are one step of the Flow run "${machine.title}" (${run.id}). ` +
            `This is visit ${visit} of this step${node.maxVisits ? `, out of at most ${node.maxVisits}` : ""}. ` +
            `Work in ${run.folder}.`,
        "",
        "## Task",
        "",
        fillTemplate(node.prompt, values),
    ];
    if (machine.inputs.length) {
        out.push("", "## Inputs", "");
        for (const input of machine.inputs)
            out.push(`- ${input.label} (\`${input.key}\`): ${run.inputs[input.key] ?? "(not set)"}`);
    }
    out.push("", "## Context from prior steps");
    const before = out.length;
    for (const key of node.requires ?? []) {
        out.push("", `### ${key}`, "", key in values ? fence(values[key]) : "Not set yet.");
    }
    for (const id of passAncestors(machine, node.id)) {
        const attempt = lastWhere(run.attempts, (item) => item.node === id);
        if (!attempt)
            continue;
        out.push("", `### ${nodeOf(machine, id).label}: ${attempt.outcome} (attempt ${attempt.visit})`, "", attempt.summary);
    }
    if (out.length === before)
        out.push("", "Nothing ran before this step.");
    const mine = run.attempts.filter((attempt) => attempt.node === node.id);
    if (mine.length) {
        out.push("", "## Earlier attempts at this step");
        for (const attempt of mine)
            out.push("", `### Attempt ${attempt.visit}: ${attempt.outcome}`, "", attempt.summary);
        const after = run.attempts.slice(run.attempts.lastIndexOf(mine[mine.length - 1]) + 1);
        const sender = lastWhere(after, (attempt) => transitionFor(machine, attempt.node, attempt.outcome)?.to === node.id);
        if (sender) {
            out.push("", "## Why you are here again", "", `${nodeOf(machine, sender.node).label} ended "${sender.outcome}" on attempt ${sender.visit}:`, "", sender.summary);
            for (const [key, value] of Object.entries(sender.values))
                out.push("", `### ${key}`, "", fence(value));
        }
    }
    const produced = (node.produces ?? []).map((key) => `"${key}":"<string>"`).join(",");
    out.push("", "## When you finish", "", `Write exactly one JSON object to \`${options.resultPath}\`:`, "", fence(`{"outcome":"pass"|"fail","summary":"<2-5 sentences>","values":{${produced}}}`), "", `- ${consequence(machine, node.id, "pass")}`, `- ${consequence(machine, node.id, "fail")}`, `- Give one string for each key in values${node.produces?.length ? "" : " (this step has none, so use {})"}.`, "- Write this file last, after the work is done. Then stop: Flow moves on when the file appears.", "");
    return out.join("\n");
}
