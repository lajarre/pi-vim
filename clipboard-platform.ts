import {
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawn,
  spawnSync,
} from "node:child_process";
import { createRequire } from "node:module";
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
    const script =
      "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Out.Write((Get-Clipboard -Raw))";
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
  { run = spawnSync, now = () => performance.now() }: ClipboardReadOptions = {},
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

export function canSpawnJavaScriptHelper(
  versions: { bun?: string } = process.versions as { bun?: string },
  loadSea: () => { isSea?: () => boolean } | undefined = () =>
    createRequire(import.meta.url)("node:sea"),
): boolean {
  if (versions.bun) return false;
  try {
    // Node documents sea.isSea(), not process.features.sea. Load lazily:
    // Bun and older runtimes need not implement this builtin at all.
    return loadSea()?.isSea?.() !== true;
  } catch {
    return true;
  }
}

export class ClipboardSpawnError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClipboardSpawnError";
  }
}

export function createClipboardAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function getAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : createClipboardAbortError("clipboard write aborted");
}

export type ClipboardWriteOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  canSpawnHelper?: () => boolean;
  spawn?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
};

export function getClipboardWriteCommands(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ClipboardReadCommand[] {
  if (platform === "darwin") return [{ command: "/usr/bin/pbcopy", args: [] }];
  if (platform === "win32") {
    const script =
      "$ErrorActionPreference = 'Stop'; [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())";
    const args = ["-NoProfile", "-NonInteractive", "-Command", script];
    return [
      { command: "powershell.exe", args },
      { command: "pwsh.exe", args },
    ];
  }
  const commands: ClipboardReadCommand[] = [];
  if (env.TERMUX_VERSION)
    commands.push({ command: "termux-clipboard-set", args: [] });
  if (env.WAYLAND_DISPLAY) commands.push({ command: "wl-copy", args: [] });
  if (env.DISPLAY)
    commands.push(
      { command: "xclip", args: ["-selection", "clipboard"] },
      { command: "xsel", args: ["--clipboard", "--input"] },
    );
  return commands;
}

// Shared child lifecycle; only the Pi-owned Node helper may forward stdout
// (its OSC52 fallback). Platform command output must never reach the TUI.
export function spawnClipboardWrite(
  { command, args }: ClipboardReadCommand,
  text: string,
  signal: AbortSignal,
  options: ClipboardWriteOptions,
  helper = false,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(getAbortError(signal));
      return;
    }
    let child: ChildProcess;
    try {
      child = (options.spawn ?? spawn)(command, args, {
        stdio: ["pipe", helper ? "pipe" : "ignore", "ignore"],
        windowsHide: true,
        ...(options.env ? { env: options.env } : {}),
      });
    } catch (cause) {
      reject(new ClipboardSpawnError("clipboard spawn failed", { cause }));
      return;
    }
    let failure: unknown;
    const chunks: Buffer[] = [];
    const stop = (error: unknown) => {
      failure = error;
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill("SIGKILL");
      } catch {
        /* close still owns settlement */
      }
    };
    const onAbort = () => stop(getAbortError(signal));
    child.once("error", (cause) => {
      failure = new ClipboardSpawnError("clipboard spawn failed", { cause });
    });
    child.once("close", (code, exitSignal) => {
      signal.removeEventListener("abort", onAbort);
      // Wait for close even on abort before permitting the next write: a killed
      // old child must not race the latest pending text onto the clipboard.
      if (signal.aborted) {
        reject(getAbortError(signal));
        return;
      }
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0 || exitSignal) {
        reject(
          helper && code !== 2
            ? new ClipboardSpawnError(
                `clipboard helper failed with exit code ${code ?? "null"}`,
              )
            : new Error("clipboard backend reported a failed copy"),
        );
        return;
      }
      try {
        for (const chunk of chunks) process.stdout.write(chunk);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    if (helper) {
      child.stdout?.on("data", (chunk: Buffer | string) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      child.stdout?.on("error", stop);
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    if (!child.stdin) {
      stop(new ClipboardSpawnError("clipboard stdin unavailable"));
      return;
    }
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // Early exit can close the pipe before stdin drains; close's exit status
      // distinguishes a successful copy from a failed command.
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED")
        stop(error);
    });
    try {
      child.stdin.end(text);
    } catch (error) {
      stop(error);
    }
  });
}

export async function writeClipboardWithPlatformCommands(
  text: string,
  signal: AbortSignal,
  options: ClipboardWriteOptions = {},
): Promise<void> {
  let failure: unknown = new ClipboardSpawnError(
    "clipboard commands unavailable",
  );
  for (const command of getClipboardWriteCommands(
    options.platform,
    options.env,
  )) {
    if (signal.aborted) throw getAbortError(signal);
    try {
      await spawnClipboardWrite(command, text, signal, options);
      return;
    } catch (error) {
      if (signal.aborted) throw getAbortError(signal);
      // Only all-environment failures may trip the spawn circuit breaker.
      // A command that ran but failed is a recoverable backend failure.
      if (
        failure instanceof ClipboardSpawnError ||
        !(error instanceof ClipboardSpawnError)
      )
        failure = error;
    }
  }
  if (signal.aborted) throw getAbortError(signal);
  throw failure;
}
