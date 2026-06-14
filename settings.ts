import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ModeColorSettings = {
  insert?: string;
  normal?: string;
  ex?: string;
};

export type ModeChangeSettings = {
  insert?: string;
  normal?: string;
};

export type PiVimSettings = {
  clipboardMirror?: unknown;
  modeColors?: ModeColorSettings;
  modeChange?: ModeChangeSettings;
  syncBorderColorWithMode?: boolean;
};

const M = Symbol(),
  C = ["insert", "normal", "ex"] as const,
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

export function readPiVimModeColors(g: unknown, p: unknown) {
  const v = get(p, "modeColors");
  // Project settings are a whole-setting override. If a project checks in an
  // invalid modeColors value, fall back to pi-vim defaults instead of leaking a
  // developer's global colors into that project.
  if (v !== M) return colors(v);
  const w = get(g, "modeColors");
  return colors(w);
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

export function readPiVimBooleanSetting(
  g: unknown,
  p: unknown,
  k: "syncBorderColorWithMode",
) {
  const v = get(p, k);
  if (v !== M) return typeof v === "boolean" ? v : undefined;
  const w = get(g, k);
  return typeof w === "boolean" ? w : undefined;
}

/**
 * Parse only the `piVim` block from a YAML config file without a full YAML
 * parser dependency.  The pi-vim settings block is a shallow object with one
 * optional nested object (`modeColors`, `modeChange`); that restricted shape
 * is all we need to handle.
 *
 * Supports both config.yml (omp/pi-tui) and settings.json (legacy) formats.
 */
function parsePiVimFromYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split("\n");
  let inPiVim = false;
  let piVimObj: Record<string, unknown> = {};
  let nestedKey: string | null = null;
  let nestedObj: Record<string, unknown> = {};

  for (const line of lines) {
    // Top-level key — ends piVim block
    if (/^[a-zA-Z]/.test(line) && !line.startsWith("  ")) {
      if (inPiVim) {
        if (nestedKey && Object.keys(nestedObj).length)
          piVimObj[nestedKey] = nestedObj;
        result.piVim = piVimObj;
        inPiVim = false;
        piVimObj = {};
        nestedKey = null;
        nestedObj = {};
      }
      if (line.startsWith("piVim:")) inPiVim = true;
      continue;
    }

    if (!inPiVim) continue;

    // Nested object key (e.g. "  modeColors:")
    const nested = line.match(/^  (\w+):\s*$/);
    if (nested) {
      if (nestedKey && Object.keys(nestedObj).length)
        piVimObj[nestedKey] = nestedObj;
      nestedKey = nested[1];
      nestedObj = {};
      continue;
    }

    // Nested value (e.g. "    insert: borderMuted")
    if (nestedKey) {
      const nv = line.match(/^    (\w+):\s*(.+)/);
      if (nv) {
        nestedObj[nv[1]] = nv[2].trim();
        continue;
      } else {
        // Exited nested block
        if (Object.keys(nestedObj).length) piVimObj[nestedKey] = nestedObj;
        nestedKey = null;
        nestedObj = {};
      }
    }

    // Top-level piVim scalar (e.g. "  clipboardMirror: all")
    const kv = line.match(/^  (\w+):\s*(.+)/);
    if (kv) {
      const val = kv[2].trim();
      piVimObj[kv[1]] =
        val === "true" ? true : val === "false" ? false : val;
    }
  }

  if (inPiVim) {
    if (nestedKey && Object.keys(nestedObj).length)
      piVimObj[nestedKey] = nestedObj;
    result.piVim = piVimObj;
  }

  return result;
}

function readConfigFile(filePath: string): unknown {
  try {
    if (!existsSync(filePath)) return {};
    const content = readFileSync(filePath, "utf8");
    // JSON settings file (legacy pi format)
    if (filePath.endsWith(".json")) {
      try {
        return JSON.parse(content);
      } catch {
        return {};
      }
    }
    return parsePiVimFromYaml(content);
  } catch {
    return {};
  }
}

/**
 * Return the global settings object.
 *
 * omp stores settings in `~/.omp/agent/config.yml`.
 * Legacy pi stored them in `~/.pi/agent/settings.json`.
 * We try both; omp wins when present.
 */
function globalSettings(): unknown {
  const ompConfig = join(homedir(), ".omp", "agent", "config.yml");
  const piConfig = join(homedir(), ".pi", "agent", "settings.json");
  const fromOmp = readConfigFile(ompConfig);
  if (rec(fromOmp) && Object.keys(fromOmp).length) return fromOmp;
  return readConfigFile(piConfig);
}

/**
 * Return the project-level settings object.
 *
 * omp checks `.omp/settings.yml`; legacy pi checked `.pi/settings.json`.
 */
function projectSettings(cwd: string): unknown {
  const ompProject = join(cwd, ".omp", "settings.yml");
  const piProject = join(cwd, ".pi", "settings.json");
  const fromOmp = readConfigFile(ompProject);
  if (rec(fromOmp) && Object.keys(fromOmp).length) return fromOmp;
  return readConfigFile(piProject);
}

function disk(cwd: string): PiVimSettings {
  const g = globalSettings();
  const p = projectSettings(cwd);
  return {
    clipboardMirror: readPiVimClipboardMirrorSetting(g, p),
    modeColors: readPiVimModeColors(g, p),
    modeChange: readPiVimModeChange(g, p),
    syncBorderColorWithMode: readPiVimBooleanSetting(
      g,
      p,
      "syncBorderColorWithMode",
    ),
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
