import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import {
  buildClipboardWriteHelperSource,
  readClipboardInChildProcess,
  writeClipboardInChildProcess,
} from "../clipboard-mirror.js";
import {
  type ClipboardReadOptions,
  canSpawnJavaScriptHelper,
  getClipboardReadCommands,
} from "../clipboard-platform.js";
import { fakeSpawner } from "./clipboard-fixture.js";
import { createEditorWithSpy, sendKeys } from "./harness.js";

const success = (stdout: string) => ({ status: 0, signal: null, stdout });
const failure = () => ({ status: 1, signal: null, stdout: "untrusted" });
const standalone = {
  canSpawnHelper: () => false,
  env: {},
  now: () => 0,
} satisfies ClipboardReadOptions;

describe("clipboard transport reads (isolated; no host clipboard)", () => {
  for (const platform of ["linux", "win32"] as const) {
    it(`${platform} fallback commands share a monotonic 750ms budget`, () => {
      let elapsed = 12_000;
      const timeouts: number[] = [];
      const commands: string[] = [];
      const text = readClipboardInChildProcess({
        ...standalone,
        platform,
        now: () => elapsed,
        run: (command, _args, options) => {
          commands.push(command);
          timeouts.push(options.timeout ?? -1);
          elapsed += 300;
          return failure();
        },
      });
      assert.equal(text, null);
      assert.deepEqual(
        timeouts,
        platform === "linux" ? [750, 450, 150] : [750, 450],
      );
      assert.deepEqual(
        commands,
        getClipboardReadCommands(platform, {}).map((c) => c.command),
      );
    });

    it(`${platform} starts no fallback after exhausting the budget`, () => {
      let elapsed = 0;
      let attempts = 0;
      assert.equal(
        readClipboardInChildProcess({
          ...standalone,
          platform,
          now: () => elapsed,
          run: () => {
            attempts++;
            elapsed += 750;
            return failure();
          },
        }),
        null,
      );
      assert.equal(attempts, 1);
    });
  }

  it("never passes a sub-millisecond remainder as an unbounded zero timeout", () => {
    const times = [0, 749.1];
    assert.equal(
      readClipboardInChildProcess({
        ...standalone,
        platform: "linux",
        now: () => times.shift() ?? 750,
        run: () => assert.fail("expired read must not spawn"),
      }),
      null,
    );
  });

  it("catches thrown spawn failures and falls back within the remaining budget", () => {
    let calls = 0;
    assert.equal(
      readClipboardInChildProcess({
        ...standalone,
        platform: "linux",
        run: () => {
          if (++calls === 1) throw new Error("spawn unavailable");
          return success("fallback");
        },
      }),
      "fallback",
    );
    assert.equal(calls, 2);
  });

  for (const [name, result] of [
    ["nonzero", failure()],
    ["signal", { ...success("bad"), signal: "SIGKILL" }],
    [
      "max-buffer",
      {
        ...success("bad"),
        error: Object.assign(new Error(), { code: "ENOBUFS" }),
      },
    ],
    [
      "timeout",
      {
        ...success("bad"),
        error: Object.assign(new Error(), { code: "ETIMEDOUT" }),
      },
    ],
    [
      "spawn",
      {
        ...success("bad"),
        error: Object.assign(new Error(), { code: "ENOENT" }),
      },
    ],
  ] as const) {
    it(`maps ${name} to null, never partial stdout`, () => {
      assert.equal(
        readClipboardInChildProcess({
          ...standalone,
          platform: "darwin",
          run: () => result,
        }),
        null,
      );
    });
  }

  for (const [platform, env, command, args] of [
    ["darwin", {}, "/usr/bin/pbpaste", []],
    ["linux", { TERMUX_VERSION: "1" }, "termux-clipboard-get", []],
    [
      "linux",
      { WAYLAND_DISPLAY: "wayland-0" },
      "wl-paste",
      ["--no-newline", "--type", "text"],
    ],
    ["win32", {}, "powershell.exe", undefined],
  ] as const) {
    for (const value of ["", "λ café 日本語 👩🏽‍💻\n"]) {
      it(`${command} preserves successful ${value ? "Unicode" : "empty"} reads and bounded spawn options`, () => {
        let calls = 0;
        assert.equal(
          readClipboardInChildProcess({
            ...standalone,
            platform,
            env,
            run: (actualCommand, actualArgs, options) => {
              calls++;
              assert.equal(actualCommand, command);
              if (args) assert.deepEqual(actualArgs, args);
              assert.deepEqual(options, {
                encoding: "utf8",
                maxBuffer: 1024 * 1024,
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 750,
                killSignal: "SIGKILL",
                windowsHide: true,
              });
              return success(value);
            },
          }),
          value,
        );
        assert.equal(calls, 1);
      });
    }
  }

  it("X11 tries xclip then xsel after unavailable Wayland", () => {
    const calls: string[] = [];
    assert.equal(
      readClipboardInChildProcess({
        ...standalone,
        platform: "linux",
        env: { DISPLAY: ":0" },
        run: (command, args) => {
          calls.push(command);
          if (command !== "xsel") return failure();
          assert.deepEqual(args, ["--clipboard", "--output"]);
          return success("X11");
        },
      }),
      "X11",
    );
    assert.deepEqual(calls, ["wl-paste", "xclip", "xsel"]);
  });

  it("both PowerShell candidates explicitly emit non-ASCII text as BOM-free UTF-8", () => {
    const text = "café 日本語 👩🏽‍💻\n";
    for (const selected of ["powershell.exe", "pwsh.exe"]) {
      const result = readClipboardInChildProcess({
        ...standalone,
        platform: "win32",
        run: (command, args, options) => {
          assert.deepEqual(args.slice(0, 3), [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
          ]);
          const script = args[3];
          assert.equal(
            script,
            "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Out.Write((Get-Clipboard -Raw))",
          );
          if (command !== selected) return failure();
          // Model Windows PowerShell's legacy output encoding unless the command
          // explicitly sets it; no actual Windows process or host clipboard.
          const encoding = script.includes(
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
          )
            ? "utf8"
            : "latin1";
          return success(
            Buffer.from(text, encoding).toString(options.encoding),
          );
        },
      });
      assert.equal(result, text);
      assert.equal(result?.startsWith("\uFEFF"), false);
    }
  });

  it("ordinary Node keeps the Pi-owned read helper", () => {
    assert.equal(
      readClipboardInChildProcess({
        ...standalone,
        canSpawnHelper: () => true,
        run: (command, args) => {
          assert.equal(command, process.execPath);
          assert.deepEqual(args.slice(0, 2), ["--input-type=module", "-e"]);
          assert.match(args[2], /createRequire/);
          assert.match(args[2], /@mariozechner\/clipboard/);
          return success("from helper");
        },
      }),
      "from helper",
    );
  });

  it("read deadline failure preserves unnamed shadow, cursor, mode and undo", async () => {
    const { editor, clipboardWrites } = createEditorWithSpy("foo bar");
    sendKeys(editor, ["y", "w"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    let elapsed = 0;
    let attempts = 0;
    editor.setClipboardReadFn(() =>
      readClipboardInChildProcess({
        ...standalone,
        platform: "linux",
        now: () => elapsed,
        run: () => {
          attempts++;
          elapsed += 750;
          throw new Error("backend hung");
        },
      }),
    );
    sendKeys(editor, ["p"]);
    assert.equal(attempts, 1);
    assert.equal(editor.getText(), "ffoo oo bar");
    assert.equal(editor.getRegister(), "foo ");
    assert.equal(editor.getMode(), "normal");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
    assert.deepEqual(clipboardWrites, ["foo "]);
    sendKeys(editor, ["u"]);
    assert.equal(editor.getText(), "foo bar");
  });
});

describe("clipboard runtime detection", () => {
  it("uses documented node:sea.isSea without process.features flags", () => {
    let checks = 0;
    assert.equal(
      canSpawnJavaScriptHelper({}, () => ({
        isSea: () => {
          checks++;
          return true;
        },
      })),
      false,
    );
    assert.equal(checks, 1);
    assert.equal(
      canSpawnJavaScriptHelper({}, () => ({ isSea: () => false })),
      true,
    );
    assert.equal(
      canSpawnJavaScriptHelper(),
      true,
      "this test runs in ordinary Node",
    );
  });
  it("Bun never loads a potentially unsupported SEA builtin", () => {
    assert.equal(
      canSpawnJavaScriptHelper({ bun: "1.3" }, () =>
        assert.fail("Bun cannot reuse execPath"),
      ),
      false,
    );
  });
  it("older ordinary Node tolerates an absent SEA API", () => {
    assert.equal(
      canSpawnJavaScriptHelper({}, () => undefined),
      true,
    );
    assert.equal(
      canSpawnJavaScriptHelper({}, () => ({})),
      true,
    );
    assert.equal(
      canSpawnJavaScriptHelper({}, () => {
        throw Object.assign(new Error(), {
          code: "ERR_UNKNOWN_BUILTIN_MODULE",
        });
      }),
      true,
    );
  });
});

describe("ordinary Node clipboard helper boundary", () => {
  it("keeps Pi's copy helper and forwards its output only on successful close", async (t) => {
    for (const code of [0, 2, 1]) {
      const fixture = fakeSpawner((child) => {
        child.stdout.write("OSC52-from-Pi");
        child.close(code);
      });
      const output: string[] = [];
      const stdout = t.mock.method(
        process.stdout,
        "write",
        (chunk: string | Uint8Array) => {
          output.push(chunk.toString());
          return true;
        },
      );
      try {
        const write = writeClipboardInChildProcess(
          "payload",
          new AbortController().signal,
          { canSpawnHelper: () => true, spawn: fixture.run },
        );
        if (code)
          await assert.rejects(write, {
            name: code === 2 ? "Error" : "ClipboardSpawnError",
          });
        else await write;
        assert.deepEqual(output, code === 0 ? ["OSC52-from-Pi"] : []);
        assert.equal(fixture.calls[0]?.command, process.execPath);
        assert.match(fixture.calls[0]?.args[2] ?? "", /copyToClipboard/);
        assert.deepEqual(fixture.calls[0]?.options.stdio, [
          "pipe",
          "pipe",
          "ignore",
        ]);
      } finally {
        stdout.mock.restore();
      }
    }
  });

  it("real Pi-owned helper source transports non-ASCII via stdin without loading a native clipboard", async () => {
    const payload = "λ 日本語 👩🏽‍💻\n' $()";
    const mockModule = `data:text/javascript,${encodeURIComponent(`export function copyToClipboard(text) { if (text !== ${JSON.stringify(payload)}) throw new Error('bad stdin'); }`)}`;
    await writeClipboardInChildProcess(payload, new AbortController().signal, {
      canSpawnHelper: () => true,
      spawn: (_command, _args, options) =>
        spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            buildClipboardWriteHelperSource(mockModule),
          ],
          options,
        ),
    });
  });
});
