import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_ESCAPE_SEQUENCE_SETTINGS,
  DEFAULT_EX_COMMAND_SETTINGS,
  readPiVimBorderSync,
  readPiVimBorderSyncSetting,
  readPiVimClipboardMirrorSetting,
  readPiVimEscapeSequenceSetting,
  readPiVimExCommandSetting,
  readPiVimGlobalExCommandSetting,
  readPiVimLabelSync,
  readPiVimModeChange,
  readPiVimModeColors,
  resolveEscapeSequenceSettings,
  resolveExCommandSettings,
  resolveSurfaceSyncMaps,
  type SurfaceSyncMap,
} from "../settings.js";

describe("piVim mode color settings reader", () => {
  it("returns undefined when mode colors are missing", () => {
    assert.equal(readPiVimModeColors(undefined, undefined), undefined);
    assert.equal(readPiVimModeColors({ piVim: {} }, { piVim: {} }), undefined);
  });

  it("reads partial mode color settings", () => {
    assert.deepEqual(
      readPiVimModeColors(
        { piVim: { modeColors: { insert: " borderMuted " } } },
        {},
      ),
      { insert: "borderMuted" },
    );
  });

  it("reads all four mode color settings", () => {
    assert.deepEqual(
      readPiVimModeColors(
        {
          piVim: {
            modeColors: {
              insert: "muted",
              normal: "primary",
              visual: "customMessageLabel",
              ex: "warning",
            },
          },
        },
        {},
      ),
      {
        insert: "muted",
        normal: "primary",
        visual: "customMessageLabel",
        ex: "warning",
      },
    );
  });

  it("lets a project override the visual mode color", () => {
    assert.deepEqual(
      readPiVimModeColors(
        { piVim: { modeColors: { visual: "globalVisual" } } },
        { piVim: { modeColors: { visual: "projectVisual" } } },
      ),
      { visual: "projectVisual" },
    );
  });

  it("drops non-string mode color leaves", () => {
    assert.deepEqual(
      readPiVimModeColors(
        {
          piVim: { modeColors: { insert: "muted", normal: 42, ex: "warning" } },
        },
        {},
      ),
      { insert: "muted", ex: "warning" },
    );
  });

  it("drops malformed mode color tokens", () => {
    assert.deepEqual(
      readPiVimModeColors(
        {
          piVim: {
            modeColors: {
              insert: "red;evil",
              normal: "_bad",
              ex: "warn-ing_1",
            },
          },
        },
        {},
      ),
      { ex: "warn-ing_1" },
    );
  });

  it("lets project modeColors override global as a setting", () => {
    assert.deepEqual(
      readPiVimModeColors(
        {
          piVim: {
            modeColors: {
              insert: "globalInsert",
              normal: "globalNormal",
              ex: "globalEx",
            },
          },
        },
        { piVim: { modeColors: { ex: "projectEx" } } },
      ),
      { ex: "projectEx" },
    );
  });

  it("does not fall back to global modeColors when project leaves are invalid", () => {
    assert.deepEqual(
      readPiVimModeColors(
        {
          piVim: {
            modeColors: {
              insert: "globalInsert",
              normal: "globalNormal",
              ex: "globalEx",
            },
          },
        },
        {
          piVim: {
            modeColors: {
              insert: "projectInsert",
              normal: 42,
              ex: "red;evil",
            },
          },
        },
      ),
      { insert: "projectInsert" },
    );
  });

  it("treats malformed project modeColors as an override", () => {
    assert.equal(
      readPiVimModeColors(
        { piVim: { modeColors: { insert: "globalInsert" } } },
        { piVim: { modeColors: null } },
      ),
      undefined,
    );
  });
});

describe("piVim border sync settings reader", () => {
  it("returns undefined when the setting is missing", () => {
    assert.equal(readPiVimBorderSyncSetting(undefined, undefined), undefined);
    assert.equal(
      readPiVimBorderSyncSetting({ piVim: {} }, { piVim: {} }),
      undefined,
    );
  });

  it("reads true and false", () => {
    assert.equal(
      readPiVimBorderSyncSetting(
        { piVim: { syncBorderColorWithMode: true } },
        {},
      ),
      true,
    );
    assert.equal(
      readPiVimBorderSyncSetting(
        { piVim: { syncBorderColorWithMode: false } },
        {},
      ),
      false,
    );
  });

  it("reads the inherit mode", () => {
    assert.equal(
      readPiVimBorderSyncSetting(
        { piVim: { syncBorderColorWithMode: "inherit" } },
        {},
      ),
      "inherit",
    );
  });

  it("ignores invalid values", () => {
    assert.equal(
      readPiVimBorderSyncSetting(
        { piVim: { syncBorderColorWithMode: "true" } },
        {},
      ),
      undefined,
    );
    assert.equal(
      readPiVimBorderSyncSetting(
        { piVim: { syncBorderColorWithMode: "always" } },
        {},
      ),
      undefined,
    );
    assert.equal(
      readPiVimBorderSyncSetting({ piVim: { syncBorderColorWithMode: 1 } }, {}),
      undefined,
    );
    assert.equal(
      readPiVimBorderSyncSetting(
        { piVim: { syncBorderColorWithMode: null } },
        {},
      ),
      undefined,
    );
  });

  it("lets project settings override global", () => {
    assert.equal(
      readPiVimBorderSyncSetting(
        { piVim: { syncBorderColorWithMode: true } },
        { piVim: { syncBorderColorWithMode: false } },
      ),
      false,
    );
    assert.equal(
      readPiVimBorderSyncSetting(
        { piVim: { syncBorderColorWithMode: true } },
        { piVim: { syncBorderColorWithMode: "inherit" } },
      ),
      "inherit",
    );
  });

  it("treats invalid project settings as an override", () => {
    assert.equal(
      readPiVimBorderSyncSetting(
        { piVim: { syncBorderColorWithMode: true } },
        { piVim: { syncBorderColorWithMode: "false" } },
      ),
      undefined,
    );
  });
});

describe("piVim border/label sync map readers", () => {
  it("returns undefined when the maps are missing", () => {
    assert.equal(readPiVimBorderSync(undefined, undefined), undefined);
    assert.equal(readPiVimBorderSync({ piVim: {} }, { piVim: {} }), undefined);
    assert.equal(readPiVimLabelSync(undefined, undefined), undefined);
  });

  it("reads a partial borderSync map, defaulting missing modes to host", () => {
    assert.deepEqual(
      readPiVimBorderSync({ piVim: { borderSync: { visual: "mode" } } }, {}),
      { insert: "host", normal: "host", visual: "mode", ex: "host" },
    );
  });

  it("reads a partial labelSync map, defaulting missing modes to mode", () => {
    assert.deepEqual(
      readPiVimLabelSync({ piVim: { labelSync: { insert: "thinking" } } }, {}),
      { insert: "thinking", normal: "mode", visual: "mode", ex: "mode" },
    );
  });

  it("drops invalid enum values back to the surface default", () => {
    assert.deepEqual(
      readPiVimBorderSync(
        { piVim: { borderSync: { insert: "bogus", normal: "thinking" } } },
        {},
      ),
      { insert: "host", normal: "thinking", visual: "host", ex: "host" },
    );
  });

  it("returns undefined when no entry is valid", () => {
    assert.equal(
      readPiVimBorderSync({ piVim: { borderSync: { insert: "bogus" } } }, {}),
      undefined,
    );
    assert.equal(
      readPiVimBorderSync({ piVim: { borderSync: "nope" } }, {}),
      undefined,
    );
  });

  it("lets a project borderSync override global as a whole map", () => {
    assert.deepEqual(
      readPiVimBorderSync(
        { piVim: { borderSync: { insert: "mode", normal: "mode" } } },
        { piVim: { borderSync: { visual: "thinking" } } },
      ),
      { insert: "host", normal: "host", visual: "thinking", ex: "host" },
    );
  });

  it("treats an invalid project borderSync as an override, not a fallback", () => {
    assert.equal(
      readPiVimBorderSync(
        { piVim: { borderSync: { insert: "mode" } } },
        { piVim: { borderSync: null } },
      ),
      undefined,
    );
  });
});

describe("piVim surface sync resolver", () => {
  const HOST: SurfaceSyncMap = {
    insert: "host",
    normal: "host",
    visual: "host",
    ex: "host",
  };
  const MODE: SurfaceSyncMap = {
    insert: "mode",
    normal: "mode",
    visual: "mode",
    ex: "mode",
  };
  const THINKING: SurfaceSyncMap = {
    insert: "thinking",
    normal: "thinking",
    visual: "thinking",
    ex: "thinking",
  };

  it("defaults both maps when nothing is set", () => {
    assert.deepEqual(resolveSurfaceSyncMaps({}), {
      borderSync: HOST,
      labelSync: MODE,
    });
  });

  it("maps legacy false to the defaults", () => {
    assert.deepEqual(
      resolveSurfaceSyncMaps({ syncBorderColorWithMode: false }),
      {
        borderSync: HOST,
        labelSync: MODE,
      },
    );
  });

  it("maps legacy true to all-mode borders and a default label", () => {
    assert.deepEqual(
      resolveSurfaceSyncMaps({ syncBorderColorWithMode: true }),
      {
        borderSync: MODE,
        labelSync: MODE,
      },
    );
  });

  it("maps legacy inherit to all-thinking on both surfaces", () => {
    assert.deepEqual(
      resolveSurfaceSyncMaps({ syncBorderColorWithMode: "inherit" }),
      { borderSync: THINKING, labelSync: THINKING },
    );
  });

  it("lets a present map win over the legacy key per surface", () => {
    assert.deepEqual(
      resolveSurfaceSyncMaps({
        borderSync: MODE,
        syncBorderColorWithMode: "inherit",
      }),
      { borderSync: MODE, labelSync: THINKING },
    );
  });
});

describe("piVim modeChange settings reader", () => {
  it("returns undefined when modeChange is missing", () => {
    assert.equal(readPiVimModeChange(undefined, undefined), undefined);
    assert.equal(readPiVimModeChange({ piVim: {} }, { piVim: {} }), undefined);
  });

  it("reads partial modeChange settings and trims values", () => {
    assert.deepEqual(
      readPiVimModeChange(
        { piVim: { modeChange: { insert: "  im-select Squirrel  " } } },
        {},
      ),
      { insert: "im-select Squirrel" },
    );
  });

  it("reads both insert and normal commands", () => {
    assert.deepEqual(
      readPiVimModeChange(
        {
          piVim: {
            modeChange: {
              insert: "im-select im.rime.inputmethod.Squirrel.Hans",
              normal: "im-select com.apple.keylayout.ABC",
            },
          },
        },
        {},
      ),
      {
        insert: "im-select im.rime.inputmethod.Squirrel.Hans",
        normal: "im-select com.apple.keylayout.ABC",
      },
    );
  });

  it("drops non-string and empty modeChange leaves", () => {
    assert.deepEqual(
      readPiVimModeChange(
        {
          piVim: { modeChange: { insert: 42, normal: "  " } },
        },
        {},
      ),
      undefined,
    );
    assert.deepEqual(
      readPiVimModeChange(
        { piVim: { modeChange: { insert: "ok", normal: 42 } } },
        {},
      ),
      { insert: "ok" },
    );
  });

  it("ignores project modeChange settings because commands are global-only", () => {
    assert.deepEqual(
      readPiVimModeChange(
        {
          piVim: {
            modeChange: { insert: "global-insert", normal: "global-normal" },
          },
        },
        { piVim: { modeChange: { normal: "project-normal" } } },
      ),
      { insert: "global-insert", normal: "global-normal" },
    );
    assert.deepEqual(
      readPiVimModeChange(
        {},
        { piVim: { modeChange: { insert: "project-insert" } } },
      ),
      undefined,
    );
  });

  it("does not let invalid project modeChange suppress global commands", () => {
    assert.deepEqual(
      readPiVimModeChange(
        { piVim: { modeChange: { insert: "global-insert" } } },
        { piVim: { modeChange: null } },
      ),
      { insert: "global-insert" },
    );
    assert.deepEqual(
      readPiVimModeChange(
        { piVim: { modeChange: { normal: "global-normal" } } },
        { piVim: { modeChange: { insert: "   " } } },
      ),
      { normal: "global-normal" },
    );
  });
});

describe("piVim clipboard mirror settings reader", () => {
  it("returns undefined when global and project settings are missing", () => {
    assert.equal(
      readPiVimClipboardMirrorSetting(undefined, undefined),
      undefined,
    );
    assert.equal(readPiVimClipboardMirrorSetting(null, null), undefined);
    assert.equal(readPiVimClipboardMirrorSetting("bad", 42), undefined);
  });

  it("reads global piVim clipboardMirror when project setting is missing", () => {
    assert.equal(
      readPiVimClipboardMirrorSetting(
        { piVim: { clipboardMirror: "yank" } },
        {},
      ),
      "yank",
    );
  });

  it("lets project piVim clipboardMirror override global", () => {
    assert.equal(
      readPiVimClipboardMirrorSetting(
        { piVim: { clipboardMirror: "never" } },
        { piVim: { clipboardMirror: "all" } },
      ),
      "all",
    );
  });

  it("treats invalid project clipboardMirror as an override instead of falling back to global", () => {
    assert.equal(
      readPiVimClipboardMirrorSetting(
        { piVim: { clipboardMirror: "yank" } },
        { piVim: { clipboardMirror: null } },
      ),
      null,
    );
  });

  it("treats malformed project piVim settings as an override instead of falling back to global", () => {
    assert.equal(
      readPiVimClipboardMirrorSetting(
        { piVim: { clipboardMirror: "yank" } },
        { piVim: "bad" },
      ),
      "bad",
    );
  });
});

describe("piVim exCommand settings reader", () => {
  it("returns undefined when global and project settings are missing", () => {
    assert.equal(readPiVimExCommandSetting(undefined, undefined), undefined);
    assert.equal(
      readPiVimExCommandSetting({ piVim: {} }, { piVim: {} }),
      undefined,
    );
  });

  it("reads global piVim exCommand when the project setting is missing", () => {
    assert.deepEqual(
      readPiVimExCommandSetting(
        { piVim: { exCommand: { piDispatch: false } } },
        {},
      ),
      { piDispatch: false },
    );
  });

  it("lets project piVim exCommand override global", () => {
    assert.deepEqual(
      readPiVimExCommandSetting(
        { piVim: { exCommand: { piDispatch: true } } },
        { piVim: { exCommand: { piDispatch: false } } },
      ),
      { piDispatch: false },
    );
  });
});

describe("piVim exCommand settings resolver", () => {
  it("ignores project clipboard copy when the global setting uses its default", () => {
    const global = { piVim: { exCommand: {} } };
    const project = {
      piVim: { exCommand: { copyInputToClipboard: true } },
    };
    const resolved = resolveExCommandSettings(
      readPiVimExCommandSetting(global, project),
      readPiVimGlobalExCommandSetting(global, project),
    );

    assert.equal(resolved.settings.copyInputToClipboard, false);
  });

  it("reads global clipboard copy through a project exCommand object", () => {
    const global = {
      piVim: { exCommand: { copyInputToClipboard: true } },
    };
    const project = { piVim: { exCommand: { piDispatch: true } } };
    const resolved = resolveExCommandSettings(
      readPiVimExCommandSetting(global, project),
      readPiVimGlobalExCommandSetting(global, project),
    );

    assert.equal(resolved.settings.copyInputToClipboard, true);
  });

  it("honors project piDispatch while clipboard copy stays global-only", () => {
    const global = {
      piVim: { exCommand: { copyInputToClipboard: true } },
    };
    const project = { piVim: { exCommand: { piDispatch: false } } };
    const resolved = resolveExCommandSettings(
      readPiVimExCommandSetting(global, project),
      readPiVimGlobalExCommandSetting(global, project),
    );

    assert.deepEqual(resolved.settings, {
      piDispatch: false,
      copyInputToClipboard: true,
    });
  });

  it("defaults to dispatch on and clipboard copy off", () => {
    const resolved = resolveExCommandSettings(undefined, undefined);

    assert.deepEqual(resolved.settings, {
      piDispatch: true,
      copyInputToClipboard: false,
    });
    assert.equal(resolved.warning, undefined);
  });

  it("does not hand out the shared defaults object", () => {
    const resolved = resolveExCommandSettings(undefined, undefined);

    assert.notEqual(resolved.settings, DEFAULT_EX_COMMAND_SETTINGS);
  });

  it("reads both boolean keys", () => {
    const value = {
      piDispatch: false,
      copyInputToClipboard: true,
    };
    const resolved = resolveExCommandSettings(value, value);

    assert.deepEqual(resolved.settings, {
      piDispatch: false,
      copyInputToClipboard: true,
    });
    assert.equal(resolved.warning, undefined);
  });

  it("keeps defaults for keys that are absent", () => {
    const value = { copyInputToClipboard: true };
    const resolved = resolveExCommandSettings(value, value);

    assert.deepEqual(resolved.settings, {
      piDispatch: true,
      copyInputToClipboard: true,
    });
    assert.equal(resolved.warning, undefined);
  });

  it("warns and defaults when the value is not an object", () => {
    for (const value of ["yes", 1, null, [], true]) {
      const resolved = resolveExCommandSettings(value, value);

      assert.deepEqual(resolved.settings, {
        piDispatch: true,
        copyInputToClipboard: false,
      });
      assert.equal(
        resolved.warning,
        "Invalid piVim.exCommand; expected an object.",
      );
    }
  });

  it("warns and defaults per key when a key is not a boolean", () => {
    const value = {
      piDispatch: "true",
      copyInputToClipboard: 1,
    };
    const resolved = resolveExCommandSettings(value, value);

    assert.deepEqual(resolved.settings, {
      piDispatch: true,
      copyInputToClipboard: false,
    });
    assert.equal(
      resolved.warning,
      "Invalid piVim.exCommand piDispatch, copyInputToClipboard; expected a boolean.",
    );
  });

  it("keeps a valid key when a sibling key is invalid", () => {
    const value = {
      piDispatch: false,
      copyInputToClipboard: "on",
    };
    const resolved = resolveExCommandSettings(value, value);

    assert.deepEqual(resolved.settings, {
      piDispatch: false,
      copyInputToClipboard: false,
    });
    assert.equal(
      resolved.warning,
      "Invalid piVim.exCommand copyInputToClipboard; expected a boolean.",
    );
  });
});

describe("piVim escapeSequence settings reader", () => {
  it("returns undefined when global and project settings are missing", () => {
    assert.equal(
      readPiVimEscapeSequenceSetting(undefined, undefined),
      undefined,
    );
    assert.equal(
      readPiVimEscapeSequenceSetting({ piVim: {} }, { piVim: {} }),
      undefined,
    );
  });

  it("reads global piVim escapeSequence when the project setting is missing", () => {
    assert.equal(
      readPiVimEscapeSequenceSetting({ piVim: { escapeSequence: "jk" } }, {}),
      "jk",
    );
  });

  it("lets project piVim escapeSequence override global", () => {
    assert.equal(
      readPiVimEscapeSequenceSetting(
        { piVim: { escapeSequence: "jk" } },
        { piVim: { escapeSequence: "kj" } },
      ),
      "kj",
    );
  });
});

describe("piVim escapeSequence settings resolver", () => {
  it("defaults to disabled when unset", () => {
    const resolved = resolveEscapeSequenceSettings(undefined);

    assert.deepEqual(resolved.settings, {
      enabled: false,
      sequence: "jk",
      timeoutMs: 300,
    });
    assert.equal(resolved.warning, undefined);
  });

  it("does not hand out the shared defaults object", () => {
    const resolved = resolveEscapeSequenceSettings(undefined);

    assert.notEqual(resolved.settings, DEFAULT_ESCAPE_SEQUENCE_SETTINGS);
  });

  it("enables with a bare string shorthand", () => {
    const resolved = resolveEscapeSequenceSettings("kj");

    assert.deepEqual(resolved.settings, {
      enabled: true,
      sequence: "kj",
      timeoutMs: 300,
    });
    assert.equal(resolved.warning, undefined);
  });

  it("warns and stays disabled for an invalid string shorthand", () => {
    for (const value of ["j", "a".repeat(9), "j k", ""]) {
      const resolved = resolveEscapeSequenceSettings(value);

      assert.deepEqual(resolved.settings, DEFAULT_ESCAPE_SEQUENCE_SETTINGS);
      assert.equal(
        resolved.warning,
        `Invalid piVim.escapeSequence "${value}"; expected 2-8 printable, non-whitespace ASCII characters.`,
      );
    }
  });

  it("enables via object presence even with every key defaulted", () => {
    const resolved = resolveEscapeSequenceSettings({});

    assert.deepEqual(resolved.settings, {
      enabled: true,
      sequence: "jk",
      timeoutMs: 300,
    });
    assert.equal(resolved.warning, undefined);
  });

  it("reads a custom sequence and timeoutMs from the object form", () => {
    const resolved = resolveEscapeSequenceSettings({
      sequence: "fd",
      timeoutMs: 150,
    });

    assert.deepEqual(resolved.settings, {
      enabled: true,
      sequence: "fd",
      timeoutMs: 150,
    });
    assert.equal(resolved.warning, undefined);
  });

  it("clamps timeoutMs to the supported range", () => {
    assert.equal(
      resolveEscapeSequenceSettings({ timeoutMs: 1 }).settings.timeoutMs,
      50,
    );
    assert.equal(
      resolveEscapeSequenceSettings({ timeoutMs: 5000 }).settings.timeoutMs,
      2000,
    );
  });

  it("stays enabled with a defaulted sequence when the object's sequence is invalid", () => {
    const resolved = resolveEscapeSequenceSettings({ sequence: "j" });

    assert.deepEqual(resolved.settings, {
      enabled: true,
      sequence: "jk",
      timeoutMs: 300,
    });
    assert.equal(resolved.warning, "Invalid piVim.escapeSequence sequence.");
  });

  it("warns and defaults when the value is neither a string nor an object", () => {
    for (const value of [1, null, [], true]) {
      const resolved = resolveEscapeSequenceSettings(value);

      assert.deepEqual(resolved.settings, DEFAULT_ESCAPE_SEQUENCE_SETTINGS);
      assert.equal(
        resolved.warning,
        "Invalid piVim.escapeSequence; expected a string or an object.",
      );
    }
  });

  it("warns and defaults timeoutMs when it is not a positive number", () => {
    const resolved = resolveEscapeSequenceSettings({ timeoutMs: "fast" });

    assert.deepEqual(resolved.settings, {
      enabled: true,
      sequence: "jk",
      timeoutMs: 300,
    });
    assert.equal(resolved.warning, "Invalid piVim.escapeSequence timeoutMs.");
  });
});
