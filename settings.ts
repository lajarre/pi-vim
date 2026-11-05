import { SettingsManager } from "@earendil-works/pi-coding-agent";

export type ModeColorSettings = {
  insert?: string;
  normal?: string;
  visual?: string;
  ex?: string;
};

export type LabelPosition = "bottom-right" | "top-left";

export type CursorShape =
  | "block"
  | "underline"
  | "bar"
  | "steady-block"
  | "steady-underline"
  | "steady-bar";
export type CursorShapeSettings = {
  insert: CursorShape;
  normal: CursorShape;
};

export type ModeChangeSettings = {
  insert?: string;
  normal?: string;
};

export type ExCommandSettings = {
  piDispatch: boolean;
  copyInputToClipboard: boolean;
};

export type BorderSyncMode = boolean | "inherit";

// Per-surface paint policy for a single mode:
//   - "mode"     always paint that mode's color;
//   - "host"     always show the host's current border color;
//   - "thinking" show the host color while its border is away from the neutral
//                resting default, otherwise paint the mode color.
export type SurfaceSync = "mode" | "host" | "thinking";
export type SurfaceSyncMap = {
  insert: SurfaceSync;
  normal: SurfaceSync;
  visual: SurfaceSync;
  ex: SurfaceSync;
};

export type PiVimSettings = {
  clipboardMirror?: unknown;
  exCommand?: unknown;
  globalExCommand?: unknown;
  modeColors?: ModeColorSettings;
  historyNavigation?: unknown;
  scrollKeys?: unknown;
  labelPosition?: unknown;
  cursorShape?: unknown;
  modeChange?: ModeChangeSettings;
  // Per-mode paint policy for Pi's input border. Default: every mode "host".
  borderSync?: SurfaceSyncMap;
  // Per-mode paint policy for pi-vim's mode label. Default: "mode".
  labelSync?: SurfaceSyncMap;
  // Deprecated, never-released alias superseded by borderSync/labelSync; still
  // accepted and translated in `resolveSurfaceSyncMaps`. `false`/absent → both
  // maps at their defaults; `true` → borderSync all "mode"; the never-released
  // `"inherit"` → both maps all "thinking".
  syncBorderColorWithMode?: BorderSyncMode;
};

export const DEFAULT_CURSOR_SHAPE_SETTINGS: CursorShapeSettings = {
  insert: "bar",
  normal: "block",
};

export const DEFAULT_EX_COMMAND_SETTINGS: ExCommandSettings = {
  piDispatch: true,
  copyInputToClipboard: false,
};

const M = Symbol(),
  C = ["insert", "normal", "visual", "ex"] as const,
  MC = ["insert", "normal"] as const,
  T = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const rec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function get(s: unknown, k: keyof PiVimSettings): unknown {
  if (!rec(s) || !Object.hasOwn(s, "piVim")) return M;
  const p = s.piVim;
  if (!rec(p)) return p;
  return Object.hasOwn(p, k) ? p[k] : M;
}

function colors(v: unknown) {
  if (!rec(v)) return;
  const r: ModeColorSettings = {};
  for (const k of C) {
    const x = v[k],
      t = typeof x === "string" ? x.trim() : "";
    if (T.test(t)) r[k] = t;
  }
  return Object.keys(r)[0] ? r : undefined;
}

const BORDER_SYNC_DEFAULT: SurfaceSync = "host";
const LABEL_SYNC_DEFAULT: SurfaceSync = "mode";

// Validates a per-mode paint-policy map. Like `colors`, a project map is a
// whole-setting override: missing or invalid entries fall back to the surface
// default (not to the global map). Returns undefined when no valid entry is
// present so the caller can defer to the legacy key.
function surfaceMap(v: unknown, dflt: SurfaceSync): SurfaceSyncMap | undefined {
  if (!rec(v)) return;
  const r: SurfaceSyncMap = {
    insert: dflt,
    normal: dflt,
    visual: dflt,
    ex: dflt,
  };
  let any = false;
  for (const k of C) {
    const x = v[k];
    if (x === "mode" || x === "host" || x === "thinking") {
      r[k] = x;
      any = true;
    }
  }
  return any ? r : undefined;
}

function fill(value: SurfaceSync): SurfaceSyncMap {
  return { insert: value, normal: value, visual: value, ex: value };
}

function modeChange(v: unknown): ModeChangeSettings | undefined {
  if (!rec(v)) return;
  const r: ModeChangeSettings = {};
  for (const k of MC) {
    const x = v[k];
    if (typeof x !== "string") continue;
    const t = x.trim();
    if (t.length > 0) r[k] = t;
  }
  return Object.keys(r)[0] ? r : undefined;
}

export function readPiVimClipboardMirrorSetting(g: unknown, p: unknown) {
  let v = get(p, "clipboardMirror");
  if (v !== M) return v;
  v = get(g, "clipboardMirror");
  return v === M ? undefined : v;
}

export function readPiVimExCommandSetting(g: unknown, p: unknown) {
  // The bridge only selects among commands Pi already trusts; it grants no new
  // capability, so a project file may turn it off (unlike modeChange).
  let v = get(p, "exCommand");
  if (v !== M) return v;
  v = get(g, "exCommand");
  return v === M ? undefined : v;
}

export function readPiVimGlobalExCommandSetting(g: unknown, p: unknown) {
  void p;
  // Copying the prompt to the OS clipboard is an exfiltration capability, so
  // only the user-global settings file is trusted. Project settings may be
  // checked into a repo and must not be able to enable clipboard writes.
  const v = get(g, "exCommand");
  return v === M ? undefined : v;
}

export function resolveExCommandSettings(
  value: unknown,
  globalValue: unknown,
): {
  settings: ExCommandSettings;
  warning?: string;
} {
  const settings = { ...DEFAULT_EX_COMMAND_SETTINGS };
  let invalidObject = false;
  const invalid: string[] = [];
  for (const [k, source] of [
    ["piDispatch", value],
    ["copyInputToClipboard", globalValue],
  ] as const) {
    if (source === undefined) continue;
    if (!rec(source)) {
      invalidObject = true;
      continue;
    }
    if (!Object.hasOwn(source, k)) continue;
    const v = source[k];
    if (typeof v === "boolean") settings[k] = v;
    else invalid.push(k);
  }

  if (invalidObject) {
    return {
      settings,
      warning: "Invalid piVim.exCommand; expected an object.",
    };
  }
  if (!invalid[0]) return { settings };
  return {
    settings,
    warning: `Invalid piVim.exCommand ${invalid.join(", ")}; expected a boolean.`,
  };
}

export function readPiVimLabelPositionSetting(g: unknown, p: unknown) {
  // A present project value overrides global even when invalid, like modeColors.
  const v = get(p, "labelPosition");
  if (v !== M) return v;
  const w = get(g, "labelPosition");
  return w === M ? undefined : w;
}

export function resolveLabelPosition(value: unknown): {
  position: LabelPosition;
  warning?: string;
} {
  if (value === "bottom-right" || value === "top-left") {
    return { position: value };
  }
  return {
    position: "bottom-right",
    ...(value !== undefined && {
      warning:
        "Invalid piVim.labelPosition; expected bottom-right or top-left.",
    }),
  };
}

export function readPiVimCursorShapeSetting(g: unknown, p: unknown) {
  // Visual-only, whole-setting override: absent/invalid project keys use
  // defaults, not the global map (the same policy as modeColors).
  const v = get(p, "cursorShape");
  if (v !== M) return v;
  const w = get(g, "cursorShape");
  return w === M ? undefined : w;
}

export function resolveCursorShapeSettings(value: unknown): {
  settings: CursorShapeSettings;
  warning?: string;
} {
  const settings = { ...DEFAULT_CURSOR_SHAPE_SETTINGS };
  if (value === undefined) return { settings };
  if (!rec(value)) {
    return {
      settings,
      warning: "Invalid piVim.cursorShape; expected an object.",
    };
  }
  const invalid: string[] = [];
  for (const key of MC) {
    if (!Object.hasOwn(value, key)) continue;
    const shape = value[key];
    if (
      shape === "block" ||
      shape === "underline" ||
      shape === "bar" ||
      shape === "steady-block" ||
      shape === "steady-underline" ||
      shape === "steady-bar"
    ) {
      settings[key] = shape;
    } else {
      invalid.push(key);
    }
  }
  return {
    settings,
    ...(invalid.length > 0 && {
      warning: `Invalid piVim.cursorShape ${invalid.join(", ")}; expected block, underline, bar, steady-block, steady-underline, or steady-bar.`,
    }),
  };
}

export function readPiVimModeColors(g: unknown, p: unknown) {
  const v = get(p, "modeColors");
  // Project settings are a whole-setting override. If a project checks in an
  // invalid modeColors value, fall back to pi-vim defaults instead of leaking a
  // developer's global colors into that project.
  if (v !== M) return colors(v);
  const w = get(g, "modeColors");
  return colors(w);
}

export function readPiVimHistoryNavigation(g: unknown, p: unknown) {
  // No capability grant: project settings override global, even if invalid.
  const v = get(p, "historyNavigation");
  const value = v === M ? get(g, "historyNavigation") : v;
  return value === M ? undefined : value;
}

export function resolveHistoryNavigation(value: unknown): {
  enabled: boolean;
  warning?: string;
} {
  if (typeof value === "boolean") return { enabled: value };
  return {
    enabled: true,
    ...(value !== undefined && {
      warning: "Invalid piVim.historyNavigation; expected a boolean.",
    }),
  };
}

export function readPiVimScrollKeys(g: unknown, p: unknown) {
  const v = get(p, "scrollKeys");
  const value = v === M ? get(g, "scrollKeys") : v;
  return value === M ? undefined : value;
}

export function resolveScrollKeys(value: unknown): {
  enabled: boolean;
  warning?: string;
} {
  if (typeof value === "boolean") return { enabled: value };
  return {
    enabled: false,
    ...(value !== undefined && {
      warning: "Invalid piVim.scrollKeys; expected a boolean.",
    }),
  };
}

export function readPiVimModeChange(g: unknown, p: unknown) {
  void p;
  // modeChange executes a shell command, so only the user-global settings file
  // is trusted. Project settings may be checked into a repo; treating them as
  // executable hook config would let a checkout run arbitrary commands when the
  // editor changes mode.
  const v = get(g, "modeChange");
  return modeChange(v);
}

export function readPiVimBorderSyncSetting(
  g: unknown,
  p: unknown,
): BorderSyncMode | undefined {
  const read = (v: unknown): BorderSyncMode | undefined =>
    v === "inherit" || v === true || v === false ? v : undefined;
  const v = get(p, "syncBorderColorWithMode");
  if (v !== M) return read(v);
  return read(get(g, "syncBorderColorWithMode"));
}

export function readPiVimBorderSync(
  g: unknown,
  p: unknown,
): SurfaceSyncMap | undefined {
  // Project settings are a whole-setting override (as with modeColors): a
  // present project value wins even if invalid, so its global counterpart never
  // leaks through.
  const v = get(p, "borderSync");
  if (v !== M) return surfaceMap(v, BORDER_SYNC_DEFAULT);
  return surfaceMap(get(g, "borderSync"), BORDER_SYNC_DEFAULT);
}

export function readPiVimLabelSync(
  g: unknown,
  p: unknown,
): SurfaceSyncMap | undefined {
  const v = get(p, "labelSync");
  if (v !== M) return surfaceMap(v, LABEL_SYNC_DEFAULT);
  return surfaceMap(get(g, "labelSync"), LABEL_SYNC_DEFAULT);
}

// Collapses the two new per-mode maps and the deprecated legacy key into the
// two full maps pi-vim paints with. A present new map wins over the legacy key
// for its surface; otherwise the legacy value is translated:
//   - `true`      → borderSync all "mode"        (label stays default "mode")
//   - `"inherit"` → borderSync/labelSync all "thinking"
//   - `false`/absent → both maps at their defaults ("host" / "mode")
export function resolveSurfaceSyncMaps(settings: {
  borderSync?: SurfaceSyncMap;
  labelSync?: SurfaceSyncMap;
  syncBorderColorWithMode?: BorderSyncMode;
}): { borderSync: SurfaceSyncMap; labelSync: SurfaceSyncMap } {
  const legacy = settings.syncBorderColorWithMode;
  const borderSync =
    settings.borderSync ??
    (legacy === true
      ? fill("mode")
      : legacy === "inherit"
        ? fill("thinking")
        : fill(BORDER_SYNC_DEFAULT));
  const labelSync =
    settings.labelSync ??
    (legacy === "inherit" ? fill("thinking") : fill(LABEL_SYNC_DEFAULT));
  return { borderSync, labelSync };
}

function disk(cwd: string): PiVimSettings {
  const s = SettingsManager.create(cwd),
    g = s.getGlobalSettings(),
    p = s.getProjectSettings();
  return {
    clipboardMirror: readPiVimClipboardMirrorSetting(g, p),
    exCommand: readPiVimExCommandSetting(g, p),
    globalExCommand: readPiVimGlobalExCommandSetting(g, p),
    modeColors: readPiVimModeColors(g, p),
    historyNavigation: readPiVimHistoryNavigation(g, p),
    scrollKeys: readPiVimScrollKeys(g, p),
    labelPosition: readPiVimLabelPositionSetting(g, p),
    cursorShape: readPiVimCursorShapeSetting(g, p),
    modeChange: readPiVimModeChange(g, p),
    borderSync: readPiVimBorderSync(g, p),
    labelSync: readPiVimLabelSync(g, p),
    syncBorderColorWithMode: readPiVimBorderSyncSetting(g, p),
  };
}

let reader = disk;
export function readPiVimSettings(cwd: string) {
  return reader(cwd);
}
export function setPiVimSettingsReaderForTests(next: typeof disk) {
  const prev = reader;
  reader = next;
  return () => {
    reader = prev;
  };
}
