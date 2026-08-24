import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PI_NATIVE_CLIPBOARD_TIMEOUT_MS = 5000;
const CLIPBOARD_WRITE_TIMEOUT_MS = PI_NATIVE_CLIPBOARD_TIMEOUT_MS + 500;
const CLIPBOARD_SPAWN_FAILURE_LIMIT = 3;
const CLIPBOARD_READ_TIMEOUT_MS = 750;
const CLIPBOARD_READ_MAX_BUFFER_BYTES = 1024 * 1024;

export type ClipboardWriteFn = (
  text: string,
  signal: AbortSignal,
) => Promise<void>;
export type ClipboardReadFn = () => string | null;
type ClipboardProcess = ReturnType<typeof spawn>;

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

class ClipboardSpawnError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClipboardSpawnError";
  }
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

function resolvePiCodingAgentModuleUrl(): string {
  try {
    return import.meta.resolve("@earendil-works/pi-coding-agent");
  } catch (resolveError) {
    const cliPath = process.argv[1];
    if (cliPath && existsSync(cliPath)) {
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
    }
    throw resolveError;
  }
}

const PI_CODING_AGENT_MODULE_URL = resolvePiCodingAgentModuleUrl();
const CLIPBOARD_HELPER_COPY_FAILED_EXIT_CODE = 2;
const CLIPBOARD_HELPER_SOURCE = `
import { copyToClipboard } from ${JSON.stringify(PI_CODING_AGENT_MODULE_URL)};

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

const CLIPBOARD_READ_HELPER_SOURCE = `
import { createRequire } from "node:module";

const require = createRequire(${JSON.stringify(PI_CODING_AGENT_MODULE_URL)});
const clipboard = require("@mariozechner/clipboard");
if (!await clipboard.hasText()) {
  process.exit(0);
}
const text = await clipboard.getText();
if (typeof text === "string") {
  process.stdout.write(text);
}
`;

export function readClipboardInChildProcess(): string | null {
  try {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", CLIPBOARD_READ_HELPER_SOURCE],
      {
        encoding: "utf8",
        maxBuffer: CLIPBOARD_READ_MAX_BUFFER_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: CLIPBOARD_READ_TIMEOUT_MS,
        windowsHide: true,
      },
    );

    if (result.error || result.status !== 0 || result.signal) return null;
    return result.stdout ?? "";
  } catch {
    return null;
  }
}

function createClipboardAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function getAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : createClipboardAbortError("clipboard write aborted");
}

function killClipboardProcess(child: ClipboardProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;

  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
}

export function writeClipboardInChildProcess(
  text: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(getAbortError(signal));
      return;
    }

    let child: ClipboardProcess | null = null;
    let settled = false;
    const stdoutChunks: Buffer[] = [];

    function finish(error?: unknown): void {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }

    function onAbort(): void {
      if (child) {
        killClipboardProcess(child);
      }
      finish(getAbortError(signal));
    }

    try {
      child = spawn(
        process.execPath,
        ["--input-type=module", "-e", CLIPBOARD_HELPER_SOURCE],
        {
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        },
      );
    } catch (error) {
      finish(
        new ClipboardSpawnError("clipboard helper spawn failed", {
          cause: error,
        }),
      );
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    child.stdout?.on("error", (error) => {
      finish(error);
    });

    child.once("error", (error) => {
      finish(
        new ClipboardSpawnError("clipboard helper spawn failed", {
          cause: error,
        }),
      );
    });

    child.once("close", (code) => {
      if (settled) return;

      if (signal.aborted) {
        finish(getAbortError(signal));
        return;
      }

      if (code === 0) {
        try {
          for (const chunk of stdoutChunks) {
            process.stdout.write(chunk);
          }
        } catch (error) {
          finish(error);
          return;
        }
        finish();
        return;
      }

      // Exit code 2 means the helper ran but the copy itself failed; that is
      // a clipboard-backend failure, not an environment failure, so it must
      // not count toward the spawn circuit breaker.
      if (code === CLIPBOARD_HELPER_COPY_FAILED_EXIT_CODE) {
        finish(new Error("clipboard helper reported a failed copy"));
        return;
      }

      finish(
        new ClipboardSpawnError(
          `clipboard helper failed with exit code ${code ?? "null"}`,
        ),
      );
    });

    if (!child.stdin) {
      killClipboardProcess(child);
      finish(new ClipboardSpawnError("clipboard helper stdin unavailable"));
      return;
    }

    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (signal.aborted) {
        finish(getAbortError(signal));
        return;
      }

      if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") {
        return;
      }

      finish(error);
    });

    try {
      child.stdin.end(text);
    } catch (error) {
      finish(error);
    }
  });
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
