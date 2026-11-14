import type { Machine } from "./types.ts";
import { displayOrder } from "./graph.ts";

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pill extends Box {
  text: string;
  kind: "loop" | "error";
  nodeId: string;
  exitId?: string;
}

export interface Spine {
  x: number;
  y1: number;
  y2: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  spine: Spine | null;
  nodes: Box[];
  pills: Pill[];
}

const NODE_W = 248;
const NODE_H = 84;
const PILL_H = 32;
const GAP = 22;
const PAD_X = 48;
const PAD_Y = 16;
const SPINE_X = 26;

export function layoutGraph(machine: Machine): GraphLayout {
  const nodes: Box[] = [];
  const pills: Pill[] = [];
  let y = PAD_Y;

  for (const id of displayOrder(machine)) {
    nodes.push({ id, x: PAD_X, y, w: NODE_W, h: NODE_H });
    y += NODE_H + 8;

    for (const edge of machine.transitions) {
      if (!edge.isLoop || edge.from !== id) continue;
      pills.push({
        id: `loop-${id}`,
        nodeId: id,
        x: PAD_X,
        y,
        w: NODE_W,
        h: PILL_H,
        text: edge.label ? `loop · ${edge.label}` : "loop",
        kind: "loop",
      });
      y += PILL_H + 6;
    }

    for (const exit of machine.errorExits ?? []) {
      if (exit.from !== id) continue;
      pills.push({
        id: `exit-${exit.id}`,
        exitId: exit.id,
        nodeId: id,
        x: PAD_X,
        y,
        w: NODE_W,
        h: PILL_H,
        text: exit.label,
        kind: "error",
      });
      y += PILL_H + 6;
    }

    y += GAP;
  }

  const height = Math.max(PAD_Y + NODE_H, y);
  const spine =
    nodes.length > 1
      ? {
          x: SPINE_X,
          y1: nodes[0]!.y + NODE_H / 2,
          y2: nodes[nodes.length - 1]!.y + NODE_H / 2,
        }
      : null;

  return {
    width: PAD_X + NODE_W + 20,
    height,
    spine,
    nodes,
    pills,
  };
}
