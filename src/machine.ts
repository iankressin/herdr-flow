export type Outcome = "pass" | "fail";

export interface SourceRef {
  file: string;
  line: number;
}

export interface Input {
  key: string;
  label: string;
  default?: string;
}

interface NodeBase {
  id: string;
  label: string;
  source?: SourceRef;
  requires?: string[];
  produces?: string[];
  maxVisits?: number;
}

export interface ComputerNode extends NodeBase {
  kind: "computer";
  run: string;
  timeoutSec?: number;
}

export interface AgentNode extends NodeBase {
  kind: "agent";
  prompt: string;
}

export interface EndNode extends NodeBase {
  kind: "end";
  result: "success" | "failure";
  description?: string;
}

export type MachineNode = ComputerNode | AgentNode | EndNode;

export interface Transition {
  from: string;
  on: Outcome;
  to: string;
  label?: string;
}

export interface Machine {
  id: string;
  title: string;
  inputs: Input[];
  start: string;
  onExhausted?: string;
  agent?: string[];
  nodes: MachineNode[];
  transitions: Transition[];
}

export const DEFAULT_AGENT = ["claude", "--add-dir={visitDir}"];
export function agentLaunchArgv(shell: string, agentArgv: string[], prompt: string): string[] {
  return [shell, "-lic", 'exec "$0" "$@"', ...agentArgv, prompt];
}
export const MAX_TIMEOUT_SEC = 600;

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

export function nodeOf(machine: Machine, id: string): MachineNode {
  const node = machine.nodes.find((item) => item.id === id);
  if (!node) throw new Error(`Unknown node ${id}`);
  return node;
}

export function transitionFor(machine: Machine, from: string, on: Outcome): Transition | undefined {
  return machine.transitions.find((edge) => edge.from === from && edge.on === on);
}

export function fillTemplate(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (whole, key: string) => (key in values ? values[key]! : whole));
}

export function missingKeys(text: string, values: Record<string, string>): string[] {
  const missing = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (!(match[1]! in values)) missing.add(match[1]!);
  }
  return [...missing];
}

export function envName(key: string): string {
  return `FLOW_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a non-empty string`);
  return value;
}

function optionalText(value: unknown, where: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error(`${where} must be a string`);
  return value;
}

function keys(value: unknown, where: string): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${where} must be a list of keys`);
  return value.map((item, index) => {
    if (typeof item !== "string" || !KEY.test(item)) throw new Error(`${where}[${index}] is not a valid key`);
    return item;
  });
}

function count(value: unknown, where: string, max = Infinity): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${where} must be a whole number from 1 to ${max}`);
  }
  return value;
}

function parseInput(raw: unknown, index: number): Input {
  const where = `inputs[${index}]`;
  if (!isRecord(raw)) throw new Error(`${where} must be an object`);
  const key = text(raw.key, `${where}.key`);
  if (!KEY.test(key)) throw new Error(`${where}.key "${key}" is not a valid key`);
  return { key, label: text(raw.label, `${where}.label`), default: optionalText(raw.default, `${where}.default`) };
}

function parseNode(raw: unknown, index: number): MachineNode {
  if (!isRecord(raw)) throw new Error(`nodes[${index}] must be an object`);
  const id = text(raw.id, `nodes[${index}].id`);
  const where = `Node ${id}`;
  let source: SourceRef | undefined;
  if (raw.source != null) {
    if (!isRecord(raw.source) || typeof raw.source.file !== "string" || count(raw.source.line, `${where} source.line`) == null) {
      throw new Error(`${where} source must be { file, line }`);
    }
    source = { file: raw.source.file, line: raw.source.line as number };
  }
  const base = {
    id,
    label: text(raw.label, `${where} label`),
    source,
    requires: keys(raw.requires, `${where} requires`),
    produces: keys(raw.produces, `${where} produces`),
    maxVisits: count(raw.maxVisits, `${where} maxVisits`),
  };
  switch (raw.kind) {
    case "computer":
      return {
        ...base,
        kind: "computer",
        run: text(raw.run, `${where} run`),
        timeoutSec: count(raw.timeoutSec, `${where} timeoutSec`, MAX_TIMEOUT_SEC),
      };
    case "agent":
      return { ...base, kind: "agent", prompt: text(raw.prompt, `${where} prompt`) };
    case "end":
      if (raw.result !== "success" && raw.result !== "failure") {
        throw new Error(`${where} result must be "success" or "failure"`);
      }
      return { ...base, kind: "end", result: raw.result, description: optionalText(raw.description, `${where} description`) };
    default:
      throw new Error(`${where} kind must be "computer", "agent" or "end"`);
  }
}

function parseTransition(raw: unknown, index: number, nodes: Map<string, MachineNode>): Transition {
  const where = `transitions[${index}]`;
  if (!isRecord(raw)) throw new Error(`${where} must be an object`);
  const from = text(raw.from, `${where}.from`);
  const to = text(raw.to, `${where}.to`);
  if (raw.on !== "pass" && raw.on !== "fail") throw new Error(`${where}.on must be "pass" or "fail"`);
  for (const id of [from, to]) {
    if (!nodes.has(id)) throw new Error(`${where} points at unknown node ${id}`);
  }
  if (nodes.get(from)!.kind === "end") throw new Error(`${where} leaves end node ${from}; end nodes have no edges out`);
  return { from, on: raw.on, to, label: optionalText(raw.label, `${where}.label`) };
}

export function parseMachine(raw: unknown): Machine {
  if (!isRecord(raw)) throw new Error("A machine must be a JSON object");
  const id = text(raw.id, "id");
  const title = text(raw.title, "title");

  if (raw.inputs != null && !Array.isArray(raw.inputs)) throw new Error("inputs must be a list");
  const inputs = ((raw.inputs as unknown[] | undefined) ?? []).map(parseInput);
  if (new Set(inputs.map((input) => input.key)).size !== inputs.length) throw new Error("Input keys must be unique");

  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) throw new Error("nodes must be a non-empty list");
  const nodes = raw.nodes.map(parseNode);
  const byId = new Map<string, MachineNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new Error(`Node id ${node.id} is used twice`);
    byId.set(node.id, node);
  }

  if (!Array.isArray(raw.transitions)) throw new Error("transitions must be a list");
  const transitions = raw.transitions.map((edge, index) => parseTransition(edge, index, byId));
  const seen = new Set<string>();
  for (const edge of transitions) {
    const key = `${edge.from}/${edge.on}`;
    if (seen.has(key)) throw new Error(`Node ${edge.from} has two "${edge.on}" transitions`);
    seen.add(key);
  }
  for (const node of nodes) {
    if (node.kind !== "end" && !seen.has(`${node.id}/pass`)) throw new Error(`Node ${node.id} has no "pass" transition`);
  }

  const start = text(raw.start, "start");
  if (!byId.has(start)) throw new Error(`start points at unknown node ${start}`);

  const onExhausted = optionalText(raw.onExhausted, "onExhausted");
  if (onExhausted != null && byId.get(onExhausted)?.kind !== "end") {
    throw new Error(`onExhausted must name an end node, not ${onExhausted}`);
  }

  const inputKeys = Object.fromEntries(inputs.map((input) => [input.key, ""]));
  for (const node of nodes) {
    const shadow = node.produces?.find((key) => key in inputKeys);
    if (shadow) throw new Error(`Node ${node.id} produces "${shadow}", which is an input key; inputs cannot be overwritten`);
    if (node.kind !== "computer") continue;
    const stepKey = missingKeys(node.run, inputKeys)[0];
    if (stepKey) {
      throw new Error(
        `Node ${node.id} run uses {{${stepKey}}}, but only inputs can fill a command; read a step value from $${envName(stepKey)} instead`,
      );
    }
  }

  const limited = nodes.find((node) => node.maxVisits != null);
  if (limited && onExhausted == null) throw new Error(`Node ${limited.id} sets maxVisits, so the machine needs onExhausted`);

  let agent: string[] | undefined;
  if (raw.agent != null) {
    if (!Array.isArray(raw.agent) || raw.agent.length === 0 || raw.agent.some((part) => typeof part !== "string" || !part)) {
      throw new Error("agent must be a non-empty list of strings");
    }
    agent = raw.agent as string[];
    if (agent.some((part) => part.includes("{runDir}"))) {
      throw new Error("agent uses {runDir}; an agent gets only its own visit folder, {visitDir}");
    }
  }

  return { id, title, inputs, start, onExhausted, agent, nodes, transitions };
}
