import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vim, { type ModalEditor } from "../index.js";
import {
  readPiVimScrollKeys,
  resolveScrollKeys,
  setPiVimSettingsReaderForTests,
} from "../settings.js";
import {
  createExtensionApiHarness,
  sendKeys,
  setInternalCursor,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

const warning = "Invalid piVim.scrollKeys; expected a boolean.";
describe("scrollKeys setting (host-only configuration)", () => {
  it("defaults off, accepts only booleans, and never echoes invalid input", () => {
    assert.deepEqual(resolveScrollKeys(undefined), { enabled: false });
    for (const enabled of [true, false])
      assert.deepEqual(resolveScrollKeys(enabled), { enabled });
    for (const value of [null, 0, "true", {}, [], "\x1b[31m"]) {
      assert.deepEqual(resolveScrollKeys(value), { enabled: false, warning });
      assert.equal(
        readPiVimScrollKeys(
          { piVim: { scrollKeys: true } },
          { piVim: { scrollKeys: value } },
        ),
        value,
      );
    }
    assert.equal(readPiVimScrollKeys({}, {}), undefined);
    for (const enabled of [true, false]) {
      assert.equal(
        readPiVimScrollKeys({ piVim: { scrollKeys: enabled } }, {}),
        enabled,
      );
      assert.equal(
        readPiVimScrollKeys(
          { piVim: { scrollKeys: !enabled } },
          { piVim: { scrollKeys: enabled } },
        ),
        enabled,
      );
    }
  });

  for (const hasUI of [true, false]) {
    it(`installation/reload rereads settings and resets remembered rows, UI=${hasUI}`, async () => {
      let value: unknown = true;
      const restore = setPiVimSettingsReaderForTests(() => ({
        scrollKeys: value,
      }));
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
        for (value of [true, false, true, undefined, "true"]) {
          await pi.emit("session_start", {}, ctx);
          assert.ok(factory);
          const editor = factory(stubTui, stubTheme, stubKeybindings);
          editor.setText(Array(30).fill("abcdefgh").join("\n"));
          editor.handleInput("\x1b");
          setInternalCursor(editor, 2);
          editor.render(21); // Twelve visible rows.
          editor.handleInput("\x04");
          assert.deepEqual(editor.getCursor(), {
            line: value === true ? 6 : 0,
            col: 2,
          });
          if (value === true) sendKeys(editor, ["1", "\x04"]);
          await pi.emit("session_shutdown");
        }
        assert.deepEqual(warnings, hasUI ? [warning] : []);
      } finally {
        restore();
      }
    });
  }
});
