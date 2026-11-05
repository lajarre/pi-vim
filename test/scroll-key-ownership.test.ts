import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

describe("scroll-key ownership matrix (host-only policy)", () => {
  for (const enabled of [false, true]) {
    for (const key of keys) {
      for (const encoding of ["raw", "kitty"] as const) {
        for (const setup of contexts) {
          it(`${enabled} / Ctrl-${key.name} ${encoding} / ${setup.join("") || "Normal"}`, () => {
            const f = fixture(setup);
            f.editor.setScrollKeys(enabled);
            f.editor.render(21); // Five actual text rows, not terminal's 12-row cap.
            const before = f.snapshot();
            f.editor.handleInput(key[encoding]);
            const motionContext = setup.every((s) =>
              ["v", "V", "3"].includes(s),
            );
            if (enabled) {
              assert.deepEqual(f.snapshot(), {
                ...before,
                cursor: motionContext
                  ? { line: key.direction > 0 ? 4 : 0, col: 2 }
                  : before.cursor,
              });
              assert.deepEqual(f.forwarded, []);
              assertNoPending(f.state);
            } else {
              const expected = fixture(setup);
              expected.editor.render(21);
              // Disabled is exactly the pre-scroll dispatch: b/f alias h/l;
              // d is the guarded app.exit; u is an unsupported editor control.
              expected.editor.handleInput(
                key.name === "b"
                  ? "\x02"
                  : key.name === "f"
                    ? "\x06"
                    : key[encoding],
              );
              assert.deepEqual(f.snapshot(), expected.snapshot());
              assert.deepEqual(f.forwarded, expected.forwarded);
            }
            assert.deepEqual(f.fired, []);
          });
        }
        for (const setup of [["i"], [":", "q"]]) {
          it(`${enabled} / ${encoding} Ctrl-${key.name} leaves ${setup[0]} unchanged`, () => {
            const f = fixture(setup);
            const stock = fixture(setup);
            f.editor.setScrollKeys(enabled);
            f.editor.handleInput(key[encoding]);
            stock.editor.handleInput(key[encoding]);
            assert.deepEqual(f.snapshot(), stock.snapshot());
            assert.deepEqual(f.fired, stock.fired);
            assert.deepEqual(f.forwarded, stock.forwarded);
          });
        }
        it(`${enabled} / ${encoding} Ctrl-${key.name} never executes paste payload`, () => {
          const f = fixture([]);
          f.editor.setScrollKeys(enabled);
          const before = f.snapshot();
          sendKeys(f.editor, ["\x1b[200~", key[encoding], "\x1b[201~"]);
          assert.deepEqual(f.snapshot(), before);
          assert.deepEqual(f.forwarded, []);
        });
      }
    }
    for (const encoding of ["raw", "kitty"] as const) {
      for (const setup of [...contexts, [":", "q"], ["i"]]) {
        it(`${enabled} / empty Ctrl-D ${encoding} / ${setup.join("")}`, () => {
          const f = fixture(setup);
          f.editor.setScrollKeys(enabled);
          f.editor.setText("");
          assert.equal(f.kb.matches(keys[0][encoding], "app.exit"), true);
          f.editor.handleInput(keys[0][encoding]);
          assert.deepEqual(f.fired, ["app.exit"]);
          assert.equal(f.editor.getText(), "");
          assertNoPending(f.state);
        });
      }
    }
  }

  for (const key of keys) {
    for (const encoding of ["raw", "kitty"] as const) {
      it(`enabled ${encoding} Ctrl-${key.name} preserves app precedence over scroll and aliases`, () => {
        for (const setup of contexts) {
          const f = fixture(setup, {
            "app.model.cycleForward": `ctrl+${key.name}`,
          });
          f.editor.setScrollKeys(true);
          const before = f.snapshot();
          f.editor.handleInput(key[encoding]);
          assert.deepEqual(f.fired, ["app.model.cycleForward"]);
          assert.deepEqual(f.snapshot(), before);
          assertNoPending(f.state);
        }
      });
    }
  }
  it("excluded Ctrl-E/Y retain editor consumption and registered app ownership", () => {
    for (const [name, raw] of [
      ["e", "\x05"],
      ["y", "\x19"],
    ]) {
      for (const enabled of [false, true]) {
        for (const setup of contexts) {
          const f = fixture(setup);
          f.editor.setScrollKeys(enabled);
          const before = f.snapshot();
          f.editor.handleInput(raw);
          assert.deepEqual(f.snapshot(), before);
          assert.deepEqual(f.fired, []);
          assert.deepEqual(f.forwarded, []);
          assertNoPending(f.state);
          const app = fixture(setup, {
            "app.model.cycleForward": `ctrl+${name}`,
          });
          app.editor.setScrollKeys(enabled);
          const appBefore = app.snapshot();
          app.editor.handleInput(raw);
          assert.deepEqual(app.snapshot(), appBefore);
          assert.deepEqual(app.fired, ["app.model.cycleForward"]);
          assertNoPending(app.state);
        }
      }
    }
  });

  it("enabled scrolling keeps other default application chords", () => {
    for (const setup of contexts) {
      for (const key of APP_KEYS) {
        const f = fixture(setup);
        f.editor.setScrollKeys(true);
        const before = f.snapshot();
        f.editor.handleInput(key.raw);
        assert.deepEqual(f.fired, [key.action]);
        assert.deepEqual(f.snapshot(), before);
        assertNoPending(f.state);
      }
    }
  });
});
