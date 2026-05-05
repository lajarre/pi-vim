import { SettingsManager } from "@mariozechner/pi-coding-agent";

export type ClipboardMirrorPolicy = "all" | "yank" | "never";
export type RegisterWriteSource = "mutation" | "yank";

export const DEFAULT_CLIPBOARD_MIRROR_POLICY: ClipboardMirrorPolicy = "all";

export type ModeColorSettings = {
  insert?: string;
  normal?: string;
  ex?: string;
};

export type PiVimSettings = {
  clipboardMirror?: unknown;
  modeIndicatorColors?: ModeColorSettings;
  inputBorderModeColors?: ModeColorSettings;
  syncBorderColorWithMode?: boolean;
};

type ModeColorSettingsKey = "modeIndicatorColors" | "inputBorderModeColors";
type UnknownRecord = Record<string, unknown>;

const missing = Symbol();

function formatInvalid(value: unknown) {
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  try {
    return `${JSON.stringify(value) ?? type} (type ${type})`;
  } catch {
    return `(type ${type})`;
  }
}

function readPiVimSetting(settings: unknown, key: string): unknown {
  if (typeof settings !== "object" || settings === null || !Object.hasOwn(settings, "piVim")) return missing;
  const piVim = (settings as UnknownRecord).piVim;
  if (typeof piVim !== "object" || piVim === null || Array.isArray(piVim)) return piVim;
  return Object.hasOwn(piVim, key) ? (piVim as UnknownRecord)[key] : missing;
}

function readSetting(settings: unknown): unknown {
  return readPiVimSetting(settings, "clipboardMirror");
}

function normalizeColorSetting(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
  if (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(trimmed)) return trimmed;
  return undefined;
}

function readModeColorSettings(value: unknown): ModeColorSettings | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const colors = value as UnknownRecord;
  const result: ModeColorSettings = {};
  const insert = normalizeColorSetting(colors.insert);
  const normal = normalizeColorSetting(colors.normal);
  const ex = normalizeColorSetting(colors.ex);

  if (insert) result.insert = insert;
  if (normal) result.normal = normal;
  if (ex) result.ex = ex;

  return result.insert || result.normal || result.ex ? result : undefined;
}

export function resolveClipboardMirrorPolicy(value: unknown) {
  if (value === undefined) return { policy: DEFAULT_CLIPBOARD_MIRROR_POLICY };

  if (typeof value === "string") {
    const policy = value.trim().toLowerCase();
    if (policy === "all" || policy === "yank" || policy === "never") {
      return { policy: policy as ClipboardMirrorPolicy };
    }
  }

  return {
    policy: DEFAULT_CLIPBOARD_MIRROR_POLICY,
    warning: `Invalid piVim.clipboardMirror ${formatInvalid(value)}; expected all, yank, never. Using all.`,
  };
}

export function readPiVimClipboardMirrorSetting(globalSettings: unknown, projectSettings: unknown): unknown | undefined {
  const project = readSetting(projectSettings);
  if (project !== missing) return project;
  const global = readSetting(globalSettings);
  return global === missing ? undefined : global;
}

export function readPiVimModeColorSettings(
  globalSettings: unknown,
  projectSettings: unknown,
  key: ModeColorSettingsKey,
): ModeColorSettings | undefined {
  const globalRaw = readPiVimSetting(globalSettings, key);
  const projectRaw = readPiVimSetting(projectSettings, key);
  const globalColors = globalRaw === missing ? undefined : readModeColorSettings(globalRaw);
  const projectColors = projectRaw === missing ? undefined : readModeColorSettings(projectRaw);
  const merged = { ...globalColors, ...projectColors };

  return merged.insert || merged.normal || merged.ex ? merged : undefined;
}

export function readPiVimBooleanSetting(
  globalSettings: unknown,
  projectSettings: unknown,
  key: string,
): boolean | undefined {
  const project = readPiVimSetting(projectSettings, key);
  if (typeof project === "boolean") return project;
  if (project !== missing) return undefined;

  const global = readPiVimSetting(globalSettings, key);
  return typeof global === "boolean" ? global : undefined;
}

function readPiVimSettingsFromDisk(cwd: string): PiVimSettings {
  const settings = SettingsManager.create(cwd);
  const globalSettings = settings.getGlobalSettings();
  const projectSettings = settings.getProjectSettings();

  return {
    clipboardMirror: readPiVimClipboardMirrorSetting(globalSettings, projectSettings),
    modeIndicatorColors: readPiVimModeColorSettings(globalSettings, projectSettings, "modeIndicatorColors"),
    inputBorderModeColors: readPiVimModeColorSettings(globalSettings, projectSettings, "inputBorderModeColors"),
    syncBorderColorWithMode: readPiVimBooleanSetting(globalSettings, projectSettings, "syncBorderColorWithMode"),
  };
}

let piVimSettingsReader = readPiVimSettingsFromDisk;

export function readPiVimSettings(cwd: string) {
  return piVimSettingsReader(cwd);
}

export function setPiVimSettingsReaderForTests(reader: typeof readPiVimSettingsFromDisk) {
  const prev = piVimSettingsReader;
  piVimSettingsReader = reader;

  return () => {
    piVimSettingsReader = prev;
  };
}
