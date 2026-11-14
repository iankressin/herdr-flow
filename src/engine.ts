import type { ComputerNode, Machine, MachineNode, Outcome } from "./machine.ts";
import { MAX_TIMEOUT_SEC, envName, fillTemplate, missingKeys, nodeOf, transitionFor } from "./machine.ts";

export type By = "computer" | "agent" | "person";

export interface Attempt {
  node: string;
  visit: number;
  outcome: Outcome;
  summary: string;
  values: Record<string, string>;
  startedAt: number;
  endedAt: number;
  exitCode?: number;
  terminal?: string;
  tab?: string;
  by: By;
}

export interface AgentHandle {
  tab: string;
  terminal?: string;
}

export type RunStatus =
  | { kind: "idle"; next: string }
  | { kind: "executing"; node: string; visit: number; startedAt: number; agent?: AgentHandle }
  | { kind: "finished"; end: string; result: "success" | "failure"; note?: string; exhausted?: string }
  | { kind: "failed"; node: string; error: string };

export interface Run {
  id: string;
  machine: Machine;
  space: { id: string; name: string };
  folder: string;
  inputs: Record<string, string>;
  auto: boolean;
  status: RunStatus;
  visits: Record<string, number>;
  context: Record<string, string>;
  attempts: Attempt[];
  createdAt: number;
  updatedAt: number;
}

export type Effect =
  | { kind: "command"; node: string; command: string; env: Record<string, string>; timeoutSec: number }
  | { kind: "agent"; node: string; visit: number }
  | { kind: "none" };

export interface StepResult {
  outcome: Outcome;
  summary: string;
  values: Record<string, string>;
  exitCode?: number;
  by: By;
}

export interface NewRun {
  id: string;
  space: { id: string; name: string };
  folder: string;
  inputs: Record<string, string>;
  now: number;
}

export const OUTPUT_TAIL = 8000;
const SUMMARY_LINES = 8;

export function templateValues(run: Run): Record<string, string> {
  return { ...run.context, ...run.inputs };
}

export function commandEnv(run: Run): Record<string, string> {
  return Object.fromEntries(Object.entries(run.context).map(([key, value]) => [envName(key), value]));
}

function isExhausted(run: Run, node: MachineNode): boolean {
  return node.maxVisits != null && (run.visits[node.id] ?? 0) >= node.maxVisits;
}

function arrive(run: Run, target: string): Run {
  const node = nodeOf(run.machine, target);
  if (node.kind === "end") {
    return { ...run, status: { kind: "finished", end: node.id, result: node.result } };
  }
  if (!isExhausted(run, node)) return { ...run, status: { kind: "idle", next: node.id } };
  const end = run.machine.onExhausted == null ? null : nodeOf(run.machine, run.machine.onExhausted);
  if (end?.kind !== "end") {
    return { ...run, status: { kind: "failed", node: node.id, error: `max retries exceeded at ${node.label}, and the machine has no onExhausted end` } };
  }
  return {
    ...run,
    status: { kind: "finished", end: end.id, result: end.result, note: `max retries exceeded at ${node.label}`, exhausted: node.id },
  };
}

export function isInside(path: string, folder: string): boolean {
  const base = folder.replace(/\/+$/, "");
  return path === base || path.startsWith(`${base}/`);
}

export function createRun(machine: Machine, init: NewRun): Run {
  const run: Run = {
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

export function pendingEffect(run: Run): Effect {
  if (run.status.kind !== "executing") return { kind: "none" };
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

export function begin(run: Run, now: number): { run: Run; effect: Effect } {
  if (run.status.kind !== "idle") return { run, effect: { kind: "none" } };
  const node = nodeOf(run.machine, run.status.next);
  if (node.kind === "end" || isExhausted(run, node)) return { run: arrive(run, node.id), effect: { kind: "none" } };
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
  const executing: Run = {
    ...run,
    status: { kind: "executing", node: node.id, visit: (run.visits[node.id] ?? 0) + 1, startedAt: now },
  };
  return { run: executing, effect: pendingEffect(executing) };
}

export function isExecuting(run: Run, node: string, visit: number): boolean {
  return run.status.kind === "executing" && run.status.node === node && run.status.visit === visit;
}

export function attachAgent(run: Run, agent: AgentHandle): Run {
  if (run.status.kind !== "executing") return run;
  return { ...run, status: { ...run.status, agent } };
}

export function complete(run: Run, result: StepResult, now: number): Run {
  const status = run.status;
  if (status.kind !== "executing" && status.kind !== "failed") return run;
  const node = nodeOf(run.machine, status.node);
  const visit = (run.visits[node.id] ?? 0) + 1;
  const agent = status.kind === "executing" ? status.agent : undefined;
  const attempt: Attempt = {
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
  const recorded: Run = {
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

export function fail(run: Run, error: string): Run {
  switch (run.status.kind) {
    case "executing":
      return { ...run, status: { kind: "failed", node: run.status.node, error } };
    case "idle":
      return { ...run, status: { kind: "failed", node: run.status.next, error } };
    default:
      return run;
  }
}

export function retry(run: Run): Run {
  return run.status.kind === "failed" ? arrive(run, run.status.node) : run;
}

export function setAuto(run: Run, on: boolean): Run {
  return run.auto === on ? run : { ...run, auto: on };
}

function tail(text: string): string {
  return text.length <= OUTPUT_TAIL ? text : `…${text.slice(-OUTPUT_TAIL)}`;
}

export function commandProblem(ran: { exitCode: number; output: string } | { error: string; output: string }): string | null {
  if ("error" in ran || (ran.exitCode !== 126 && ran.exitCode !== 127)) return null;
  const last = tail(ran.output.trimEnd()).split("\n").slice(-SUMMARY_LINES).join("\n");
  return `Command could not run (exit ${ran.exitCode})${last ? `: ${last}` : ""}`;
}

export function commandResult(
  node: ComputerNode,
  ran: { exitCode: number; output: string } | { error: string; output: string },
): StepResult {
  const output = tail(ran.output.trimEnd());
  const values = Object.fromEntries((node.produces ?? []).map((key) => [key, output]));
  if ("error" in ran) return { outcome: "fail", summary: ran.error, values, by: "computer" };
  const last = output.split("\n").slice(-SUMMARY_LINES).join("\n");
  return {
    outcome: ran.exitCode === 0 ? "pass" : "fail",
    summary: `Exit code ${ran.exitCode}.${last ? `\n${last}` : ""}`,
    values,
    exitCode: ran.exitCode,
    by: "computer",
  };
}
