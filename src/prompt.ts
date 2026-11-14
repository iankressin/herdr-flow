import type { Machine, RunState } from "./types.ts";
import { ancestors, nodeById } from "./graph.ts";

export interface FocusedPrompt {
  markdown: string;
  missing: string[];
}

function lastOutput(run: RunState, id: string): string | null {
  for (let i = run.log.length - 1; i >= 0; i--) {
    const entry = run.log[i];
    if (entry && entry.nodeId === id) return entry.output;
  }
  return null;
}

export function buildFocusedPrompt(machine: Machine, run: RunState, nodeId: string): FocusedPrompt {
  const node = nodeById(machine, nodeId);
  if (!node) {
    return {
      markdown: `# Focused prompt\n\nUnknown node \`${nodeId}\`.\n`,
      missing: [],
    };
  }

  const prior = new Set<string>([...ancestors(machine, nodeId), ...run.completed]);
  prior.delete(nodeId);
  const ordered = machine.nodes.map((item) => item.id).filter((id) => prior.has(id));

  const lines: string[] = [
    `# Focused prompt — ${node.label}`,
    "",
    `Node: \`${node.id}\` (${node.kind})`,
  ];
  if (node.source) {
    lines.push(`Source: ${node.source.file}:${node.source.line}`);
  }
  lines.push("", "## Task", node.promptOrDescription, "", "## Context from prior steps");

  if (!ordered.length) {
    lines.push("No prior steps.");
  }

  for (const id of ordered) {
    const priorNode = nodeById(machine, id);
    if (!priorNode) continue;
    const output = lastOutput(run, id);
    const ran = output != null;
    lines.push(
      "",
      ran
        ? `### ${priorNode.label} (\`${priorNode.id}\`, ${priorNode.kind})`
        : `### ${priorNode.label} (\`${priorNode.id}\`, ${priorNode.kind}) — not yet run`,
    );
    lines.push(ran ? output : priorNode.promptOrDescription);
  }

  const missing = (node.requires ?? []).filter((key) => run.context[key] == null || run.context[key] === "");
  if (missing.length) {
    lines.push(
      "",
      "## Warning",
      `Required values not yet produced: ${missing.join(", ")}.`,
    );
  }

  lines.push("");
  return { markdown: lines.join("\n"), missing };
}
