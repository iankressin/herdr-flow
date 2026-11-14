export type NodeKind = "computer" | "agent";

export interface SourceRef {
  file: string;
  line: number;
}

export interface MachineNode {
  id: string;
  kind: NodeKind;
  label: string;
  promptOrDescription: string;
  source?: SourceRef;
  requires?: string[];
  produces?: string[];
}

export interface Transition {
  from: string;
  to: string;
  label?: string;
  isLoop?: boolean;
  isError?: boolean;
}

export interface ErrorExit {
  id: string;
  label: string;
  from: string;
}

export interface Machine {
  id: string;
  nodes: MachineNode[];
  transitions: Transition[];
  errorExits?: ErrorExit[];
}

export type NextHint = "ok" | "retry" | "error" | "give-up";

export type RunStatus = "ready" | "running" | "done" | "gave-up" | "blocked";

export interface RunLogEntry {
  nodeId: string;
  output: string;
}

export interface RunState {
  activeId: string | null;
  completed: string[];
  visits: Record<string, number>;
  context: Record<string, string>;
  status: RunStatus;
  log: RunLogEntry[];
  note: string | null;
  takenErrorExits: string[];
}

export interface ProduceResult {
  output: string;
  values: Record<string, string>;
  hint: NextHint;
}

export interface ExecutionSnapshot {
  activeId: string | null;
  completed: string[];
  visits: Record<string, number>;
  status: RunStatus;
  note: string | null;
  takenErrorExits: string[];
  context: Record<string, string>;
}

export interface MachineSnapshot {
  machine: Machine;
  execution: ExecutionSnapshot;
}
