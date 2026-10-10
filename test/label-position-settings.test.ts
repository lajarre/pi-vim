/** Label placement is an intentional non-Vim presentation setting. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import installPiVim, { type ModalEditor } from "../index.js";
import {
  readPiVimLabelPositionSetting,
  resolveLabelPosition,
  setPiVimSettingsReaderForTests,
} from "../settings.js";
import {
  createExtensionApiHarness,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

const warning =
  "Invalid piVim.labelPosition; expected bottom-right or top-left.";

describe("piVim.labelPosition settings", () => {
  it("defaults silently and accepts only the two documented values", () => {
    assert.deepEqual(resolveLabelPosition(undefined), {
      position: "bottom-right",
    });
    for (const position of ["bottom-right", "top-left"]) {
      assert.deepEqual(resolveLabelPosition(position), { position });
    }
  });

  it("rejects malformed values without coercion", () => {
    for (const value of [
      null,
      false,
      1,
      {},
      [],
      ["top-left"],
      "",
      "TOP-LEFT",
      " top-left ",
      "top-right",
      "bottom-left",
      "\x1b[31m",
    ]) {
      assert.deepEqual(resolveLabelPosition(value), {
        position: "bottom-right",
        warning,
      });
    }
  });

  it("uses global only when the project setting is absent", () => {
    const global = { piVim: { labelPosition: "top-left" } };
    for (const project of [undefined, {}, { piVim: {} }]) {
      assert.equal(readPiVimLabelPositionSetting(global, project), "top-left");
    }
    assert.equal(readPiVimLabelPositionSetting({}, {}), undefined);
    assert.equal(
      readPiVimLabelPositionSetting(global, {
        piVim: { labelPosition: "bottom-right" },
      }),
      "bottom-right",
    );
    assert.equal(
      readPiVimLabelPositionSetting(
        { piVim: { labelPosition: "invalid" } },
        { piVim: { labelPosition: "top-left" } },
      ),
      "top-left",
    );
  });

  it("lets invalid project values override global and fall back to default", () => {
    const global = { piVim: { labelPosition: "top-left" } };
    const projects = [
      ...[null, false, {}, [], "invalid"].map((labelPosition) => ({
        piVim: { labelPosition },
      })),
      ...[null, false, [], "invalid"].map((piVim) => ({ piVim })),
    ];
    for (const project of projects) {
      const resolved = resolveLabelPosition(
        readPiVimLabelPositionSetting(global, project),
      );
      assert.deepEqual(resolved, { position: "bottom-right", warning });
    }
  });

  for (const hasUI of [true, false]) {
    for (const value of ["top-left", "invalid"]) {
      it(`wires ${value} once per session, hasUI=${hasUI}`, async () => {
        const restore = setPiVimSettingsReaderForTests(() => ({
          labelPosition: value,
        }));
        const pi = createExtensionApiHarness();
        const notifications: [string, string][] = [];
        type Factory = (
          tui: typeof stubTui,
          theme: typeof stubTheme,
          kb: typeof stubKeybindings,
        ) => ModalEditor;
        let factory: Factory | undefined;
        try {
          installPiVim(pi);
          await pi.emit("session_start", undefined, {
            cwd: process.cwd(),
            hasUI,
            ui: {
              theme: stubTheme,
              notify: (text: string, level: string) =>
                notifications.push([text, level]),
              setEditorComponent: (next: Factory) => {
                factory = next;
              },
            },
          });
          assert.ok(factory);
          // Host reconstruction and repeated frames must not repeat warnings.
          for (let i = 0; i < 3; i++) {
            const editor = factory(stubTui, stubTheme, stubKeybindings);
            for (const width of [24, 12, 24]) {
              const lines = editor.render(width).map(stripVTControlCharacters);
              const row = value === "top-left" ? 0 : lines.length - 1;
              assert.ok(lines[row]?.includes(" INSERT "));
              assert.equal(
                lines[value === "top-left" ? lines.length - 1 : 0],
                "─".repeat(width),
              );
            }
          }
          assert.deepEqual(
            notifications,
            hasUI && value === "invalid" ? [[warning, "warning"]] : [],
          );
        } finally {
          await pi.emit("session_shutdown");
          restore();
        }
      });
    }
  }
});
