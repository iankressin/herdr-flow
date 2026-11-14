# Flow

Flow is a Herdr panel that runs an agent workflow as a state machine. Each step is a computer step, which runs a shell command, or an agent step, which starts an agent in a new tab of your space. A step passes or fails, and the machine's edges decide what runs next. The panel draws the machine, shows which step is running and how each agent is doing, and keeps every prompt, output and result on disk.

The engine is plain TypeScript in `src/` with no workflow library. Herdr loads the JavaScript that `npm run emit` writes to `mods/flow/lib/`.

## Install it in Herdr

1. Copy the mod folder into your Herdr home:

   ```sh
   mkdir -p ~/.config/herdr-app/mods
   cp -R mods/flow ~/.config/herdr-app/mods/flow
   ```

2. Check that it loads:

   ```sh
   herdr-app check ~/.config/herdr-app/mods/flow
   ```

Herdr docks the panel on the right the first time it sees the folder (`mod.json` sets `"place": "right"`). A broken file keeps the previous good version, and `herdr-app status` shows the error.

Flow runs programs. Computer steps run their command with `/bin/sh` in the run's folder. Agent steps run `hc run` to start `claude` (or the machine's `agent`). Flow writes only under `~/.config/herdr-app/data/flow/` and reaches no network itself.

## Run the example

The panel ships one machine, **Fix failing test**:

1. Claim (computer) runs your test command. If it passes, the run ends at **Already passing**.
2. Search (agent) finds the code behind the failing assertion. It edits nothing.
3. Diagnose (agent) names the root cause and the smallest fix.
4. Fix (agent) changes the code under test. It may not weaken the test. Fix runs at most 5 times.
5. Verify (computer) runs the test command again. A failure sends the run back to Fix with the new output. A pass goes to Judge.
6. Judge (agent) reviews `git diff` against the diagnosis. Accept ends at **Done**. Reject ends at **Gave up**.

Search, Diagnose and Fix go to **Gave up** when they fail. A sixth trip to Fix also ends at **Gave up**, with the note "max retries exceeded at Fix".

To run it:

1. Click a terminal in the space you want the agents to work in. Flow starts in that terminal's folder. It refuses a folder that holds its own files, such as your home folder, because agents can write where they work.
2. In the panel, type the test command that fails now, for example `npm test -- money`.
3. Click **Start in <space>**.
4. Click **Step** to run one step, or **Run** to keep going until the run finishes or fails.

While a step runs, its card shows a spinner. An agent card shows the agent's live status: working, needs you, stopped without a result, or closed. **Open agent** focuses the agent's terminal. **Mark pass** and **Mark fail** decide the step yourself. **Pause** stops after the current step. When a step cannot start, the run fails with the reason, and **Retry** runs that step again.

Click any card to see its command or prompt, what it requires and produces, and the summary of its latest attempt. **Copy focused prompt** copies the prompt an agent step would get now.

## How an agent step works

Each visit of an agent step gets its own folder, `runs/<run id>/visits/<node>-<visit>/`. Flow writes the prompt there as `prompt.md`, then starts the agent in a new tab:

```sh
hc run --bg --json --keep --no-parent --cwd <folder> --name flow-<hash> \
  --label herdr.space=<space> --label herdr.tab=<new tab id> \
  --label flow.run=<run id> --label flow.node=<node>-<visit> \
  <shell> -lic 'exec "$0" "$@"' claude --add-dir=<visit folder> "<prompt>"
```

Agents start through your login shell (`$SHELL -lic`), so they see the same tools as your terminals. `exec` makes the agent replace the shell, and the prompt stays its own argument.

The prompt holds the step's task, the values its `requires` names, the summaries of the steps that led to it along pass edges, and, on a second visit, its earlier attempts and the output that sent it back. It ends with a contract. The agent writes one JSON object to `result.json` in its visit folder, as its last act:

```json
{"outcome": "pass", "summary": "2-5 sentences", "values": {"patch": "src/money.ts: round in cents"}}
```

Flow watches the visit folder. A valid file completes the step. An invalid file leaves the step running and shows the error on the card. A `pass` must carry every `produces` key. A `fail` may leave them out.

## Define a machine

Machines are JSON files in `~/.config/herdr-app/data/flow/machines/`. Flow writes `fix-failing-test.json` there when the file is missing and never overwrites it. Edit a file or add one, then click **Reload**. Click the machine title to switch machines when there are several. A running run keeps the copy of its machine taken at start, so edits apply to the next run.

```ts
type Outcome = "pass" | "fail";

interface Machine {
	id: string;
	title: string;
	inputs: { key: string; label: string; default?: string }[];
	start: string;           // the first node
	onExhausted?: string;    // the end node a spent maxVisits leads to
	agent?: string[];        // default ["claude", "--add-dir={visitDir}"]; the prompt goes last
	nodes: MachineNode[];
	transitions: { from: string; on: Outcome; to: string; label?: string }[];
}

type MachineNode =
	| (Base & { kind: "computer"; run: string; timeoutSec?: number })   // timeoutSec at most 600
	| (Base & { kind: "agent"; prompt: string })
	| (Base & { kind: "end"; result: "success" | "failure"; description?: string });

interface Base {
	id: string;
	label: string;
	source?: { file: string; line: number };
	requires?: string[];
	produces?: string[];
	maxVisits?: number;
}
```

Flow rejects a machine when:

- an edge points at a node that does not exist,
- a working node has no `pass` edge,
- an end node has an edge out,
- a node has two edges for the same outcome,
- a node sets `maxVisits` and the machine has no `onExhausted` end node,
- a computer `run` uses `{{key}}` for anything but an input,
- a node `produces` a key that an input already uses, or
- `agent` uses `{runDir}`.

A computer step passes when its command exits 0. The last 8000 characters of its output become the value of each `produces` key. A missing edge for an outcome stops the run with an error.

### Keep step values out of commands

`{{key}}` in an agent prompt takes inputs and step values. `{{key}}` in a computer `run` takes inputs only, because you typed those. Agents can read untrusted code, so their values never become shell text. A command reads a step value from an environment variable instead: `diagnosis` is `$FLOW_DIAGNOSIS`, and `verify_output` is `$FLOW_VERIFY_OUTPUT`.

```json
{ "id": "lint", "kind": "computer", "label": "Lint", "run": "test -n \"$FLOW_PATCH\" && {{lint_command}}" }
```

## Files

Everything lives under `~/.config/herdr-app/data/flow/`:

| File | What it holds |
| --- | --- |
| `machines/*.json` | Your machines |
| `state.json` | `{"current": "<run id>"}`, the run the panel shows |
| `runs/<run id>/run.json` | The run: its machine copy, inputs, status, visits, values and attempts |
| `runs/<run id>/<node>-<visit>.output.txt` | A computer step's full output |
| `runs/<run id>/visits/<node>-<visit>/prompt.md` | The prompt an agent step got |
| `runs/<run id>/visits/<node>-<visit>/result.json` | The result the agent wrote |
| `focused-prompt.md` | The last prompt you copied |

An agent can write only its own visit folder. It cannot reach `run.json`, which holds the commands Flow runs, or the command outputs. When the panel loads `run.json`, it checks the embedded machine with the same rules as a machine file, and checks every other field. A run that fails the check shows its error and does not run. Before each step, Flow also refuses a run folder that contains `~/.config/herdr-app/data/flow`, after resolving both with `realpath`.

When the panel loads, it picks up the current run. It keeps watching a live agent, adopts an agent terminal that a closed panel started, or starts the agent again. It reruns a command that was running. Each visit's agent has a fixed `hc` terminal name, so herdr-core refuses a second agent for the same visit. Flow writes `run.json` with compare-and-swap. If another Flow panel changed the run, this panel reloads it and stops driving it. **Reload** takes it back.

## Watch out

- In a folder Claude has not seen, it asks to trust the folder before it reads the prompt. Flow shows "needs you" after 15 seconds and a toast; answer in the agent's tab (**Open agent**). Flow never answers for you.

## Develop

Node 22 or newer runs the tests.

```sh
npm install
npm run check   # tsc, then emit mods/flow/lib, then the tests
```

After you edit `src/`, run `npm run emit` and copy `mods/flow` over the installed copy. Herdr reloads the panel on save.

```
src/machine.ts     types, parseMachine, fillTemplate
src/engine.ts      the run reducer: createRun, begin, complete, fail, retry, setAuto
src/prompt.ts      buildAgentPrompt
src/result.ts      parseAgentResult
src/agentstate.ts  agentLook: starting, not started, trust dialog, or the agent's status
src/layout.ts      card and pill positions
src/example.ts     the fix-failing-test machine
mods/flow/main.js  the panel: runs commands, starts agents, writes files, draws
test/flow.test.ts  tests for src/
RECIPE.md          the brief another agent can rebuild the mod from
```
