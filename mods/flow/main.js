// Flow — visual state machine for one agent workflow.
// Docks on the right. Select a node, step the run, copy a prompt that only
// includes work that already happened.

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import {
  appHome,
  checking,
  exec,
  readTextFile,
  theme,
  writeTextFile,
} from "herdr";
import { fixFailingTest, simulateFixFailingTest } from "./lib/example.js";
import { layoutGraph } from "./lib/layout.js";
import { buildFocusedPrompt } from "./lib/prompt.js";
import { createRun, exportSnapshot, parseMachine, step } from "./lib/runner.js";

const ERROR = "#c4544a";

function asText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
  }
  return "";
}

async function writeAtomic(file, text) {
  let expected = "";
  try {
    expected = asText(await readTextFile(file));
  } catch {
    expected = "";
  }
  try {
    await writeTextFile(file, text, expected);
  } catch {
    await writeTextFile(file, text, null);
  }
}

function dataRoot() {
  return appHome() + "/data";
}

async function ensureDataDir() {
  await exec("mkdir", ["-p", dataRoot() + "/machines"], { timeout: 5000 });
}

function copyClipboard(text, cx) {
  if (cx && typeof cx.write_to_clipboard === "function") {
    cx.write_to_clipboard(text);
  }
}

async function copyViaFile(file) {
  const quoted = "'" + file.replace(/'/g, "'\\''") + "'";
  const script = `f=${quoted}; if command -v wl-copy >/dev/null 2>&1; then wl-copy < "$f"; elif command -v pbcopy >/dev/null 2>&1; then pbcopy < "$f"; elif command -v xclip >/dev/null 2>&1; then xclip -selection clipboard < "$f"; fi`;
  try {
    await exec("sh", ["-c", script], { timeout: 4000 });
  } catch {
    /* a missing clipboard tool still leaves the markdown file */
  }
}

function action(id, label, primary, t, onClick) {
  return div()
    .id(id)
    .h(28)
    .px(10)
    .rounded(6)
    .flex()
    .items_center()
    .bg(primary ? t.solid : t.raised)
    .text_color(primary ? t.solid_foreground : t.foreground)
    .text_size(12)
    .font_medium()
    .on_click((_event, cx) => onClick(cx))
    .child(label);
}

function lines(id, text, color) {
  const parts = String(text || "").split("\n").slice(0, 18);
  return v_flex()
    .id(id)
    .gap(1)
    .children(parts.map((line, index) =>
      div().id(`${id}-${index}`).text_size(12).text_color(color).child(line.length ? line : " "),
    ));
}

export default class FlowPanel extends View {
  init(_props, cx) {
    this.machine = fixFailingTest();
    this.run = createRun(this.machine);
    this.selected = "fix";
    this.prompt = "";
    this.banner = "";
    this.failuresBeforePass = 1;
    if (checking()) return;
    cx.spawn(async (cx) => {
      try {
        await ensureDataDir();
        await this.persist();
      } catch (error) {
        this.banner = String(error && error.message ? error.message : error);
      }
      cx.notify();
    });
  }

  options() {
    return { failuresBeforePass: this.failuresBeforePass, simulate: simulateFixFailingTest };
  }

  async persist() {
    if (checking()) return;
    const root = dataRoot();
    await writeAtomic(root + "/machines/fix-failing-test.json", JSON.stringify(this.machine, null, 2) + "\n");
    await writeAtomic(root + "/flow-run.json", JSON.stringify(exportSnapshot(this.machine, this.run), null, 2) + "\n");
  }

  async generate(cx) {
    const built = buildFocusedPrompt(this.machine, this.run, this.selected);
    this.prompt = built.markdown;
    if (checking()) {
      this.banner = "Prompt built.";
      return;
    }
    const file = dataRoot() + "/focused-prompt.md";
    await ensureDataDir();
    await writeAtomic(file, built.markdown);
    copyClipboard(built.markdown, cx);
    await copyViaFile(file);
    this.banner = built.missing.length
      ? `Copied. Missing: ${built.missing.join(", ")}. Wrote ${file}`
      : `Copied and wrote ${file}`;
  }

  render() {
    const t = theme();
    const layout = layoutGraph(this.machine);
    const selected = this.machine.nodes.find((node) => node.id === this.selected) ?? this.machine.nodes[0];
    const visits = this.run.visits.fix ?? 0;
    const canvas = [];

    if (layout.spine) {
      canvas.push(
        div()
          .id("spine")
          .absolute()
          .left(layout.spine.x)
          .top(layout.spine.y1)
          .w(2)
          .h(Math.max(2, layout.spine.y2 - layout.spine.y1))
          .bg(t.border),
      );
    }

    for (const box of layout.nodes) {
      const node = this.machine.nodes.find((item) => item.id === box.id);
      if (!node) continue;
      const agent = node.kind === "agent";
      const isSelected = node.id === this.selected;
      const active = node.id === this.run.activeId;
      const ran = this.run.completed.includes(node.id);
      canvas.push(
        div()
          .id(`node-${node.id}`)
          .absolute()
          .left(box.x)
          .top(box.y)
          .w(box.w)
          .h(box.h)
          .rounded(8)
          .border(isSelected ? 2 : 1)
          .border_color(isSelected ? t.foreground : agent ? t.accent : t.border)
          .bg(active ? t.selected : t.surface)
          .p(8)
          .on_click((_event, cx) => {
            this.selected = node.id;
            cx.notify();
          })
          .child(
            v_flex()
              .gap(2)
              .child(
                div()
                  .text_size(10)
                  .font_medium()
                  .text_color(agent ? t.accent : t.dim)
                  .child(agent ? "AGENT" : "COMPUTER"),
              )
              .child(div().text_size(14).font_semibold().text_color(t.foreground).child(node.label))
              .child(
                div()
                  .text_size(11)
                  .text_color(t.muted)
                  .child(active ? "now" : ran ? `ran ×${this.run.visits[node.id] ?? 1}` : "waiting"),
              ),
          ),
      );
    }

    for (const pill of layout.pills) {
      const taken = pill.exitId ? this.run.takenErrorExits.includes(pill.exitId) : false;
      const color = pill.kind === "error" ? ERROR : t.accent;
      canvas.push(
        div()
          .id(pill.id)
          .absolute()
          .left(pill.x)
          .top(pill.y)
          .w(pill.w)
          .h(pill.h)
          .rounded(6)
          .border(1)
          .border_color(color)
          .bg(taken ? ERROR : t.canvas)
          .px(8)
          .flex()
          .items_center()
          .child(
            div()
              .text_size(11)
              .font_medium()
              .text_color(taken ? t.solid_foreground : color)
              .child(pill.text),
          ),
      );
    }

    const source = selected?.source ? `${selected.source.file}:${selected.source.line}` : "no source";
    const requires = (selected?.requires ?? []).join(", ") || "none";
    const produces = (selected?.produces ?? []).join(", ") || "none";

    return v_flex()
      .id("flow-root")
      .size_full()
      .bg(t.canvas)
      .text_color(t.foreground)
      .child(
        v_flex()
          .px(12)
          .pt(12)
          .pb(8)
          .gap(4)
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(div().text_size(11).font_medium().text_color(t.dim).child("FLOW"))
          .child(div().text_size(16).font_semibold().child("Fix failing test"))
          .child(
            div()
              .text_size(12)
              .text_color(t.muted)
              .child(
                `${this.run.status} · now ${this.run.activeId ?? "—"} · fix visits ${visits}${this.run.note ? ` · ${this.run.note}` : ""}`,
              ),
          ),
      )
      .child(
        h_flex()
          .px(12)
          .py(8)
          .gap(6)
          .child(action("step-run", "Step", true, t, (cx) => {
            this.run = step(this.machine, this.run, this.options());
            cx.spawn(async (cx) => {
              try {
                await this.persist();
              } catch (error) {
                this.banner = String(error && error.message ? error.message : error);
              }
              cx.notify();
            });
            cx.notify();
          }))
          .child(action("reset-run", "Reset", false, t, (cx) => {
            this.run = createRun(this.machine);
            this.prompt = "";
            this.banner = "";
            cx.spawn(async (cx) => {
              try {
                await this.persist();
              } catch (error) {
                this.banner = String(error && error.message ? error.message : error);
              }
              cx.notify();
            });
            cx.notify();
          }))
          .child(action(
            "toggle-burn",
            this.failuresBeforePass > 1 ? "Burn retries" : "One miss",
            false,
            t,
            (cx) => {
              this.failuresBeforePass = this.failuresBeforePass > 1 ? 1 : 9;
              cx.notify();
            },
          ))
          .child(action("reload-machine", "Reload", false, t, (cx) => {
            cx.spawn(async (cx) => {
              try {
                const file = dataRoot() + "/machines/fix-failing-test.json";
                this.machine = parseMachine(JSON.parse(asText(await readTextFile(file))));
                if (!this.machine.nodes.some((node) => node.id === this.selected)) {
                  this.selected = this.machine.nodes[0]?.id ?? "fix";
                }
                this.run = createRun(this.machine);
                this.banner = "Reloaded machine from data/machines/fix-failing-test.json";
              } catch (error) {
                this.banner = String(error && error.message ? error.message : error);
              }
              cx.notify();
            });
          })),
      )
      .child(
        div()
          .id("flow-scroll")
          .flex_1()
          .overflow_y_scrollbar()
          .overflow_x_scrollbar()
          .child(
            div().relative().id("flow-canvas").w(layout.width).h(layout.height).children(canvas),
          ),
      )
      .child(
        v_flex()
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
              .child(div().text_size(14).font_semibold().child(selected ? selected.label : "No node"))
              .child(
                div()
                  .text_size(11)
                  .text_color(selected?.kind === "agent" ? t.accent : t.dim)
                  .child(selected ? selected.kind : ""),
              ),
          )
          .child(div().text_size(11).text_color(t.dim).child(source))
          .child(div().text_size(12).text_color(t.foreground).child(selected ? selected.promptOrDescription : ""))
          .child(div().text_size(11).text_color(t.muted).child(`requires ${requires} · produces ${produces}`))
          .child(action("generate-focused-prompt", "Generate focused prompt", true, t, (cx) => {
            cx.spawn(async (cx) => {
              try {
                await this.generate(cx);
              } catch (error) {
                this.banner = String(error && error.message ? error.message : error);
              }
              cx.notify();
            });
          }))
          .child(div().id("flow-banner").text_size(11).text_color(t.muted).child(this.banner || " "))
          .when(Boolean(this.prompt), (el) =>
            el.child(
              div()
                .id("focused-prompt-view")
                .max_h(160)
                .overflow_y_scrollbar()
                .child(lines("focused-prompt-line", this.prompt, t.foreground)),
            ),
          ),
      );
  }
}
