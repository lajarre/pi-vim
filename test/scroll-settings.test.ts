import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vim, { type ModalEditor } from "../index.js";
import { setPiVimSettingsReaderForTests } from "../settings.js";
import {
  createExtensionApiHarness,
  sendKeys,
  setInternalCursor,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

// Host installation policy, not a configurable motion: every fresh editor
// starts with scrolling and the default half-page distance.
describe("scroll installation and reload", () => {
  for (const hasUI of [true, false]) {
    it(`installation/reload resets remembered rows without configuration, UI=${hasUI}`, async () => {
      const restore = setPiVimSettingsReaderForTests(() => ({}));
      const pi = createExtensionApiHarness();
      type Factory = (
        ...args: ConstructorParameters<typeof ModalEditor>
      ) => ModalEditor;
      let factory: Factory | undefined;
      const warnings: string[] = [];
      const ctx = {
        cwd: ".",
        hasUI,
        ui: {
          theme: stubTheme,
          notify: (s: string) => warnings.push(s),
          setEditorComponent: (next: Factory) => {
            factory = next;
          },
        },
      };
      try {
        vim(pi);
        for (let installation = 0; installation < 2; installation++) {
          await pi.emit("session_start", {}, ctx);
          assert.ok(factory);
          const editor = factory(stubTui, stubTheme, stubKeybindings);
          const text = Array(30).fill("abcdefgh").join("\n");
          editor.setText(text);
          editor.handleInput("\x1b");
          setInternalCursor(editor, 2);
          editor.render(21); // Twelve visible rows.
          editor.handleInput("\x04");
          assert.deepEqual(editor.getCursor(), { line: 6, col: 2 });
          sendKeys(editor, ["1", "\x04", "\x04"]);
          assert.deepEqual(editor.getCursor(), { line: 8, col: 2 });
          assert.equal(editor.getText(), text);
          assert.equal(editor.getMode(), "normal");
          await pi.emit("session_shutdown");
        }
        assert.deepEqual(warnings, []);
      } finally {
        restore();
      }
    });
  }
});
