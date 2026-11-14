import type { Machine, MachineNode } from "./types.ts";

export function nodeById(machine: Machine, id: string): MachineNode | undefined {
  return machine.nodes.find((node) => node.id === id);
}

/** First node that nothing (except a self-loop) points at. */
export function startNodeId(machine: Machine): string {
  const targeted = new Set(
    machine.transitions.filter((edge) => !(edge.isLoop && edge.from === edge.to)).map((edge) => edge.to),
  );
  const start = machine.nodes.find((node) => !targeted.has(node.id));
  return start?.id ?? machine.nodes[0]?.id ?? "";
}

/** Happy-path order, then any node not reached by a plain forward edge. */
export function displayOrder(machine: Machine): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  let cursor: string | null = startNodeId(machine);
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    order.push(cursor);
    const next = machine.transitions.find(
      (edge) => edge.from === cursor && !edge.isLoop && !edge.isError,
    );
    cursor = next?.to ?? null;
  }
  for (const node of machine.nodes) {
    if (!seen.has(node.id)) order.push(node.id);
  }
  return order;
}

/**
 * Ancestors along forward edges only. Error returns and self-loops are not
 * priors — they run after this node, or are this node.
 */
export function ancestors(machine: Machine, id: string): string[] {
  const reverse = new Map<string, string[]>();
  for (const edge of machine.transitions) {
    if (edge.isLoop || edge.isError || edge.from === edge.to) continue;
    const list = reverse.get(edge.to) ?? [];
    list.push(edge.from);
    reverse.set(edge.to, list);
  }
  const seen = new Set<string>();
  const stack = [...(reverse.get(id) ?? [])];
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current) || current === id) continue;
    seen.add(current);
    for (const parent of reverse.get(current) ?? []) stack.push(parent);
  }
  return machine.nodes.map((node) => node.id).filter((nodeId) => seen.has(nodeId));
}

/** Visit budget parsed from a loop label such as "retries < 5". */
export function retryBudget(machine: Machine, id: string): number | null {
  const loop = machine.transitions.find(
    (edge) => edge.isLoop && edge.from === id && edge.to === id,
  );
  if (!loop) return null;
  const match = /retries\s*<\s*(\d+)/i.exec(loop.label ?? "");
  return match ? Number(match[1]) : 5;
}

export function canRetry(machine: Machine, id: string, visits: number): boolean {
  const budget = retryBudget(machine, id);
  if (budget == null) return true;
  return visits < budget;
}
