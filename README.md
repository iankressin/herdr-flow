# Flow

A Herdr mod that draws an agent workflow as a state machine, steps it, and copies a focused prompt for the node you selected.

The machine, the runner, and the prompt builder do not use a workflow library. They are plain TypeScript in `src/`. Herdr loads the emitted JavaScript in `mods/flow/lib/`.

## Install in Herdr

Copy the mod folder into your Herdr home:

```sh
mkdir -p ~/.config/herdr-app/mods
cp -R mods/flow ~/.config/herdr-app/mods/flow
```

Restart is not required. Herdr docks a new mod on the right the first time it sees the folder (`mod.json` says `"place": "right"`). If it does not appear, open the command palette and look for the Flow panel, or run:

```sh
herdr-app check ~/.config/herdr-app/mods/flow
```

`herdr-app check` must pass. A broken file keeps the previous good version and the error shows in `herdr-app status`.

Saved machines, the run snapshot, and the last focused prompt live only under `~/.config/herdr-app/data/`:

| File | What it is |
| --- | --- |
| `data/machines/fix-failing-test.json` | The machine the panel last saved |
| `data/flow-run.json` | Active node, completed nodes, visit counts |
| `data/focused-prompt.md` | Last focused prompt |

## Run the example

The panel opens on **Fix failing test**:

1. Claim (computer) records the failing test.
2. Search (agent) looks through the repo.
3. Diagnose (agent) names the cause.
4. Fix (agent) patches. A loop edge says `retries < 5`.
5. Verify (computer) runs the test. If it fails, an error edge returns to Fix.
6. Judge (agent) accepts or rejects.
7. Done and Gave up are the exits.

Error exits, drawn in red under the node that can raise them:

- `max retries exceeded` from Fix
- `tests still failing` from Verify

**Step** runs the active node and moves the highlight. **One miss** fails Verify once, then passes, so Fix is visited twice. **Burn retries** keeps failing until Fix has been entered 5 times, then the max-retries exit fires and the run lands on Gave up. **Reset** clears the run. **Reload** reads `data/machines/fix-failing-test.json` and redraws.

The same behavior is covered by `npm test` in this repo (Node 22 or newer).

## Define a machine

Edit `src/example.ts`, or edit the JSON file and press Reload. A machine is:

```ts
type NodeKind = "computer" | "agent";

interface MachineNode {
  id: string;
  kind: NodeKind;
  label: string;
  promptOrDescription: string;
  source?: { file: string; line: number };
  requires?: string[];
  produces?: string[];
}

interface Transition {
  from: string;
  to: string;
  label?: string;
  isLoop?: boolean;
  isError?: boolean;
}

interface Machine {
  id: string;
  nodes: MachineNode[];
  transitions: Transition[];
  errorExits?: { id: string; label: string; from: string }[];
}
```

Give every node a `source` of `{ file, line }` pointing at the line that declares its `id`. The panel prints that reference when the node is selected.

Forward edges are the normal path. `isLoop: true` on an edge from a node back to itself is a retry; a label like `retries < 5` is the visit budget. `isError: true` is a failure return. `errorExits` are the terminal conditions drawn on the graph.

After editing TypeScript, regenerate the JavaScript Herdr loads:

```sh
npm install typescript   # once, if you do not already have it
npm run emit
```

Then save, or copy `mods/flow` over the installed copy again. Herdr reloads on save. Adding a node and a transition changes the drawing on that reload. Adding them to the JSON and pressing Reload does the same without a rebuild.

`step(machine, run, { structural: true })` walks only forward edges and does not simulate failures. Omit `structural` and pass `simulate` to run the example's pass/fail behavior. `exportSnapshot` returns the machine plus the active node, completed nodes, and visit counts.

## Generate a focused prompt

Select a node. **Generate focused prompt** builds a markdown prompt with:

- a header naming that node and its source line
- the node's own prompt
- a "Context from prior steps" section — outputs from nodes that already ran, and the descriptions of ancestors that have not
- a warning when something in `requires` is not in the run context yet

Selecting Fix before anything has run still names Search and Diagnose, and says they have not run.

The prompt is copied to the system clipboard (`cx.write_to_clipboard`, then `wl-copy`, `pbcopy`, or `xclip` if one of those exists) and written to `~/.config/herdr-app/data/focused-prompt.md`.

## Layout of this repo

```
mods/flow/mod.json     panel registration
mods/flow/main.js      GPUI panel
mods/flow/lib/*.js     runner Herdr imports
src/*.ts               machine, runner, prompt, layout, example
test/flow.test.ts      acceptance checks for the core
RECIPE.md              brief another agent can rebuild the mod from
```

The panel reaches the clipboard and writes only under `~/.config/herdr-app/data/`. It also runs `mkdir -p` for that data directory. It does not use the network.
