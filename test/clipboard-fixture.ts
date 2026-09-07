import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { ClipboardMirror } from "../clipboard-mirror.js";
import type { ClipboardWriteOptions } from "../clipboard-platform.js";

export class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: NodeJS.Signals[] = [];
  input = "";
  autoCloseOnKill = true;

  constructor() {
    super();
    this.stdin.on("data", (chunk) => {
      this.input += chunk.toString("utf8");
    });
  }
  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    if (this.autoCloseOnKill) queueMicrotask(() => this.close(null, signal));
    return true;
  }
  close(code = 0 as number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }
}

export function fakeSpawner(
  onSpawn?: (child: FakeChild, index: number) => void,
) {
  const calls: Array<{
    command: string;
    args: string[];
    options: SpawnOptions;
    child: FakeChild;
  }> = [];
  const run: NonNullable<ClipboardWriteOptions["spawn"]> = (
    command,
    args,
    options,
  ) => {
    const child = new FakeChild();
    calls.push({ command, args, options, child });
    queueMicrotask(() => onSpawn?.(child, calls.length - 1));
    return child as unknown as ChildProcess;
  };
  return { calls, run };
}

export const flush = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

export async function drain(mirror: ClipboardMirror): Promise<void> {
  for (let i = 0; i < 100 && mirror.hasPendingWrite(); i++) await delay(2);
  assert.equal(mirror.hasPendingWrite(), false, "mirror must drain");
}

export const compiledWriter = {
  canSpawnHelper: () => false,
  platform: "darwin",
  env: {},
} satisfies ClipboardWriteOptions;
