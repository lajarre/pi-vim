import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { APP_KEYS, assertNoPending, fixture } from "./control-key-fixtures.js";
import { sendKeys } from "./harness.js";

const keys = [
  { raw: "\x04", kitty: "\x1b[100;5u", name: "d", direction: 1 },
  { raw: "\x15", kitty: "\x1b[117;5u", name: "u", direction: -1 },
  { raw: "\x06", kitty: "\x1b[102;5u", name: "f", direction: 1 },
  { raw: "\x02", kitty: "\x1b[98;5u", name: "b", direction: -1 },
] as const;
const contexts = [
  [],
  ["v"],
  ["V"],
  ["3"],
  ["v", "3"],
  ["V", "3"],
  ["d"],
  ["c"],
  ["y"],
  ["3", "d", "2"],
  ["g"],
  ["g", "3"],
  ["Z"],
  ["r"],
  ["f"],
  ["F"],
  ["t"],
  ["T"],
  ["d", "i"],
  ["d", "a"],
  ["d", "f"],
  ["v", "f"],
  ["V", "t"],
];

// App/extension ownership and Insert readline behavior are intentional Pi policy,
// not nvim semantics. Motion parity lives in nvim-parity-scroll.ts.
describe("scroll-key ownership matrix (host-only policy)", () => {
  for (const key of keys) {
    for (const encoding of ["raw", "kitty"] as const) {
      for (const setup of contexts) {
        it(`Ctrl-${key.name} ${encoding} / ${setup.join("") || "Normal"}`, () => {
          const f = fixture(setup);
          f.editor.render(21); // Five actual text rows, not terminal's 12-row cap.
          const before = f.snapshot();
          f.editor.handleInput(key[encoding]);
          const motionContext = setup.every((s) => ["v", "V", "3"].includes(s));
          assert.deepEqual(f.snapshot(), {
            ...before,
            cursor: motionContext
              ? { line: key.direction > 0 ? 4 : 0, col: 2 }
              : before.cursor,
          });
          // The fixture tracks app-key probes too: Ctrl-D is offered to
          // extensions in Normal, but never runs app.exit.
          assert.deepEqual(
            f.forwarded,
            key.name === "d" && f.editor.getMode() === "normal"
              ? [key[encoding]]
              : [],
          );
          assertNoPending(f.state);
          assert.deepEqual(f.fired, []);
        });
      }
      it(`${encoding} Ctrl-${key.name} keeps Insert's stock dispatch`, () => {
        const f = fixture(["i"]);
        const stock = fixture(["i"]);
        f.editor.handleInput(key[encoding]);
        CustomEditor.prototype.handleInput.call(stock.editor, key[encoding]);
        assert.deepEqual(f.snapshot(), stock.snapshot());
        assert.deepEqual(f.fired, stock.fired);
        assert.deepEqual(f.forwarded, stock.forwarded);
      });
      it(`${encoding} Ctrl-${key.name} leaves nonempty EX unchanged`, () => {
        const f = fixture([":", "q"]);
        const before = f.snapshot();
        f.editor.handleInput(key[encoding]);
        assert.deepEqual(f.snapshot(), before);
        assert.deepEqual(f.fired, []);
        assertNoPending(f.state);
      });
      it(`${encoding} Ctrl-${key.name} never executes paste payload`, () => {
        const f = fixture([]);
        const before = f.snapshot();
        sendKeys(f.editor, ["\x1b[200~", key[encoding], "\x1b[201~"]);
        assert.deepEqual(f.snapshot(), before);
        assert.deepEqual(f.forwarded, []);
      });
      it(`${encoding} Ctrl-${key.name} preserves app precedence over scroll and aliases`, () => {
        for (const setup of contexts) {
          const f = fixture(setup, {
            "app.model.cycleForward": `ctrl+${key.name}`,
          });
          const before = f.snapshot();
          f.editor.handleInput(key[encoding]);
          assert.deepEqual(f.fired, ["app.model.cycleForward"]);
          assert.deepEqual(f.snapshot(), before);
          assertNoPending(f.state);
        }
      });
    }
  }

  for (const encoding of ["raw", "kitty"] as const) {
    for (const dynamic of [false, true]) {
      for (const setup of [...contexts, [":", "q"], ["i"]]) {
        it(`empty Ctrl-D ${encoding} / ${setup.join("") || "Normal"} / dynamic=${dynamic}`, () => {
          const f = fixture([]);
          f.editor.setText("");
          sendKeys(f.editor, setup);
          if (dynamic) f.editor.onCtrlD = () => f.fired.push("onCtrlD");
          const before = f.snapshot();
          assert.equal(f.kb.matches(keys[0][encoding], "app.exit"), true);
          f.editor.handleInput(keys[0][encoding]);
          const hostExit = setup[0] === "i" || setup[0] === ":";
          assert.deepEqual(
            f.fired,
            hostExit ? [dynamic ? "onCtrlD" : "app.exit"] : [],
          );
          assert.deepEqual(f.snapshot(), before);
          assertNoPending(f.state);
        });
      }
    }
  }

  it("excluded Ctrl-E/Y retain editor consumption and registered app ownership", () => {
    for (const [name, raw] of [
      ["e", "\x05"],
      ["y", "\x19"],
    ]) {
      for (const setup of contexts) {
        const f = fixture(setup);
        const before = f.snapshot();
        f.editor.handleInput(raw);
        assert.deepEqual(f.snapshot(), before);
        assert.deepEqual(f.fired, []);
        assert.deepEqual(f.forwarded, []);
        assertNoPending(f.state);
        const app = fixture(setup, {
          "app.model.cycleForward": `ctrl+${name}`,
        });
        const appBefore = app.snapshot();
        app.editor.handleInput(raw);
        assert.deepEqual(app.snapshot(), appBefore);
        assert.deepEqual(app.fired, ["app.model.cycleForward"]);
        assertNoPending(app.state);
      }
    }
  });

  it("scrolling keeps other default application chords", () => {
    for (const setup of contexts) {
      for (const key of APP_KEYS) {
        const f = fixture(setup);
        const before = f.snapshot();
        f.editor.handleInput(key.raw);
        assert.deepEqual(f.fired, [key.action]);
        assert.deepEqual(f.snapshot(), before);
        assertNoPending(f.state);
      }
    }
  });
});
