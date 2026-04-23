/**
 * Regression tests for the real clipboard helper process.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ModalEditor } from "../index.js";
import { stubKeybindings, stubTheme, stubTui } from "./harness.js";

type ClipboardHelperTestSeams = {
  setClipboardProcessEnv?: (env: NodeJS.ProcessEnv) => void;
  writeClipboardWithTimeout?: (text: string) => Promise<void>;
};

describe("clipboard helper", () => {
  it("resolves the Pi module even when the current working directory has no node_modules", async () => {
    const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
    const testEditor = editor as unknown as ClipboardHelperTestSeams;

    if (
      typeof testEditor.setClipboardProcessEnv !== "function"
      || typeof testEditor.writeClipboardWithTimeout !== "function"
    ) {
      assert.fail("clipboard helper test seams unavailable");
    }

    const emptyCwd = await mkdtemp(join(tmpdir(), "pi-vim-clipboard-helper-cwd-"));
    const originalCwd = process.cwd();

    const setClipboardProcessEnv = testEditor.setClipboardProcessEnv.bind(testEditor);
    const writeClipboardWithTimeout = testEditor.writeClipboardWithTimeout.bind(testEditor);

    setClipboardProcessEnv({
      ...process.env,
      PI_VIM_CLIPBOARD_SKIP_WRITE: "1",
    });

    process.chdir(emptyCwd);
    try {
      await assert.doesNotReject(writeClipboardWithTimeout("bonjour"));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rejects bootstrap failures instead of treating stdin EPIPE as success", async () => {
    const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
    const testEditor = editor as unknown as ClipboardHelperTestSeams;

    if (
      typeof testEditor.setClipboardProcessEnv !== "function"
      || typeof testEditor.writeClipboardWithTimeout !== "function"
    ) {
      assert.fail("clipboard helper test seams unavailable");
    }

    const setClipboardProcessEnv = testEditor.setClipboardProcessEnv.bind(testEditor);
    const writeClipboardWithTimeout = testEditor.writeClipboardWithTimeout.bind(testEditor);

    setClipboardProcessEnv({
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --definitely-invalid-flag`.trim(),
    });

    await assert.rejects(
      writeClipboardWithTimeout("x".repeat(256 * 1024)),
      /clipboard helper failed with exit code/,
    );
  });
});
