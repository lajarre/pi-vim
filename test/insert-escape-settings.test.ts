import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_INSERT_ESCAPE_SETTINGS,
  readPiVimInsertEscapeSetting,
  resolveInsertEscapeSettings,
} from "../settings.js";

const resolve = (g: unknown, p: unknown) =>
  resolveInsertEscapeSettings(readPiVimInsertEscapeSetting(g, p));
const at = (insertEscape: unknown) => ({ piVim: { insertEscape } });
const JK = { enabled: true, sequence: "jk", timeoutMs: 300 };

describe("piVim insertEscape settings", () => {
  it("defaults to off, with no sequence and a 300ms window", () => {
    assert.deepEqual(DEFAULT_INSERT_ESCAPE_SETTINGS, {
      enabled: false,
      sequence: "",
      timeoutMs: 300,
    });
    const resolved = resolve({}, {});
    assert.deepEqual(resolved, { settings: DEFAULT_INSERT_ESCAPE_SETTINGS });
    assert.notEqual(resolved.settings, DEFAULT_INSERT_ESCAPE_SETTINGS);
    assert.deepEqual(resolveInsertEscapeSettings(undefined), {
      settings: DEFAULT_INSERT_ESCAPE_SETTINGS,
    });
    // A timeout alone does not turn the escape on.
    assert.deepEqual(resolve(at({ timeoutMs: 200 }), {}), {
      settings: { ...DEFAULT_INSERT_ESCAPE_SETTINGS, timeoutMs: 200 },
    });
  });

  it("turns on when a sequence is set", () => {
    assert.deepEqual(resolve(at({ sequence: "jk" }), {}), { settings: JK });
    assert.deepEqual(resolve({}, at({ sequence: "jk" })), { settings: JK });
    assert.deepEqual(resolve(at({ sequence: "kj", timeoutMs: 150 }), {}), {
      settings: { enabled: true, sequence: "kj", timeoutMs: 150 },
    });
  });

  it("lets a present project value replace global as a whole", () => {
    assert.deepEqual(
      resolve(at({ sequence: "jj", timeoutMs: 200 }), at({ sequence: ";;" })),
      { settings: { enabled: true, sequence: ";;", timeoutMs: 300 } },
    );
    // A project object without a sequence switches the global escape off.
    assert.deepEqual(resolve(at({ sequence: "jk" }), at({})), {
      settings: DEFAULT_INSERT_ESCAPE_SETTINGS,
    });
    // Even an invalid project value wins; it does not fall back to global.
    const invalid = resolve(at({ sequence: "jk" }), at("jk"));
    assert.deepEqual(invalid.settings, DEFAULT_INSERT_ESCAPE_SETTINGS);
    assert.match(invalid.warning ?? "", /expected an object/);
  });

  it("accepts 2-32 printable ASCII characters, case-sensitively", () => {
    for (const sequence of ["jj", "jk", "JK", ";;", "a b", "x".repeat(32)])
      assert.deepEqual(resolve({}, at({ sequence })), {
        settings: { ...JK, sequence },
      });
  });

  it("falls back to the default for invalid fields with one warning", () => {
    for (const sequence of ["", "j", "x".repeat(33), "jé", "j\x1b", 12, null])
      assert.deepEqual(resolve({}, at({ sequence, timeoutMs: 250 })).settings, {
        ...DEFAULT_INSERT_ESCAPE_SETTINGS,
        timeoutMs: 250,
      });
    for (const timeoutMs of [0, -1, 1.5, 60001, "300", Number.NaN, null])
      assert.equal(
        resolve({}, at({ sequence: "jk", timeoutMs })).settings.timeoutMs,
        300,
      );
    assert.equal(
      resolve({}, at({ timeoutMs: 60000 })).settings.timeoutMs,
      60000,
    );
    assert.equal(resolve({}, at({ timeoutMs: 1 })).settings.timeoutMs, 1);

    const resolved = resolve({}, at({ sequence: "\x1b[31m", timeoutMs: 0 }));
    assert.deepEqual(resolved.settings, DEFAULT_INSERT_ESCAPE_SETTINGS);
    const warning = resolved.warning ?? "";
    assert.match(warning, /^Invalid piVim\.insertEscape sequence, timeoutMs;/);
    assert.ok(!warning.includes("\x1b"), "never echoes invalid input");
  });

  it("warns for a non-object value", () => {
    for (const value of [true, false, "jk", 1, null]) {
      const resolved = resolve(at(value), {});
      assert.deepEqual(resolved.settings, DEFAULT_INSERT_ESCAPE_SETTINGS);
      assert.match(resolved.warning ?? "", /expected an object/);
    }
  });
});
