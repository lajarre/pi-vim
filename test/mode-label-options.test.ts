import assert from "node:assert/strict";
import { it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import installPiVim, { ModalEditor } from "../index.js";
import {
  readPiVimModeLabelPlacement,
  readPiVimModeLabelStyle,
  setPiVimSettingsReaderForTests,
} from "../settings.js";
import {
  createExtensionApiHarness,
  sendKeys,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

// Label wording/placement are intentional Pi UI differences, not nvim semantics.
for (const style of ["full", "compact"] as const) {
  it(`${style} labels preserve feedback, paint, width bounds and deduplication`, () => {
    const names =
      style === "compact"
        ? ["I", "N", "V", "VL", ":tree_"]
        : ["INSERT", "NORMAL", "VISUAL", "V-LINE", "EX :tree_"];
    for (const placement of ["editor", "status"] as const) {
      const labels: string[] = [];
      let color = "\x1b[31m";
      const paint = (s: string) => `${color}${s}\x1b[0m`;
      const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings, {
        modeLabelStyle: style,
        modeLabelPlacement: placement,
        onModeLabel: (s) => labels.push(s),
        labelColorizers: {
          insert: paint,
          normal: paint,
          visual: paint,
          ex: paint,
        },
      });
      editor.setText("hello");
      for (const [keys, name, mode] of [
        ["", names[0], "insert"],
        ["\x1b", names[1], "normal"],
        ["v", names[2], "visual"],
        ["\x1bV", names[3], "visual-line"],
        ["\x1b:tree", names[4], "normal"],
        ["\x1b2d3f", `${names[1]} 2d3f_`, "normal"],
      ] as const) {
        sendKeys(editor, [...keys]);
        const label = paint(` ${name} `);
        const count = labels.length;
        assert.equal(
          editor.render(80).some((row) => row.includes(label)),
          placement === "editor",
        );
        assert.equal(labels.length, count);
        assert.equal(labels.at(-1), placement === "status" ? label : undefined);
        assert.equal(editor.getMode(), mode);
        assert.equal(editor.getText(), "hello");
      }
      sendKeys(editor, ["\x1b", ":", "界👩‍💻e\u0301".repeat(20)]);
      for (const width of [1, 3, 4, 12, 32, 80]) {
        editor.render(width);
        if (placement !== "status") continue;
        const label = labels.at(-1) ?? "";
        assert.ok(visibleWidth(label) <= Math.min(width, 32));
        if (width >= 3) {
          assert.ok(label.startsWith(`${color} `));
          assert.ok(label.endsWith(" \x1b[0m"));
        }
      }
      color = "\x1b[32m";
      editor.render(80);
      if (placement === "status") assert.ok(labels.at(-1)?.startsWith(color));
      const submitted: string[] = [];
      editor.onSubmit = (text) => submitted.push(text);
      sendKeys(editor, [..."\x1b:tree\r"]);
      assert.deepEqual(submitted, ["/tree"]);
      assert.equal(editor.getText(), "hello");
      assert.equal(editor.getMode(), "normal");
    }
  });
}

it("publishes through the factory, cleans up and ignores stale editors", async () => {
  let placement: "status" | "editor" = "status";
  const restore = setPiVimSettingsReaderForTests(() => ({
    modeLabelPlacement: placement,
    modeLabelStyle: "compact",
  }));
  try {
    const pi = createExtensionApiHarness();
    const labels: Array<string | undefined> = [];
    let make = () => new ModalEditor(stubTui, stubTheme, stubKeybindings);
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        theme: stubTheme,
        notify() {},
        setEditorComponent(
          factory: (
            ...args: ConstructorParameters<typeof ModalEditor>
          ) => ModalEditor,
        ) {
          make = () => factory(stubTui, stubTheme, stubKeybindings);
        },
        setStatus(key: string, text: string | undefined) {
          assert.equal(key, "pi-vim-mode");
          labels.push(text);
        },
      },
    };
    installPiVim(pi);
    await pi.emit("session_start", undefined, ctx);
    const first = make();
    assert.deepEqual(labels, ["\x1b[7m I \x1b[27m"]);
    const second = make();
    let count = labels.length;
    first.handleInput("\x1b");
    first.render(4);
    assert.equal(labels.length, count);
    await pi.emit("session_start", undefined, ctx);
    assert.equal(labels.at(-1), undefined);
    count = labels.length;
    second.handleInput("\x1b");
    second.render(4);
    assert.equal(labels.length, count);
    const current = make();
    await pi.emit("session_shutdown", { reason: "reload" });
    assert.equal(labels.at(-1), undefined);
    count = labels.length;
    current.handleInput("\x1b");
    current.render(4);
    await pi.emit("session_shutdown", { reason: "reload" });
    placement = "editor";
    await pi.emit("session_start", undefined, ctx);
    assert.ok(make().render(80).at(-1)?.includes(" I "));
    await pi.emit("session_shutdown", { reason: "reload" });
    assert.equal(labels.length, count);
  } finally {
    restore();
  }
});

for (const [key, read, fallback, enabled] of [
  ["modeLabelStyle", readPiVimModeLabelStyle, "full", "compact"],
  ["modeLabelPlacement", readPiVimModeLabelPlacement, "editor", "status"],
] as const) {
  it(`${key} validates exact values, defaults and project precedence`, () => {
    const setting = (value: unknown) => ({ piVim: { [key]: value } });
    assert.equal(read({}, {}), fallback);
    assert.equal(read(setting(fallback), setting(enabled)), enabled);
    assert.equal(read(setting(enabled), setting(fallback)), fallback);
    for (const absent of [undefined, null, {}, { piVim: {} }])
      assert.equal(read(setting(enabled), absent), enabled);
    for (const value of [
      undefined,
      null,
      [],
      {},
      true,
      3,
      enabled.toUpperCase(),
      ` ${enabled} `,
    ]) {
      assert.equal(read(setting(value), {}), fallback);
      assert.equal(read(setting(enabled), setting(value)), fallback);
    }
    for (const piVim of [null, [], true, enabled]) {
      assert.equal(read({ piVim }, {}), fallback);
      assert.equal(read(setting(enabled), { piVim }), fallback);
    }
  });
}
