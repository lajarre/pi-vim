import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ClipboardReadOptions,
  ClipboardSpawnError,
  type ClipboardWriteOptions,
  canSpawnJavaScriptHelper,
  createClipboardAbortError,
  getAbortError,
  getClipboardReadCommands,
  readClipboardCommands,
  spawnClipboardWrite,
  writeClipboardWithPlatformCommands,
} from "./clipboard-platform.js";

export {
  type ClipboardReadCommand,
  canSpawnJavaScriptHelper,
  getClipboardReadCommands,
} from "./clipboard-platform.js";

const PI_NATIVE_CLIPBOARD_TIMEOUT_MS = 5000;
const CLIPBOARD_WRITE_TIMEOUT_MS = PI_NATIVE_CLIPBOARD_TIMEOUT_MS + 500;
const CLIPBOARD_SPAWN_FAILURE_LIMIT = 3;

export type ClipboardWriteFn = (
  text: string,
  signal: AbortSignal,
) => Promise<void>;
export type ClipboardReadFn = () => string | null;

type ClipboardCircuitBreaker = {
  consecutiveEnvironmentFailures: number;
  disabled: boolean;
};

const processClipboardCircuitBreaker: ClipboardCircuitBreaker = {
  consecutiveEnvironmentFailures: 0,
  disabled: false,
};

function resetClipboardCircuitBreaker(): void {
  processClipboardCircuitBreaker.consecutiveEnvironmentFailures = 0;
  processClipboardCircuitBreaker.disabled = false;
}

type SpawnErrnoLike = Error & { code?: unknown; syscall?: unknown };

function isNodeSpawnErrno(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const candidate = error as SpawnErrnoLike;
  return (
    typeof candidate.code === "string" &&
    candidate.code.length > 0 &&
    typeof candidate.syscall === "string" &&
    candidate.syscall.startsWith("spawn")
  );
}

function isClipboardEnvironmentFailure(error: unknown): boolean {
  return error instanceof ClipboardSpawnError || isNodeSpawnErrno(error);
}

function tryResolvePiCodingAgentModuleUrl(): string | undefined {
  try {
    return import.meta.resolve("@earendil-works/pi-coding-agent");
  } catch {
    try {
      const cliPath = process.argv[1];
      if (!cliPath || !existsSync(cliPath)) return undefined;

      let distDir = dirname(realpathSync(cliPath));
      if (basename(distDir) === "bundle") distDir = dirname(distDir);
      const modulePath = join(distDir, "index.js");

      if (
        basename(distDir) === "dist" &&
        basename(dirname(distDir)) === "pi-coding-agent" &&
        existsSync(modulePath)
      ) {
        return pathToFileURL(modulePath).href;
      }
    } catch {
      // Compiled runtimes may expose virtual entrypoints through existsSync()
      // that cannot be resolved through the host filesystem.
    }
    return undefined;
  }
}

const CLIPBOARD_HELPER_COPY_FAILED_EXIT_CODE = 2;

type ClipboardHelperSources = {
  read: string;
  write: string;
};

let clipboardHelperSources: ClipboardHelperSources | null | undefined;

export function buildClipboardWriteHelperSource(moduleUrl: string): string {
  return `
import { copyToClipboard } from ${JSON.stringify(moduleUrl)};

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
}

try {
  await Promise.resolve(copyToClipboard(Buffer.concat(chunks).toString("utf8")));
} catch {
  process.exitCode = ${CLIPBOARD_HELPER_COPY_FAILED_EXIT_CODE};
}
`;
}

export function buildClipboardReadHelperSource(moduleUrl: string): string {
  return `
import { createRequire } from "node:module";

const require = createRequire(${JSON.stringify(moduleUrl)});
const clipboard = require("@mariozechner/clipboard");
if (!await clipboard.hasText()) {
  process.exit(0);
}
const text = await clipboard.getText();
if (typeof text === "string") {
  process.stdout.write(text);
}
`;
}

function getClipboardHelperSources(): ClipboardHelperSources | null {
  if (clipboardHelperSources !== undefined) return clipboardHelperSources;

  const moduleUrl = tryResolvePiCodingAgentModuleUrl();
  clipboardHelperSources = moduleUrl
    ? {
        read: buildClipboardReadHelperSource(moduleUrl),
        write: buildClipboardWriteHelperSource(moduleUrl),
      }
    : null;
  return clipboardHelperSources;
}

export function readClipboardInChildProcess(
  options: ClipboardReadOptions = {},
): string | null {
  if (!(options.canSpawnHelper ?? canSpawnJavaScriptHelper)()) {
    return readClipboardCommands(
      getClipboardReadCommands(options.platform, options.env),
      options,
    );
  }

  const helperSources = getClipboardHelperSources();
  if (!helperSources) return null;
  return readClipboardCommands(
    [
      {
        command: process.execPath,
        args: ["--input-type=module", "-e", helperSources.read],
      },
    ],
    options,
  );
}

export async function writeClipboardInChildProcess(
  text: string,
  signal: AbortSignal,
  options: ClipboardWriteOptions = {},
): Promise<void> {
  if (signal.aborted) throw getAbortError(signal);
  if (!(options.canSpawnHelper ?? canSpawnJavaScriptHelper)()) {
    return writeClipboardWithPlatformCommands(text, signal, options);
  }
  const helperSources = getClipboardHelperSources();
  if (!helperSources)
    throw new ClipboardSpawnError("clipboard helper module unavailable");
  return spawnClipboardWrite(
    {
      command: process.execPath,
      args: ["--input-type=module", "-e", helperSources.write],
    },
    text,
    signal,
    options,
    true,
  );
}

export class ClipboardMirror {
  private activeController: AbortController | null = null;
  private activeText: string | null = null;
  private draining = false;
  private pendingText: string | null = null;
  private lastWriteFailedFlag = false;

  constructor(
    private writeFn: ClipboardWriteFn,
    private timeoutMs: number = CLIPBOARD_WRITE_TIMEOUT_MS,
    private readonly circuitBreaker: ClipboardCircuitBreaker = processClipboardCircuitBreaker,
  ) {}

  setWriteFn(writeFn: ClipboardWriteFn): void {
    this.activeController?.abort(
      createClipboardAbortError("clipboard writer replaced"),
    );
    this.writeFn = writeFn;
    // Deliberately keep lastWriteFailedFlag: swapping the writer does not
    // change whether the OS clipboard is stale relative to the register;
    // only a landed mirror write clears the flag.
    resetClipboardCircuitBreaker();
  }

  setTimeoutMs(timeoutMs: number): void {
    this.timeoutMs = Math.max(0, timeoutMs);
  }

  hasPendingWrite(): boolean {
    return (
      this.activeText !== null || this.pendingText !== null || this.draining
    );
  }

  lastWriteFailed(): boolean {
    return this.lastWriteFailedFlag;
  }

  mirror(text: string): void {
    if (this.circuitBreaker.disabled) {
      this.lastWriteFailedFlag = true;
      return;
    }

    this.pendingText = text;

    if (!this.draining) {
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      while (this.pendingText !== null && !this.circuitBreaker.disabled) {
        const text = this.pendingText;
        this.pendingText = null;
        const controller = new AbortController();
        this.activeController = controller;
        this.activeText = text;

        try {
          await this.writeWithTimeout(text, controller);
          this.circuitBreaker.consecutiveEnvironmentFailures = 0;
          this.lastWriteFailedFlag = false;
        } catch (error) {
          this.recordWriteFailure(error);
        } finally {
          if (this.activeController === controller) {
            this.activeController = null;
          }
          this.activeText = null;
        }
      }

      if (this.circuitBreaker.disabled && this.pendingText !== null) {
        this.pendingText = null;
        this.lastWriteFailedFlag = true;
      }
    } finally {
      this.draining = false;
      if (this.pendingText !== null && !this.circuitBreaker.disabled) {
        void this.drain();
      }
    }
  }

  private recordWriteFailure(error: unknown): void {
    this.lastWriteFailedFlag = true;
    if (!isClipboardEnvironmentFailure(error)) {
      this.circuitBreaker.consecutiveEnvironmentFailures = 0;
      return;
    }

    this.circuitBreaker.consecutiveEnvironmentFailures += 1;
    if (
      this.circuitBreaker.consecutiveEnvironmentFailures >=
      CLIPBOARD_SPAWN_FAILURE_LIMIT
    ) {
      this.circuitBreaker.disabled = true;
      this.pendingText = null;
    }
  }

  private async writeWithTimeout(
    text: string,
    controller: AbortController,
  ): Promise<void> {
    const timeoutError = createClipboardAbortError("clipboard write timed out");
    const timeoutId = setTimeout(() => {
      controller.abort(timeoutError);
    }, this.timeoutMs);

    try {
      await this.writeFn(text, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw getAbortError(controller.signal);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
