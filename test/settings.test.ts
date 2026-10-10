import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_CURSOR_SHAPE_SETTINGS,
  DEFAULT_EX_COMMAND_SETTINGS,
  readPiVimBorderSync,
  readPiVimBorderSyncSetting,
  readPiVimClipboardMirrorSetting,
  readPiVimCursorShapeSetting,
  readPiVimExCommandSetting,
  readPiVimGlobalExCommandSetting,
  readPiVimLabelSync,
  readPiVimModeChange,
  readPiVimModeColors,
  resolveCursorShapeSettings,
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

describe("piVim cursorShape settings", () => {
  it("defaults to bar/block without sharing the defaults object", () => {
    const result = resolveCursorShapeSettings(
      readPiVimCursorShapeSetting(undefined, undefined),
    );
    assert.deepEqual(result, { settings: { insert: "bar", normal: "block" } });
    assert.notEqual(result.settings, DEFAULT_CURSOR_SHAPE_SETTINGS);
    assert.deepEqual(resolveCursorShapeSettings({}).settings, result.settings);
  });

  it("reads global values and accepts all three shapes for either mode", () => {
    for (const shape of ["block", "underline", "bar"]) {
      assert.deepEqual(
        resolveCursorShapeSettings(
          readPiVimCursorShapeSetting(
            { piVim: { cursorShape: { insert: shape, normal: shape } } },
            { piVim: {} },
          ),
        ),
        { settings: { insert: shape, normal: shape } },
      );
    }
  });

  it("overrides the whole global map, defaulting missing project keys", () => {
    assert.deepEqual(
      resolveCursorShapeSettings(
        readPiVimCursorShapeSetting(
          { piVim: { cursorShape: { insert: "underline", normal: "bar" } } },
          { piVim: { cursorShape: { insert: "block" } } },
        ),
      ),
      { settings: { insert: "block", normal: "block" } },
    );
  });

  it("does not fall back to globals for malformed project overrides", () => {
    for (const value of [null, [], "block", 5, false]) {
      const result = resolveCursorShapeSettings(
        readPiVimCursorShapeSetting(
          { piVim: { cursorShape: { insert: "underline", normal: "bar" } } },
          { piVim: { cursorShape: value } },
        ),
      );
      assert.deepEqual(result, {
        settings: DEFAULT_CURSOR_SHAPE_SETTINGS,
        warning: "Invalid piVim.cursorShape; expected an object.",
      });
    }
    assert.equal(
      readPiVimCursorShapeSetting(
        { piVim: { cursorShape: {} } },
        { piVim: null },
      ),
      null,
    );
  });

  it("warns once for invalid keys and defaults only those keys", () => {
    for (const invalid of [
      "beam",
      "BLOCK",
      " bar ",
      "",
      null,
      1,
      true,
      [],
      {},
    ]) {
      assert.deepEqual(
        resolveCursorShapeSettings({ insert: invalid, normal: "bar" }),
        {
          settings: { insert: "bar", normal: "bar" },
          warning:
            "Invalid piVim.cursorShape insert; expected block, underline, or bar.",
        },
      );
      assert.deepEqual(
        resolveCursorShapeSettings({ insert: "block", normal: invalid }),
        {
          settings: { insert: "block", normal: "block" },
          warning:
            "Invalid piVim.cursorShape normal; expected block, underline, or bar.",
        },
      );
    }
    assert.deepEqual(
      resolveCursorShapeSettings({ insert: "invalid", normal: "invalid" }),
      {
        settings: DEFAULT_CURSOR_SHAPE_SETTINGS,
        warning:
          "Invalid piVim.cursorShape insert, normal; expected block, underline, or bar.",
      },
    );
  });

  it("ignores unknown mode keys instead of emitting terminal data", () => {
    assert.deepEqual(
      resolveCursorShapeSettings({ visual: "bar", ex: "underline" }),
      {
        settings: DEFAULT_CURSOR_SHAPE_SETTINGS,
      },
    );
    assert.equal(
      resolveCursorShapeSettings({ insert: "\x1b[0 q" }).settings.insert,
      "bar",
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
