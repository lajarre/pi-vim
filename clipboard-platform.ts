import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import { performance } from "node:perf_hooks";

const CLIPBOARD_READ_TIMEOUT_MS = 750;
const CLIPBOARD_READ_MAX_BUFFER_BYTES = 1024 * 1024;

export type ClipboardReadCommand = {
  command: string;
  args: string[];
};

export type ClipboardReadOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  canSpawnHelper?: () => boolean;
  now?: () => number;
  run?: (
    command: string,
    args: string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => Pick<SpawnSyncReturns<string>, "error" | "status" | "signal" | "stdout">;
};

export function getClipboardReadCommands(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ClipboardReadCommand[] {
  if (platform === "darwin") {
    return [{ command: "/usr/bin/pbpaste", args: [] }];
  }
  if (platform === "win32") {
    const script = "[Console]::Out.Write((Get-Clipboard -Raw))";
    const args = ["-NoProfile", "-NonInteractive", "-Command", script];
    return [
      { command: "powershell.exe", args },
      { command: "pwsh.exe", args },
    ];
  }
  if (env.TERMUX_VERSION) {
    return [{ command: "termux-clipboard-get", args: [] }];
  }
  return [
    { command: "wl-paste", args: ["--no-newline", "--type", "text"] },
    { command: "xclip", args: ["-selection", "clipboard", "-out"] },
    { command: "xsel", args: ["--clipboard", "--output"] },
  ];
}

export function readClipboardCommands(
  commands: ClipboardReadCommand[],
  { run = spawnSync, now = performance.now }: ClipboardReadOptions = {},
): string | null {
  // Explicit puts remain synchronous, but all fallback attempts share one
  // monotonic deadline. Never pass timeout=0 (Node interprets it as unbounded).
  const deadline = now() + CLIPBOARD_READ_TIMEOUT_MS;
  for (const { command, args } of commands) {
    const remainingMs = Math.floor(deadline - now());
    if (remainingMs <= 0) break;
    try {
      const result = run(command, args, {
        encoding: "utf8",
        maxBuffer: CLIPBOARD_READ_MAX_BUFFER_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: remainingMs,
        killSignal: "SIGKILL",
        windowsHide: true,
      });
      if (!result.error && result.status === 0 && !result.signal) {
        return result.stdout ?? "";
      }
    } catch {
      // Spawn/encoding failures are a failed read, not an editor exception.
    }
  }
  return null;
}
