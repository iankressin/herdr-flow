# Flow

A right-hand Herdr panel that runs an agent workflow as a state machine. You type a test command, click Start, then Run. Flow runs the command, starts Claude agents in new tabs of your space to search, diagnose and fix, runs the test again, and has a judge agent review the diff. The panel draws every step as a card on a vertical spine, shows the live state of the running step, and keeps every prompt, output and result on disk.

![Flow](preview.png)

## What you see

The panel docks on the right, 420px wide (`mod.json`: `"place": "right"`, `"size": 420`, `"focusable": true`). It uses theme colors: `canvas` behind the graph, `chrome` for the header, `surface` for cards and the detail block.

Top to bottom:

1. The header on `chrome`, with a bottom border in `border`. A small "FLOW" label in `dim` sits left and a **Reload** button sits right. Below them, the machine title is 16px semibold. With several machines and no current run, the title also shows "2/3" and a click moves to the next machine. One status line in `muted` reads `<space name> · <status>`. The status is `ready`, `running <step>`, `needs you` (in `blocked`), `finished: success|failure (<note>)`, or `failed: <error>` (in red). Machine files that fail to parse are listed under it in red, one line each.
2. With no current run, a start form. Each machine input gets an 11px `dim` label over a 30px input with an `input` border, filled with the input's default. A solid button reads "Start in <focused space name>". When the focused space is on another machine, a red line under the button says Flow runs agents on this computer only.
3. With a run, a row of 28px buttons that wraps:
   - idle: **Step** (solid), **Run**, **New run**.
   - executing: **Pause** (only on auto), **Open agent** (solid when the agent needs you), **Mark pass**, **Mark fail**.
   - failed: **Retry** (solid), **Mark pass**, **Mark fail**, **New run**.
   - finished: **New run** (solid).
4. A scrolling canvas. A 2px spine in `border` runs at x=26 from the first card's center to the last card's center. Each node is a 248x84 card at x=48, radius 8, padding 8. A card has a 10px badge (AGENT in `accent`, COMPUTER or END in `dim`), a 14px semibold label, and an 11px status line. Agent cards have an `accent` border, and the other cards have a `border` border. The selected card has a 2px `foreground` border. The current step's card fills with `selected`. A reached end card fills with `done` (success) or `#c4544a` (failure) at low alpha.
5. Under each card, its pills, 26px tall, 248px wide, radius 6. The retry budget pill has an `accent` border and reads "retries < 5", with "· N used" after the first visit. Each fail edge gets a red (`#c4544a`) pill with its label or "on fail → <target>". A node with a budget also gets a red "max retries → <end>" pill. A pill the run took fills solid red with white text.
6. The detail block on `surface`, with a top border. It shows the selected node's label and kind, its `source` as `file:line` in `dim`, its command, prompt or description (scrolls past 96px), `requires … · produces …`, and the latest attempt as "Attempt N: pass|fail, by agent|computer|person" over its summary (scrolls past 18 lines). A bad result file shows its error in red. Agent nodes get a solid **Copy focused prompt**. **Open agent** appears when the node has an agent terminal. A one-line note shows the last message.

Card order follows `pass` edges from `start`, then the other working nodes, then the end nodes.

## How it behaves

- **Start** needs every input filled. It creates a run in the focused space, in the focused terminal's folder (else the space's folder, else home), copies the machine into the run, and makes it current. The run starts idle. When that folder contains Flow's data folder (both resolved with `realpath`), Start refuses with a red line on the start form: "Flow can't run in <folder>: agents working there could edit Flow's own files. Start it from a project folder." The same check runs before every step, so a resumed run in such a folder fails instead of running.
- **Step** runs the next node and stops. **Run** turns auto on and keeps going until the run finishes or fails. **Pause** turns auto off. The running step still finishes.
- A computer node runs `/usr/bin/env FLOW_<KEY>=<value>… /bin/sh -c "exec 2>&1\n<command>"` in the run's folder, with its `timeoutSec` (default and maximum 600). Exit 0 passes. Anything else, a timeout, or a failed start fails. The output tail becomes the value of each `produces` key. The card status line spins `running #N` with braille frames at 90ms.
- An agent node starts an agent in a new tab named "<label> #<visit>". The agent may write only its visit folder, `runs/<runId>/visits/<node>-<visit>/`. The card shows the agent's live status from `agents()`: working (spinner, `working`), needs you (`blocked` color, when the agent asks a question), stopped without a result (red, idle with no valid result), and closed (red, the terminal is gone). The step completes when the agent writes a valid result file. A bad file keeps the step running and shows the error on the card and in the detail block.
- A step that passes or fails follows its edge. Entering an end node finishes the run at once. Entering a node that has used up its `maxVisits` finishes the run at `onExhausted` with the note "max retries exceeded at <label>". A missing edge, a launch error, or an unfilled input fails the run with the reason.
- **Mark pass** and **Mark fail** record an attempt by "person" and follow the edge, for a running step or a failed one. **Retry** runs a failed step again. **New run** clears the current run and shows the start form.
- Status lines on cards: waiting, next, running, the agent states above, `passed ×N · failed ×N`, and on end nodes their description or the run's note.
- Clicking a card selects it. The selection follows the current step until you click a different card.
- **Copy focused prompt** builds the prompt the selected agent step would get now, copies it with `cx.write_to_clipboard` (or `pbcopy` when that throws), and writes it to `data/flow/focused-prompt.md`.
- **Reload** rereads the machines folder and reloads the current run from disk, taking it back if another panel had it.
- On load, the panel resumes the current run. It watches a live agent, adopts a live terminal that carries this visit's `flow.run` and `flow.node` labels, or starts the agent again. A running command runs again. An idle run on auto continues.

## Built from

- `mods/flow/main.js`, a `View` from `gpui-kit`, with `v_flex`, `h_flex`, `Input` and `InputState` from `gpui-base` and `readdir` from `fs/promises`. Cards and pills are absolutely placed from `layoutGraph`.
- `mods/flow/lib/*.js`, emitted from `src/` by `npm run emit` (TypeScript 5's `transpileModule`):
  - `machine.ts`: the types, `parseMachine` (the boundary for machine JSON), `fillTemplate`, `envName`.
  - `engine.ts`: a pure reducer over `Run`. `createRun`, `begin` (returns an effect: `command`, `agent`, or `none`), `pendingEffect`, `attachAgent`, `complete`, `fail`, `retry`, `setAuto`, `commandResult`.
  - `prompt.ts`: `buildAgentPrompt`. `result.ts`: `parseAgentResult`. `runfile.ts`: `parseRun`, the boundary for `run.json`. `layout.ts`: `layoutGraph`, `displayOrder`.
  - `example.ts`: the fix-failing-test machine. Each node's `source.line` is the line that sets its `id`.
- `herdr` functions: `appHome`, `exec`, `hc`, `readTextFile`, `writeTextFile`, `watchFolder`, `spaces`, `focused`, `agents`, `terminals`, `theme`, `home`, `run` (`tab.rename`, `agent.focus`, `tab.select`).
- Programs: `mkdir -p`, `/usr/bin/env` with `/bin/sh -c` for computer steps, `hc run` and `hc ls --json --label` for agents, `pbcopy` as the clipboard fallback.
- The agent launch, with the prompt last and no `--` before the agent argv:

  ```
  hc run --bg --json --keep --no-parent --cwd <folder> --name flow-<16 hex>
    --label herdr.space=<space id> --label herdr.tab=tb<32 hex>
    --label flow.run=<run id> --label flow.node=<node>-<visit>
    claude --add-dir=<visit dir> <prompt>
  ```

- Files under `~/.config/herdr-app/data/flow/`: `machines/*.json`, `state.json` (`{"current": runId}`), and `runs/<runId>/` with `run.json`, `<node>-<visit>.output.txt`, and `visits/<node>-<visit>/` holding `prompt.md` and `result.json`. Plus `focused-prompt.md`.

## Watch out

- `herdr-app check` renders the first view and runs the body of a `cx.spawn`, but never fires timers. The panel starts its I/O from `cx.timer.after(0, …)` so the check writes nothing.
- Claude's `--add-dir` takes several values. `--add-dir <dir> "<prompt>"` swallows the prompt and the agent sits empty. Use `--add-dir=<dir>` and put the prompt last.
- The prompt is the agent's first message, so it starts with a sentence. A leading `#`, `/` or `!` means something else to an agent's input box.
- `hc wait` can return on the agent's startup idle. Completion is the result file appearing, never the agent going idle.
- Herdr may learn of the new tab a moment after `hc run` returns. The rename waits up to 5 seconds for the tab to appear in `spaces()`.
- A watch event can arrive between reading the result file and starting the next `watchFolder`. The panel also rereads the file every 5 seconds while an agent works.
- Agents read untrusted code, so their values never become shell text. Computer `run` templates take only inputs, `produces` may not name an input, and step values reach commands as `FLOW_<KEY>` variables through `env`'s argv.
- An agent may write only its visit folder (`--add-dir=<visit dir>`; machines use `{visitDir}`, and `{runDir}` is refused). `run.json` holds the machine copy with its commands, so an agent that could write it could choose what the panel runs next. The panel derives visit paths from the run id, node and visit, and loads `run.json` only through `parseRun`, which checks the machine with `parseMachine`. A run that fails shows its error and is never driven.
- An agent's default write scope is its working folder. A space at the home folder would cover `data/flow`, so `isInside(realFlowDir, realFolder)` refuses it. Compare whole path segments: `/Users/x/.config/herdr-app-other` does not contain `/Users/x/.config/herdr-app`.
- `run.json` is compare-and-swap against the text this panel last wrote. Two panels that read different versions can both claim a run, so the agent's fixed `--name` is what stops a second launch: herdr-core refuses a second live terminal with the same name, and the loser adopts the winner's terminal by its labels.
- Changes to the run go through one queue per panel, each applied to the latest run. Two changes computed from the same run would make the panel refuse its own second write.
- Flow refuses spaces on other machines. `exec`, `watchFolder` and the labels it writes assume this computer.
- `preview.png` shows the earlier demo build. Retake it from a live run.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/flow` exits 0 and writes nothing under `data/flow`.
- `npm run check` passes: `tsc`, emit, and the tests in `test/flow.test.ts`.
- On first load, `data/flow/machines/fix-failing-test.json` exists. Edit it, click **Reload**, and the edit shows. Load again, and Flow keeps your edit.
- Start the example with a test command that fails. Claim fails, Search opens a new tab named "Search #1" with Claude working in it, and the card spins "working #1".
- Each agent writes `result.json` in its visit folder and its step completes without a click.
- When Verify fails, the run goes back to Fix, `visits/fix-2/prompt.md` contains the diagnosis and Verify's failing output, and the "tests still failing" pill turns solid red.
- A run that passes Judge ends with "finished: success" and the Done card tinted.
- Close and reopen the panel while an agent works. The run resumes on the same terminal, and no second agent starts.
- A test command that already passes ends the run at Already passing after one step.
- Start from a terminal in your home folder: the start form says Flow can't run there, and no run starts.
