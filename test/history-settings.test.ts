// History navigation is an intentional non-Vim host setting.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vim, { type ModalEditor } from "../index.js";
import {
  readPiVimHistoryNavigation,
  resolveHistoryNavigation,
  setPiVimSettingsReaderForTests,
} from "../settings.js";
import {
  createExtensionApiHarness,
  sendKeys,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

const warning = "Invalid piVim.historyNavigation; expected a boolean.";

describe("history setting validation and notifications", () => {
  it("defaults silently, accepts booleans, and warns without echoing invalid input", () => {
    assert.deepEqual(resolveHistoryNavigation(undefined), { enabled: true });
    for (const enabled of [true, false])
      assert.deepEqual(resolveHistoryNavigation(enabled), { enabled });
    for (const value of ["false", 0, null, {}, [], "\x1b[31m"])
      assert.deepEqual(resolveHistoryNavigation(value), {
        enabled: true,
        warning,
      });
  });

  for (const value of ["false", 0, null, true, false, undefined]) {
    for (const hasUI of [true, false]) {
      it(`resolves ${JSON.stringify(value)} once per session, hasUI=${hasUI}`, async () => {
        const restore = setPiVimSettingsReaderForTests(() => ({
          historyNavigation: readPiVimHistoryNavigation(
            { piVim: { historyNavigation: false } },
            { piVim: { historyNavigation: value } },
          ),
        }));
        const pi = createExtensionApiHarness();
        const warnings: [string, string][] = [];
        type Factory = (
          ...args: ConstructorParameters<typeof ModalEditor>
        ) => ModalEditor;
        let factory: Factory | undefined;
        try {
          vim(pi);
          await pi.emit(
            "session_start",
            {},
            {
              cwd: ".",
              hasUI,
              ui: {
                theme: stubTheme,
                notify: (text: string, level: string) =>
                  warnings.push([text, level]),
                setEditorComponent: (next: Factory) => {
                  factory = next;
                },
              },
            },
          );
          assert.ok(factory);
          for (let i = 0; i < 2; i++) {
            const editor: ModalEditor = factory(
              stubTui,
              stubTheme,
              stubKeybindings,
            );
            editor.addToHistory("older");
            sendKeys(editor, ["\x1b", "k"]);
            assert.equal(editor.getText(), value === false ? "" : "older");
            assert.equal(editor.getMode(), "normal");
            editor.render(40);
          }
          const invalid = value !== undefined && typeof value !== "boolean";
          assert.deepEqual(
            warnings,
            hasUI && invalid ? [[warning, "warning"]] : [],
          );
        } finally {
          await pi.emit("session_shutdown");
          restore();
        }
      });
    }
  }
});
