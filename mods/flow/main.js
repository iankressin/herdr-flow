// Flow: one agent workflow, drawn as a state machine and run for real.
// Computer steps run a shell command. Agent steps start an agent in a new tab of the run's space
// and wait for the result file it writes. ./lib holds the pure engine; this file does the I/O.

import { View, div } from "gpui-kit";
import { Input, InputState, h_flex, v_flex } from "gpui-base";
import { readdir } from "fs/promises";
import {
  agents,
  appHome,
  exec,
  focused,
  hc,
  home,
  readTextFile,
  run as command,
  spaces,
  terminals,
  theme,
  watchFolder,
  writeTextFile,
} from "herdr";
import {
  attachAgent,
  begin,
  commandResult,
  complete,
  createRun,
  fail,
  isExecuting,
  isInside,
  pendingEffect,
  retry,
  setAuto,
} from "./lib/engine.js";
import { fixFailingTest } from "./lib/example.js";
import { layoutGraph } from "./lib/layout.js";
import { DEFAULT_AGENT, nodeOf, parseMachine } from "./lib/machine.js";
import { buildAgentPrompt } from "./lib/prompt.js";
import { parseAgentResult } from "./lib/result.js";
import { parseRun } from "./lib/runfile.js";

const RED = "#c4544a";
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// A watch event can slip between reading the result file and starting the next watch, so the
// file is also read this often while an agent works.
const RECHECK_MS = 5000;
const SUMMARY_LINES = 200;

const flowDir = () => `${appHome()}/data/flow`;
const machinesDir = () => `${flowDir()}/machines`;
const stateFile = () => `${flowDir()}/state.json`;
const runDir = (id) => `${flowDir()}/runs/${id}`;
const runFile = (id) => `${runDir(id)}/run.json`;
const outputFile = (id, node, visit) => `${runDir(id)}/${node}-${visit}.output.txt`;

/** The only folder an agent may write: its prompt and its result, nothing the panel runs. */
function visitFiles(id, node, visit) {
  const dir = `${runDir(id)}/visits/${node}-${visit}`;
  return { dir, promptPath: `${dir}/prompt.md`, resultPath: `${dir}/result.json` };
}

/** Reads run.json through parseRun, since it holds the commands this panel runs. */
async function readRun(id) {
  const text = await readTextFile(runFile(id));
  if (text == null) throw new Error(`Run ${id} has no run.json`);
  const run = parseRun(JSON.parse(text));
  if (run.id !== id) throw new Error(`run.json in ${id} names run ${run.id}`);
  return { run, text };
}

async function realpath(path) {
  const resolved = await exec("realpath", [path]);
  if (resolved.code !== 0) throw new Error(`Flow can't find ${path}: ${resolved.stderr.trim()}`);
  return resolved.stdout.trim();
}

/** Why a run may not work in `folder`, or null. Agents can write where they work. */
async function folderProblem(folder) {
  try {
    if (!isInside(await realpath(flowDir()), await realpath(folder))) return null;
  } catch (error) {
    return message(error);
  }
  return `Flow can't run in ${folder}: agents working there could edit Flow's own files. Start it from a project folder.`;
}
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const message = (error) => String(error?.message ?? error);
const alpha = (color, aa) => (/^#[0-9a-f]{6}$/i.test(color) ? color + aa : color);
const list = (keys) => (keys?.length ? keys.join(", ") : "none");

function wait(cx, ms) {
  return new Promise((resolve) => cx.timer.after(ms, () => resolve()));
}

/** For files no other writer races for: prompts, outputs, state.json, the copied prompt. */
async function replaceFile(path, text) {
  await writeTextFile(path, text, await readTextFile(path));
}

function newTabId() {
  let id = "tb";
  for (let i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

/**
 * One terminal name per run, node and visit. herdr-core refuses a second live terminal with the
 * same name, so two panels resuming the same visit can never both start its agent.
 */
function agentName(id, node, visit) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const char of `${id}/${node}-${visit}`) {
    a = Math.imul(a ^ char.charCodeAt(0), 0x01000193) >>> 0;
    b = Math.imul(b ^ char.charCodeAt(0), 0x5bd1e995) >>> 0;
  }
  return `flow-${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

function newRunId(machine, now) {
  return `${new Date(now).toISOString().replace(/[-:]/g, "").slice(0, 15)}-${machine.id}`;
}

function currentNode(run) {
  const status = run.status;
  switch (status.kind) {
    case "idle":
      return status.next;
    case "finished":
      return status.end;
    default:
      return status.node;
  }
}

/** A change that applies only while run `id` is still executing `node` at `visit`. */
function at(id, node, visit, change) {
  return (run) => (run.id === id && isExecuting(run, node, visit) ? change(run) : run);
}

function statusText(run, live) {
  if (!run) return "ready";
  const status = run.status;
  switch (status.kind) {
    case "idle":
      return "ready";
    case "executing":
      return live?.blocked ? "needs you" : `running ${nodeOf(run.machine, status.node).label}`;
    case "finished":
      return `finished: ${status.result}${status.note ? ` (${status.note})` : ""}`;
    case "failed":
      return `failed: ${status.error}`;
  }
}

function button(id, label, primary, t, onClick) {
  return div()
    .id(id)
    .h(28)
    .px(10)
    .rounded(6)
    .flex()
    .items_center()
    .cursor_pointer()
    .bg(primary ? t.solid : t.raised)
    .text_color(primary ? t.solid_foreground : t.foreground)
    .text_size(12)
    .font_medium()
    .hover((s) => s.opacity(0.88))
    .on_click((_event, cx) => onClick(cx))
    .child(label);
}

function lines(id, text, color) {
  const parts = String(text).split("\n").slice(-SUMMARY_LINES);
  return v_flex()
    .id(id)
    .gap(1)
    .children(parts.map((line, index) => div().id(`${id}-${index}`).text_size(12).text_color(color).child(line || " ")));
}

export default class Flow extends View {
  init(_props, cx) {
    this.machines = [{ machine: fixFailingTest, file: null }];
    this.problems = [];
    this.pick = 0;
    this.fields = {};
    this.run = null;
    // run.json as this panel last wrote or read it: the expected text for compare-and-swap.
    this.written = null;
    this.owner = false;
    this.busy = false;
    this.starting = false;
    this.queue = Promise.resolve();
    this.waiters = [];
    this.startError = null;
    this.resultError = null;
    this.selected = fixFailingTest.start;
    this.follow = true;
    this.note = "";
    this.makeFields();
    // herdr-app check renders this first view and never fires timers, so it does no I/O.
    cx.timer.after(0, (cx) => this.boot(cx));
  }

  get machine() {
    return this.machines[this.pick]?.machine ?? fixFailingTest;
  }

  makeFields() {
    const old = this.fields;
    this.fields = {};
    for (const input of this.machine.inputs) {
      this.fields[input.key] = InputState.new({ value: old[input.key]?.value() ?? input.default ?? "", placeholder: input.label });
    }
  }

  boot(cx) {
    cx.spawn(async (cx) => {
      try {
        await exec("mkdir", ["-p", machinesDir(), `${flowDir()}/runs`]);
        await this.loadMachines();
        await this.loadCurrent();
      } catch (error) {
        this.note = message(error);
      }
      cx.notify();
      this.resume(cx);
    });
  }

  async loadMachines() {
    const example = `${machinesDir()}/${fixFailingTest.id}.json`;
    if ((await readTextFile(example)) == null) await writeTextFile(example, json(fixFailingTest), null);
    const machines = [];
    const problems = [];
    for (const file of (await readdir(machinesDir())).filter((name) => name.endsWith(".json")).sort()) {
      try {
        machines.push({ machine: parseMachine(JSON.parse(await readTextFile(`${machinesDir()}/${file}`))), file });
      } catch (error) {
        problems.push(`${file}: ${message(error)}`);
      }
    }
    const shown = this.machine.id;
    this.machines = machines.length ? machines : [{ machine: fixFailingTest, file: null }];
    this.pick = Math.max(0, this.machines.findIndex((item) => item.machine.id === shown));
    this.problems = problems;
    this.makeFields();
    if (!this.run) this.selected = this.machine.start;
  }

  async loadCurrent() {
    const state = await readTextFile(stateFile());
    const id = state ? JSON.parse(state).current : null;
    if (!id) return;
    const { run, text } = await readRun(id);
    this.adopt(run, text);
  }

  adopt(run, text) {
    this.run = run;
    this.written = text;
    this.owner = true;
    this.resultError = null;
    this.selected = currentNode(run);
    this.follow = true;
  }

  /** Picks up where a closed or reloaded panel left off. Every step it takes is safe to repeat. */
  resume(cx) {
    const run = this.run;
    if (!run || !this.owner) return;
    if (run.status.kind === "executing" || (run.status.kind === "idle" && run.auto)) this.drive(cx);
  }

  /**
   * Changes the run and writes run.json, one change at a time, each against the latest run. The
   * write is compare-and-swap with the text this panel last wrote: a refusal means another panel
   * moved the run, so this one reloads it and stops driving.
   */
  update(cx, change) {
    const step = this.queue.then(async () => {
      const run = this.run;
      if (!run || !this.owner) return false;
      const next = change(run);
      if (next === run) return true;
      const stamped = { ...next, updatedAt: Date.now() };
      const text = json(stamped);
      try {
        await writeTextFile(runFile(run.id), text, this.written);
      } catch (error) {
        await this.yieldRun(run.id, error);
        cx.notify();
        return false;
      }
      this.run = stamped;
      this.written = text;
      if (this.follow) this.selected = currentNode(stamped);
      this.wake();
      cx.notify();
      return true;
    });
    this.queue = step.catch(() => false);
    return step;
  }

  async yieldRun(id, error) {
    this.owner = false;
    this.wake();
    this.note = `Another Flow panel moved this run, so this one stopped driving it (${message(error)}). Reload takes it back.`;
    try {
      const { run, text } = await readRun(id);
      if (this.run?.id !== id) return;
      this.run = run;
      this.written = text;
    } catch (loadError) {
      this.note = `This panel stopped driving the run: ${message(loadError)}`;
    }
  }

  still(id, node, visit) {
    return this.owner && this.run?.id === id && isExecuting(this.run, node, visit);
  }

  wake() {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  /** Resolves at the next change to the run (or to who drives it). */
  changed() {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Resolves once the run is no longer executing this visit here, say because a person decided it. */
  async left(id, node, visit) {
    while (this.still(id, node, visit)) await this.changed();
  }

  /** Runs the next step, then keeps going while the run is on auto. One loop per panel. */
  drive(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        let first = true;
        while (this.run && this.owner && (first || this.run.auto)) {
          first = false;
          const id = this.run.id;
          const problem = await folderProblem(this.run.folder);
          if (problem) {
            await this.update(cx, (run) => (run.id === id ? fail(run, problem) : run));
            break;
          }
          let effect = { kind: "none" };
          if (this.run.status.kind === "idle") {
            const begun = await this.update(cx, (run) => {
              const next = begin(run, Date.now());
              effect = next.effect;
              return next.run;
            });
            if (!begun) break;
          } else if (this.run.status.kind === "executing") {
            // Resuming: a write claims the run first, so two panels never both perform the step.
            if (!(await this.update(cx, (run) => ({ ...run })))) break;
            effect = pendingEffect(this.run);
          } else {
            break;
          }
          if (effect.kind === "command") await this.runCommand(cx, id, effect);
          if (effect.kind === "agent") await this.runAgent(cx, id, effect.node, effect.visit);
        }
      } catch (error) {
        this.note = message(error);
      }
      this.busy = false;
      cx.notify();
    });
  }

  async runCommand(cx, id, effect) {
    const run = this.run;
    const visit = run.status.visit;
    const node = nodeOf(run.machine, effect.node);
    const env = Object.entries(effect.env).map(([key, value]) => `${key}=${value}`);
    // Step values travel as environment variables in argv; the shell text holds inputs only.
    // -lic: tools such as npm are set up in the person's shell rc, as Herdr's agent launcher assumes.
    // The command is one argv element ($1), never spliced into shell code. It merges stderr itself, so
    // stdout holds its output; stderr only carries shell start-up noise.
    const running = exec(
      "/usr/bin/env",
      [...env, "/bin/sh", "-c", 'exec "${SHELL:-/bin/sh}" -lic "$1"', "flow", `exec 2>&1\n${effect.command}`],
      { cwd: run.folder, timeout: effect.timeoutSec * 1000 },
    )
      .then(
        (result) => ({ exitCode: result.code, output: result.stdout || result.stderr }),
        (error) => ({ error: message(error), output: "" }),
      )
      .then(async (ran) => {
        await replaceFile(outputFile(id, node.id, visit), "error" in ran ? ran.error : ran.output).catch(() => {});
        return ran;
      });
    // A person may decide the step while a hung command runs on; stop waiting for it then.
    const ran = await Promise.race([running, this.left(id, node.id, visit).then(() => null)]);
    if (ran) await this.update(cx, at(id, node.id, visit, (current) => complete(current, commandResult(node, ran), Date.now())));
  }

  async runAgent(cx, id, nodeId, visit) {
    const node = nodeOf(this.run.machine, nodeId);
    // The paths always come from the run id, node and visit; run.json keeps a copy for people.
    const files = visitFiles(id, nodeId, visit);
    await exec("mkdir", ["-p", files.dir]);
    let handle = this.run.status.agent;
    if (!handle) {
      const fresh = { tab: newTabId(), promptPath: files.promptPath, resultPath: files.resultPath };
      await this.update(cx, at(id, nodeId, visit, (run) => attachAgent(run, fresh)));
      if (!this.still(id, nodeId, visit)) return;
      handle = fresh;
    }
    if (!handle.terminal) {
      if (await this.collect(cx, id, node, visit, files)) return;
      const terminal = (await this.findAgent(id, nodeId, visit)) ?? (await this.launch(cx, id, node, visit, handle.tab, files));
      if (!terminal) return;
      const live = { ...handle, terminal };
      await this.update(cx, at(id, nodeId, visit, (run) => attachAgent(run, live)));
      if (!this.still(id, nodeId, visit)) return;
      this.nameTab(cx, live.tab, `${node.label} #${visit}`);
    }
    await this.watchResult(cx, id, node, visit, files);
  }

  /** A live terminal a crashed panel already started for this visit. */
  async findAgent(id, node, visit) {
    try {
      const listed = await hc(["ls", "--json", "--label", `flow.run=${id}`, "--label", `flow.node=${node}-${visit}`]);
      return JSON.parse(listed.stdout).terminals?.find((terminal) => terminal.state === "live")?.address ?? null;
    } catch {
      return null;
    }
  }

  async launch(cx, id, node, visit, tab, files) {
    const run = this.run;
    const prompt = buildAgentPrompt(run, node.id, { resultPath: files.resultPath });
    const argv = (run.machine.agent ?? DEFAULT_AGENT).map((part) => part.split("{visitDir}").join(files.dir));
    let error;
    try {
      await replaceFile(files.promptPath, prompt);
      // The labels put the agent in a new tab of the run's space. The prompt goes last: Claude's
      // --add-dir takes several values and would swallow a prompt that followed it.
      const started = await hc([
        "run", "--bg", "--json", "--keep", "--no-parent", "--cwd", run.folder,
        "--name", agentName(id, node.id, visit),
        "--label", `herdr.space=${run.space.id}`,
        "--label", `herdr.tab=${tab}`,
        "--label", `flow.run=${id}`,
        "--label", `flow.node=${node.id}-${visit}`,
        ...argv,
        prompt,
      ]);
      const address = started.code === 0 ? JSON.parse(started.stdout).address : null;
      if (address) return address;
      // name_taken: another panel started this visit's agent a moment ago.
      const other = await this.findAgent(id, node.id, visit);
      if (other) return other;
      error = (started.stderr || started.stdout).trim() || `hc exited ${started.code}`;
    } catch (caught) {
      error = message(caught);
    }
    await this.update(cx, at(id, node.id, visit, (current) => fail(current, `Could not start the agent: ${error}`)));
    return null;
  }

  /** The app can learn of a new tab a moment after hc returns, so the rename waits for it. */
  nameTab(cx, tab, name) {
    cx.spawn(async (cx) => {
      for (let i = 0; i < 20 && !spaces().some((space) => space.tabs.some((item) => item.id === tab)); i++) await wait(cx, 250);
      command("tab.rename", { id: tab, name });
    });
  }

  /** Completes the step and returns true when the agent's result file holds a valid result. */
  async collect(cx, id, node, visit, files) {
    const text = await readTextFile(files.resultPath);
    if (text == null) return false;
    const result = parseAgentResult(text, node.produces ?? []);
    if ("error" in result) {
      if (this.resultError?.error !== result.error) {
        this.resultError = { id, node: node.id, visit, error: result.error };
        cx.notify();
      }
      return false;
    }
    this.resultError = null;
    await this.update(cx, at(id, node.id, visit, (run) => complete(run, { ...result, by: "agent" }, Date.now())));
    return true;
  }

  async watchResult(cx, id, node, visit, files) {
    let change = null;
    while (this.still(id, node.id, visit)) {
      if (await this.collect(cx, id, node, visit, files)) return;
      if (!change) {
        change = watchFolder(files.dir).then(
          () => {
            change = null;
          },
          () =>
            wait(cx, RECHECK_MS).then(() => {
              change = null;
            }),
        );
      }
      await Promise.race([change, wait(cx, RECHECK_MS), this.changed()]);
    }
  }

  startSpace() {
    const where = focused();
    const space = spaces().find((item) => item.id === where?.space);
    if (!space) return { error: "Focus a space to start a run in it." };
    if (space.machine != null) return { error: `Flow runs agents on this computer only, and ${space.name} is on ${space.machine}.` };
    return { space, folder: where.cwd || space.folder || home() };
  }

  start(cx) {
    const where = this.startSpace();
    if (where.error) {
      this.note = where.error;
      return;
    }
    const machine = this.machine;
    const inputs = {};
    for (const input of machine.inputs) {
      const value = this.fields[input.key].value().trim();
      if (!value) {
        this.note = `Fill in "${input.label}" first.`;
        return;
      }
      inputs[input.key] = value;
    }
    if (this.starting) return;
    this.starting = true;
    this.startError = null;
    cx.spawn(async (cx) => {
      try {
        this.startError = await folderProblem(where.folder);
        if (!this.startError) {
          const now = Date.now();
          const space = { id: where.space.id, name: where.space.name };
          const run = createRun(machine, { id: newRunId(machine, now), space, folder: where.folder, inputs, now });
          const text = json(run);
          await exec("mkdir", ["-p", runDir(run.id)]);
          await writeTextFile(runFile(run.id), text, null);
          await replaceFile(stateFile(), json({ current: run.id }));
          this.adopt(run, text);
          this.note = "";
        }
      } catch (error) {
        this.note = message(error);
      }
      this.starting = false;
      cx.notify();
    });
  }

  newRun(cx) {
    this.run = null;
    this.written = null;
    this.owner = false;
    this.resultError = null;
    this.selected = this.machine.start;
    this.follow = true;
    this.note = "";
    this.wake();
    cx.spawn(async (cx) => {
      try {
        await replaceFile(stateFile(), json({ current: null }));
      } catch (error) {
        this.note = message(error);
      }
      cx.notify();
    });
  }

  auto(cx, on) {
    cx.spawn(async (cx) => {
      if ((await this.update(cx, (run) => setAuto(run, on))) && on) this.drive(cx);
    });
  }

  mark(cx, outcome) {
    cx.spawn(async (cx) => {
      await this.update(cx, (run) => complete(run, { outcome, summary: `Marked ${outcome} by hand.`, values: {}, by: "person" }, Date.now()));
      if (this.run?.auto) this.drive(cx);
    });
  }

  retryStep(cx) {
    cx.spawn(async (cx) => {
      await this.update(cx, retry);
      if (this.run?.status.kind === "idle") this.drive(cx);
    });
  }

  reload(cx) {
    cx.spawn(async (cx) => {
      try {
        await this.loadMachines();
        if (this.run && !this.busy) {
          this.owner = false;
          const { run, text } = await readRun(this.run.id);
          this.adopt(run, text);
        }
        this.note = "Reloaded.";
      } catch (error) {
        this.note = message(error);
      }
      cx.notify();
      this.resume(cx);
    });
  }

  cycle(cx) {
    this.pick = (this.pick + 1) % this.machines.length;
    this.makeFields();
    this.selected = this.machine.start;
    cx.notify();
  }

  openAgent(terminal, tab) {
    if (terminal && agents().some((agent) => agent.address === terminal)) command("agent.focus", { terminal });
    else if (tab && spaces().some((space) => space.tabs.some((item) => item.id === tab))) command("tab.select", { id: tab });
    else this.note = "That agent's terminal and tab are gone.";
  }

  copyPrompt(cx, node) {
    const run = this.run ?? this.previewRun();
    const status = run.status;
    const resultPath = status.kind === "executing" && status.node === node.id && status.agent ? status.agent.resultPath : "<result file>";
    const text = buildAgentPrompt(run, node.id, { resultPath });
    let copied = false;
    try {
      cx.write_to_clipboard(text);
      copied = true;
    } catch {
      copied = false;
    }
    cx.spawn(async (cx) => {
      const file = `${flowDir()}/focused-prompt.md`;
      try {
        await replaceFile(file, text);
        if (!copied) await exec("/bin/sh", ["-c", 'pbcopy < "$1"', "sh", file]);
        this.note = `Copied the ${node.label} prompt. It is also in ${file}`;
      } catch (error) {
        this.note = message(error);
      }
      cx.notify();
    });
  }

  previewRun() {
    const where = this.startSpace();
    const inputs = Object.fromEntries(this.machine.inputs.map((input) => [input.key, this.fields[input.key].value()]));
    const space = { id: where.space?.id ?? "", name: where.space?.name ?? "" };
    return createRun(this.machine, { id: "preview", space, folder: where.folder ?? "", inputs, now: Date.now() });
  }

  /** How the executing agent is doing, from Herdr's live lists. Null unless an agent step runs. */
  agentState(run) {
    const status = run.status;
    if (status.kind !== "executing" || nodeOf(run.machine, status.node).kind !== "agent") return null;
    const terminal = status.agent?.terminal;
    if (!terminal) return { text: "starting", spin: true };
    const error =
      this.resultError?.id === run.id && this.resultError.node === status.node && this.resultError.visit === status.visit
        ? this.resultError.error
        : null;
    const agent = agents().find((item) => item.address === terminal);
    if (agent?.status === "blocked") return { text: "needs you", blocked: true };
    if (agent?.status === "working") return { text: "working", spin: true };
    if (agent) return { text: error ? `bad result: ${error}` : "stopped without a result", stuck: true };
    const live = terminals().find((item) => item.address === terminal);
    if (!live || live.state !== "live") return { text: error ? `closed, bad result: ${error}` : "closed", stuck: true };
    return { text: "starting", spin: true };
  }

  render() {
    const t = theme();
    const run = this.run;
    const machine = run?.machine ?? this.machine;
    const layout = layoutGraph(machine, run);
    const live = run ? this.agentState(run) : null;
    const selected = machine.nodes.find((node) => node.id === this.selected) ?? nodeOf(machine, machine.start);
    const canvas = [];
    if (layout.spine) {
      const { x, y1, y2 } = layout.spine;
      canvas.push(div().id("spine").absolute().left(x).top(y1).w(2).h(Math.max(2, y2 - y1)).bg(t.border));
    }
    for (const box of layout.nodes) canvas.push(this.card(t, machine, run, box, live));
    for (const pill of layout.pills) canvas.push(this.pill(t, run, pill));

    return v_flex()
      .id("flow-root")
      .size_full()
      .bg(t.canvas)
      .text_color(t.foreground)
      .child(this.header(t, machine, run, live))
      .child(run ? this.actions(t, run, live) : this.startForm(t, machine))
      .child(
        div()
          .id("flow-scroll")
          .flex_1()
          .overflow_y_scrollbar()
          .child(div().relative().id("flow-canvas").w(layout.width).h(layout.height).children(canvas)),
      )
      .child(this.detail(t, machine, run, selected));
  }

  header(t, machine, run, live) {
    const several = !run && this.machines.length > 1;
    const where = run ? run.space.name : (spaces().find((space) => space.id === focused()?.space)?.name ?? "no space");
    return v_flex()
      .px(12)
      .pt(12)
      .pb(8)
      .gap(4)
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(div().text_size(11).font_medium().text_color(t.dim).child("FLOW"))
          .child(button("flow-reload", "Reload", false, t, (cx) => this.reload(cx))),
      )
      .child(
        div()
          .id("flow-title")
          .text_size(16)
          .font_semibold()
          .when(several, (el) => el.cursor_pointer().on_click((_event, cx) => this.cycle(cx)))
          .child(several ? `${machine.title}  ${this.pick + 1}/${this.machines.length}` : machine.title),
      )
      .child(
        div()
          .text_size(12)
          .text_color(live?.blocked ? t.blocked : run?.status.kind === "failed" ? RED : t.muted)
          .child(`${where} · ${statusText(run, live)}`),
      )
      .children(this.problems.map((problem, index) => div().id(`problem-${index}`).text_size(11).text_color(RED).child(problem)));
  }

  startForm(t, machine) {
    const where = this.startSpace();
    return v_flex()
      .px(12)
      .py(8)
      .gap(6)
      .children(
        machine.inputs
          .map((input) =>
            v_flex()
              .id(`input-${input.key}`)
              .gap(4)
              .child(div().text_size(11).text_color(t.dim).child(input.label))
              .child(
                Input.new(this.fields[input.key])
                  .h(30)
                  .px(8)
                  .rounded(6)
                  .border(1)
                  .border_color(t.input)
                  .bg(t.background)
                  .text_size(12)
                  .text_color(t.foreground),
              ),
          ),
      )
      .child(
        h_flex().child(
          button("flow-start", where.error ? "Start" : `Start in ${where.space.name}`, true, t, (cx) => {
            this.start(cx);
            cx.notify();
          }),
        ),
      )
      .when(Boolean(where.error ?? this.startError), (el) => el.child(div().text_size(11).text_color(RED).child(where.error ?? this.startError)));
  }

  actions(t, run, live) {
    const status = run.status;
    const row = [];
    const act = (id, label, primary, onClick) =>
      row.push(
        button(id, label, primary, t, (cx) => {
          onClick(cx);
          cx.notify();
        }),
      );
    switch (status.kind) {
      case "idle":
        act("flow-step", "Step", true, (cx) => this.drive(cx));
        act("flow-run", "Run", false, (cx) => this.auto(cx, true));
        act("flow-new", "New run", false, (cx) => this.newRun(cx));
        break;
      case "executing":
        if (run.auto) act("flow-pause", "Pause", false, (cx) => this.auto(cx, false));
        if (status.agent?.terminal) act("flow-open", "Open agent", Boolean(live?.blocked), () => this.openAgent(status.agent.terminal, status.agent.tab));
        act("flow-pass", "Mark pass", false, (cx) => this.mark(cx, "pass"));
        act("flow-fail", "Mark fail", false, (cx) => this.mark(cx, "fail"));
        break;
      case "failed":
        act("flow-retry", "Retry", true, (cx) => this.retryStep(cx));
        act("flow-pass", "Mark pass", false, (cx) => this.mark(cx, "pass"));
        act("flow-fail", "Mark fail", false, (cx) => this.mark(cx, "fail"));
        act("flow-new", "New run", false, (cx) => this.newRun(cx));
        break;
      case "finished":
        act("flow-new", "New run", true, (cx) => this.newRun(cx));
        break;
    }
    return h_flex().px(12).py(8).gap(6).flex_wrap().children(row);
  }

  cardStatus(t, node, run, live) {
    const status = run?.status;
    if (node.kind === "end") {
      const color = node.result === "success" ? t.done : RED;
      if (status?.kind === "finished" && status.end === node.id) return { text: status.note ?? `reached: ${node.result}`, color };
      return { text: node.description ?? node.result, color: t.muted };
    }
    if (status?.kind === "executing" && status.node === node.id) {
      if (node.kind === "computer") return { text: `running #${status.visit}`, spin: true, color: t.working };
      return { text: `${live.text} #${status.visit}`, spin: live.spin, color: live.blocked ? t.blocked : live.stuck ? RED : t.working };
    }
    if (status?.kind === "failed" && status.node === node.id) return { text: "stopped: retry or mark it", color: RED };
    const mine = run?.attempts.filter((attempt) => attempt.node === node.id) ?? [];
    const passed = mine.filter((attempt) => attempt.outcome === "pass").length;
    const failed = mine.length - passed;
    const counts = [passed ? `passed ×${passed}` : "", failed ? `failed ×${failed}` : ""].filter(Boolean);
    if (counts.length) return { text: counts.join(" · "), color: t.muted };
    if (status?.kind === "idle" && status.next === node.id) return { text: "next", color: t.muted };
    return { text: "waiting", color: t.muted };
  }

  card(t, machine, run, box, live) {
    const node = nodeOf(machine, box.id);
    const isSelected = node.id === this.selected;
    const current = run != null && currentNode(run) === node.id;
    const reached = node.kind === "end" && run?.status.kind === "finished" && run.status.end === node.id;
    const endColor = node.kind === "end" ? (node.result === "success" ? t.done : RED) : null;
    const status = this.cardStatus(t, node, run, live);
    const edge = node.kind === "agent" ? t.accent : reached ? endColor : t.border;
    const badge = node.kind === "agent" ? t.accent : reached ? endColor : t.dim;
    return div()
      .id(`node-${node.id}`)
      .absolute()
      .left(box.x)
      .top(box.y)
      .w(box.w)
      .h(box.h)
      .rounded(8)
      .border(isSelected ? 2 : 1)
      .border_color(isSelected ? t.foreground : edge)
      .bg(reached ? alpha(endColor, "2e") : current ? t.selected : t.surface)
      .p(8)
      .cursor_pointer()
      .on_click((_event, cx) => {
        this.selected = node.id;
        this.follow = run != null && currentNode(run) === node.id;
        cx.notify();
      })
      .child(
        v_flex()
          .gap(2)
          .child(div().text_size(10).font_medium().text_color(badge).child(node.kind.toUpperCase()))
          .child(div().text_size(14).font_semibold().text_color(t.foreground).truncate().child(node.label))
          .child(
            h_flex()
              .gap(4)
              .when(Boolean(status.spin), (el) => el.child(div().w(12).text_size(11).text_color(status.color).frames(SPIN, 90)))
              .child(div().text_size(11).text_color(status.color).truncate().child(status.text)),
          ),
      );
  }

  pill(t, run, pill) {
    const color = pill.kind === "budget" ? t.accent : RED;
    const used = pill.kind === "budget" ? (run?.visits[pill.node] ?? 0) : 0;
    return div()
      .id(pill.id)
      .absolute()
      .left(pill.x)
      .top(pill.y)
      .w(pill.w)
      .h(pill.h)
      .rounded(6)
      .border(1)
      .border_color(color)
      .bg(pill.taken ? RED : t.canvas)
      .px(8)
      .flex()
      .items_center()
      .child(
        div()
          .text_size(11)
          .font_medium()
          .text_color(pill.taken ? "#ffffff" : color)
          .truncate()
          .child(used ? `${pill.text} · ${used} used` : pill.text),
      );
  }

  detail(t, machine, run, node) {
    const status = run?.status;
    const attempts = run?.attempts.filter((attempt) => attempt.node === node.id) ?? [];
    const attempt = attempts[attempts.length - 1];
    const handle = status?.kind === "executing" && status.node === node.id ? status.agent : null;
    const terminal = handle?.terminal ?? attempt?.terminal;
    const tab = handle?.tab ?? attempt?.tab;
    const body = node.kind === "computer" ? node.run : node.kind === "agent" ? node.prompt : (node.description ?? "");
    const resultError =
      handle && this.resultError?.id === run.id && this.resultError.node === node.id && this.resultError.visit === status.visit
        ? this.resultError.error
        : null;
    return v_flex()
      .id("node-detail")
      .border_t(1)
      .border_color(t.border)
      .bg(t.surface)
      .p(12)
      .gap(6)
      .child(
        h_flex()
          .justify_between()
          .items_center()
          .child(div().text_size(14).font_semibold().child(node.label))
          .child(div().text_size(11).text_color(node.kind === "agent" ? t.accent : t.dim).child(node.kind)),
      )
      .when(Boolean(node.source), (el) => el.child(div().text_size(11).text_color(t.dim).child(`${node.source.file}:${node.source.line}`)))
      .child(div().id("node-body").max_h(96).overflow_y_scrollbar().child(div().text_size(12).text_color(t.foreground).child(body)))
      .when(node.kind !== "end", (el) =>
        el.child(div().text_size(11).text_color(t.muted).child(`requires ${list(node.requires)} · produces ${list(node.produces)}`)),
      )
      .when(Boolean(attempt), (el) =>
        el
          .child(
            div()
              .text_size(11)
              .text_color(attempt.outcome === "fail" ? RED : t.muted)
              .child(`Attempt ${attempt.visit}: ${attempt.outcome}, by ${attempt.by}`),
          )
          .child(div().id("attempt-summary").max_h(18 * 15).overflow_y_scrollbar().child(lines("summary-line", attempt.summary, t.foreground))),
      )
      .when(Boolean(resultError), (el) => el.child(div().text_size(11).text_color(RED).child(`Result file: ${resultError}`)))
      .child(
        h_flex()
          .gap(6)
          .when(node.kind === "agent", (el) => el.child(button("copy-prompt", "Copy focused prompt", true, t, (cx) => this.copyPrompt(cx, node))))
          .when(Boolean(terminal), (el) =>
            el.child(
              button("detail-open", "Open agent", false, t, (cx) => {
                this.openAgent(terminal, tab);
                cx.notify();
              }),
            ),
          ),
      )
      .child(div().id("flow-note").text_size(11).text_color(t.muted).child(this.note || " "));
  }
}
