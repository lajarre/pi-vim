import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import {
  buildClipboardReadHelperSource,
  createClipboardModuleProbe,
  readClipboardInChildProcess,
} from "../clipboard-mirror.js";
import { createEditorWithSpy, sendKeys } from "./harness.js";

function missingModule(): never {
  throw Object.assign(new Error("missing clipboard module"), {
    code: "MODULE_NOT_FOUND",
  });
}

const success = (stdout: string) => ({ status: 0, signal: null, stdout });

describe("Node clipboard module availability", () => {
  for (const present of [true, false]) {
    it(`resolves from Pi once, caching ${present} across repeated puts`, async () => {
      const moduleUrls: string[] = [];
      const hasClipboardModule = createClipboardModuleProbe((moduleUrl) => {
        moduleUrls.push(moduleUrl);
        return present ? "legacy-module" : missingModule();
      });
      const commands: string[] = [];
      const { editor, clipboardWrites } = createEditorWithSpy("ab");
      sendKeys(editor, ["y", "w"]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      editor.setClipboardReadFn(() =>
        readClipboardInChildProcess({
          canSpawnHelper: () => true,
          hasClipboardModule,
          platform: "darwin",
          now: () => 0,
          run: (command, args, options) => {
            commands.push(command);
            assert.equal(options.timeout, 750);
            assert.equal(options.maxBuffer, 1024 * 1024);
            assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
            if (present) {
              assert.deepEqual(args.slice(0, 2), ["--input-type=module", "-e"]);
              assert.match(args[2], /@mariozechner\/clipboard/);
            } else assert.deepEqual(args, []);
            return success("x");
          },
        }),
      );
      sendKeys(editor, ["p", "p"]);
      assert.deepEqual(moduleUrls, [
        import.meta.resolve("@earendil-works/pi-coding-agent"),
      ]);
      assert.deepEqual(
        commands,
        Array(2).fill(present ? process.execPath : "/usr/bin/pbpaste"),
      );
      assert.equal(editor.getText(), "axxb");
      assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
      assert.equal(editor.getMode(), "normal");
      assert.equal(editor.getRegister(), "ab");
      assert.deepEqual(clipboardWrites, ["ab"]);
      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "axb");
      sendKeys(editor, ["\x12"]);
      assert.equal(editor.getText(), "axxb");
    });
  }

  it("standalone hosts never resolve a Node clipboard module", () => {
    let resolutions = 0;
    assert.equal(
      readClipboardInChildProcess({
        canSpawnHelper: () => false,
        hasClipboardModule: createClipboardModuleProbe(() => {
          resolutions++;
          return "legacy-module";
        }),
        platform: "darwin",
        run: (command) => {
          assert.equal(command, "/usr/bin/pbpaste");
          return success("standalone");
        },
      }),
      "standalone",
    );
    assert.equal(resolutions, 0, "standalone must bypass module resolution");
  });

  for (const env of [{}, { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }]) {
    it(`missing Node module preserves display gating and total deadline: ${JSON.stringify(env)}`, () => {
      let elapsed = 0;
      const commands: string[] = [];
      const timeouts: number[] = [];
      const text = readClipboardInChildProcess({
        canSpawnHelper: () => true,
        hasClipboardModule: createClipboardModuleProbe(missingModule),
        platform: "linux",
        env,
        now: () => elapsed,
        run: (command, _args, options) => {
          commands.push(command);
          timeouts.push(options.timeout ?? -1);
          elapsed += 400;
          return { status: 1, signal: null, stdout: "partial" };
        },
      });
      assert.equal(text, null);
      assert.deepEqual(commands, env.DISPLAY ? ["wl-paste", "xclip"] : []);
      assert.deepEqual(timeouts, env.DISPLAY ? [750, 350] : []);
    });
  }

  for (const result of ["", null]) {
    it(`Pi-specific empty/failure policy is unchanged on Node fallback (${JSON.stringify(result)})`, async () => {
      const { editor, clipboardWrites } = createEditorWithSpy("ab");
      sendKeys(editor, ["y", "y"]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      editor.setClipboardReadFn(() =>
        readClipboardInChildProcess({
          canSpawnHelper: () => true,
          hasClipboardModule: createClipboardModuleProbe(missingModule),
          platform: "darwin",
          run: () =>
            result === null
              ? { status: 1, signal: null, stdout: "untrusted" }
              : success(result),
        }),
      );
      sendKeys(editor, ["p"]);
      // Intentionally not Vim's unnamed-only put: a successful empty OS read
      // stays empty; an unavailable clipboard preserves the linewise shadow.
      assert.equal(editor.getText(), result === null ? "ab\nab" : "ab");
      assert.deepEqual(editor.getCursor(), {
        line: result === null ? 1 : 0,
        col: 0,
      });
      assert.equal(editor.getMode(), "normal");
      assert.equal(editor.getRegister(), "ab\n");
      assert.deepEqual(clipboardWrites, ["ab\n"]);
    });
  }

  it("real legacy helper fails on the dev host without the module; default reads select platform transport", (t) => {
    const moduleUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    try {
      createRequire(moduleUrl).resolve("@mariozechner/clipboard");
      t.skip(
        "dev host still ships @mariozechner/clipboard; Pi 1.x fallback is not applicable",
      );
      return;
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "MODULE_NOT_FOUND");
    }
    const legacy = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", buildClipboardReadHelperSource(moduleUrl)],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(legacy.error, undefined);
    assert.equal(legacy.status, 1);
    assert.match(
      legacy.stderr,
      /Cannot find module '@mariozechner\/clipboard'/,
    );
    let attempts = 0;
    const result = readClipboardInChildProcess({
      platform: "darwin",
      run: (command, args, options) => {
        attempts++;
        assert.equal(
          command,
          "/usr/bin/pbpaste",
          "must not launch the broken Node helper",
        );
        assert.deepEqual(args, []);
        // A real child delivers deterministic bytes without reading or changing
        // the developer's clipboard. Only the platform executable is replaced.
        return spawnSync(
          process.execPath,
          ["-e", 'process.stdout.write("λ 日本語\\n")'],
          options,
        );
      },
    });
    assert.equal(attempts, 1);
    assert.equal(result, "λ 日本語\n");
  });
});
