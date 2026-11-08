import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { getEventListeners, once } from "node:events";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  ClipboardMirror,
  writeClipboardInChildProcess,
} from "../clipboard-mirror.js";
import { getClipboardWriteCommands } from "../clipboard-platform.js";
import {
  compiledWriter,
  drain,
  FakeChild,
  fakeSpawner,
  flush,
} from "./clipboard-fixture.js";

describe("compiled clipboard async writes (isolated)", () => {
  const platforms = [
    ["darwin", {}, ["/usr/bin/pbcopy"]],
    ["win32", {}, ["powershell.exe", "pwsh.exe"]],
    ["linux", { WAYLAND_DISPLAY: "wayland-0" }, ["wl-copy"]],
    ["linux", { DISPLAY: ":0" }, ["xclip", "xsel"]],
    [
      "linux",
      { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      ["wl-copy", "xclip", "xsel"],
    ],
    ["linux", { TERMUX_VERSION: "1" }, ["termux-clipboard-set"]],
    [
      "linux",
      { TERMUX_VERSION: "1", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      ["termux-clipboard-set", "wl-copy", "xclip", "xsel"],
    ],
    ["linux", {}, []],
  ] as const;
  for (const [platform, env, commands] of platforms) {
    it(`${platform} ${JSON.stringify(env)} selects fixed candidates and falls through errors`, async () => {
      assert.deepEqual(
        getClipboardWriteCommands(platform, env).map((c) => c.command),
        commands,
      );
      const fixture = fakeSpawner((child, index) =>
        child.close(index === commands.length - 1 ? 0 : 1),
      );
      const payload = 'λ 日本語 👩🏽‍💻\n\'; $(not-a-command) & "x"\n';
      const options = { ...compiledWriter, platform, env, spawn: fixture.run };
      const write = writeClipboardInChildProcess(
        payload,
        new AbortController().signal,
        options,
      );
      if (!commands.length)
        await assert.rejects(write, { name: "ClipboardSpawnError" });
      else await write;
      assert.deepEqual(
        fixture.calls.map((c) => c.command),
        commands,
      );
      for (const { args, options: spawnOptions, child } of fixture.calls) {
        assert.equal(child.input, payload);
        assert.equal(
          args.some((arg) => arg.includes(payload)),
          false,
        );
        assert.deepEqual(spawnOptions, {
          stdio: ["pipe", "ignore", "ignore"],
          windowsHide: true,
          env,
        });
        assert.equal(child.stdout.listenerCount("data"), 0);
      }
    });
  }

  it("PowerShell writes decode UTF-8 stdin, never interpolate clipboard data", async () => {
    const fixture = fakeSpawner((child) => child.close());
    await writeClipboardInChildProcess(
      "café 日本語 👩🏽‍💻",
      new AbortController().signal,
      { ...compiledWriter, platform: "win32", spawn: fixture.run },
    );
    assert.deepEqual(fixture.calls[0]?.args, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())",
    ]);
    assert.equal(fixture.calls[0]?.child.input, "café 日本語 👩🏽‍💻");
  });

  it("successful empty writes still close stdin and clear the clipboard", async () => {
    const fixture = fakeSpawner((child) => child.close());
    await writeClipboardInChildProcess("", new AbortController().signal, {
      ...compiledWriter,
      spawn: fixture.run,
    });
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0]?.child.stdin.writableEnded, true);
    assert.equal(fixture.calls[0]?.child.input, "");
  });

  it("already-aborted writes skip runtime detection and all spawns", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");
    await assert.rejects(
      writeClipboardInChildProcess("x", controller.signal, {
        canSpawnHelper: () => assert.fail("no runtime lookup"),
        spawn: () => assert.fail("no spawn"),
      }),
      { name: "AbortError" },
    );
  });

  it("in-flight abort kills and awaits close, never starts a fallback", async () => {
    const fixture = fakeSpawner();
    const controller = new AbortController();
    let settled = false;
    const write = writeClipboardInChildProcess("old", controller.signal, {
      ...compiledWriter,
      platform: "win32",
      spawn: fixture.run,
    });
    const rejection = assert.rejects(write, /cancelled/).then(() => {
      settled = true;
    });
    const child = fixture.calls[0]?.child;
    assert.ok(child);
    child.autoCloseOnKill = false;
    controller.abort(new Error("cancelled"));
    await flush();
    assert.equal(settled, false);
    assert.deepEqual(child.kills, ["SIGKILL"]);
    child.close(null, "SIGKILL");
    await rejection;
    assert.equal(fixture.calls.length, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  it("abort during spawn is rechecked before writing stdin", async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const write = writeClipboardInChildProcess("secret", controller.signal, {
      ...compiledWriter,
      spawn: () => {
        controller.abort();
        return child as unknown as ChildProcess;
      },
    });
    await assert.rejects(write, { name: "AbortError" });
    assert.equal(child.input, "");
    assert.deepEqual(child.kills, ["SIGKILL"]);
  });

  it("removes abort listeners after success or a backend failure", async () => {
    for (const code of [0, 1]) {
      const fixture = fakeSpawner((child) => child.close(code));
      const controller = new AbortController();
      const write = writeClipboardInChildProcess("x", controller.signal, {
        ...compiledWriter,
        spawn: fixture.run,
      });
      if (code) await assert.rejects(write, /failed copy/);
      else await write;
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      controller.abort();
      assert.deepEqual(fixture.calls[0]?.child.kills, []);
    }
  });

  it("catches synchronous and event spawn failures, trying the next candidate", async () => {
    for (const event of [false, true]) {
      const fixture = fakeSpawner((child, index) => {
        if (event && index === 0) {
          child.emit(
            "error",
            Object.assign(new Error(), {
              code: "ENOENT",
              syscall: "spawn powershell.exe",
            }),
          );
          child.close(-2);
        } else child.close();
      });
      let attempts = 0;
      await writeClipboardInChildProcess("x", new AbortController().signal, {
        ...compiledWriter,
        platform: "win32",
        spawn: (command, args, options) => {
          if (++attempts === 1 && !event)
            throw new Error("spawn failed synchronously");
          return fixture.run(command, args, options);
        },
      });
      assert.equal(attempts, 2);
    }
  });

  it("stdin errors kill the child; EPIPE and destroyed pipes defer to exit status", async () => {
    for (const code of ["EPIPE", "ERR_STREAM_DESTROYED", "EIO"]) {
      const fixture = fakeSpawner((child) => {
        child.stdin.emit("error", Object.assign(new Error(code), { code }));
        if (code !== "EIO") child.close(0);
      });
      const write = writeClipboardInChildProcess(
        "x",
        new AbortController().signal,
        { ...compiledWriter, spawn: fixture.run },
      );
      if (code === "EIO") await assert.rejects(write, /EIO/);
      else await write;
      assert.deepEqual(
        fixture.calls[0]?.child.kills,
        code === "EIO" ? ["SIGKILL"] : [],
      );
    }
  });

  it("slow writes leave the event loop live and discard real child stdout/stderr", async () => {
    let child: ChildProcess | undefined;
    const started = performance.now();
    const write = writeClipboardInChildProcess(
      "payload",
      new AbortController().signal,
      {
        ...compiledWriter,
        spawn: (_command, _args, options) => {
          child = spawn(
            process.execPath,
            [
              "-e",
              "process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('UNTRUSTED'.repeat(20000)); process.stderr.write('UNTRUSTED'.repeat(20000)); setTimeout(() => process.exit(0), 120); });",
            ],
            options,
          );
          return child;
        },
      },
    );
    let finished = false;
    const done = write.then(() => {
      finished = true;
    });
    await delay(10);
    assert.equal(
      finished,
      false,
      "timer fires during the slow clipboard write",
    );
    assert.equal(child?.stdout, null, "stdout goes directly to ignore, not Pi");
    assert.equal(child?.stderr, null);
    await done;
    assert.ok(performance.now() - started >= 120);
  });

  it("real in-flight child is killed on abort before the write settles", async () => {
    const controller = new AbortController();
    let child: ChildProcess | undefined;
    const write = writeClipboardInChildProcess("x", controller.signal, {
      ...compiledWriter,
      spawn: (_command, _args, options) => {
        child = spawn(
          process.execPath,
          ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"],
          options,
        );
        return child;
      },
    });
    const rejected = assert.rejects(write, { name: "AbortError" });
    assert.ok(child);
    await once(child, "spawn");
    controller.abort();
    await rejected;
    assert.equal(child.signalCode, "SIGKILL");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  it("latest-wins queue does not apply intermediate or late stale writes", async () => {
    const fixture = fakeSpawner();
    const mirror = new ClipboardMirror((text, signal) =>
      writeClipboardInChildProcess(text, signal, {
        ...compiledWriter,
        spawn: fixture.run,
      }),
    );
    mirror.mirror("first");
    mirror.mirror("stale");
    mirror.mirror("latest");
    assert.deepEqual(
      fixture.calls.map((c) => c.child.input),
      ["first"],
    );
    assert.deepEqual(fixture.calls[0]?.child.kills, []);
    fixture.calls[0]?.child.close();
    await flush();
    assert.deepEqual(
      fixture.calls.map((c) => c.child.input),
      ["first", "latest"],
    );
    fixture.calls[1]?.child.close();
    await drain(mirror);
    assert.equal(mirror.lastWriteFailed(), false);
  });

  it("one write timeout aborts the active process, drains latest, and is not an environment failure", async () => {
    const fixture = fakeSpawner((child, index) => {
      if (index > 0) child.close();
    });
    const breaker = { consecutiveEnvironmentFailures: 2, disabled: false };
    const mirror = new ClipboardMirror(
      (text, signal) =>
        writeClipboardInChildProcess(text, signal, {
          ...compiledWriter,
          platform: "win32",
          spawn: fixture.run,
        }),
      10,
      breaker,
    );
    mirror.mirror("slow");
    mirror.mirror("skip");
    mirror.mirror("latest");
    await drain(mirror);
    assert.deepEqual(
      fixture.calls.map((c) => c.child.input),
      ["slow", "latest"],
    );
    assert.deepEqual(
      fixture.calls.map((c) => c.command),
      ["powershell.exe", "powershell.exe"],
    );
    assert.deepEqual(fixture.calls[0]?.child.kills, ["SIGKILL"]);
    assert.deepEqual(breaker, {
      consecutiveEnvironmentFailures: 0,
      disabled: false,
    });
    assert.equal(mirror.lastWriteFailed(), false);
  });

  it("the default 5500ms write timeout is shared across fallback attempts", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fixture = fakeSpawner();
    const breaker = { consecutiveEnvironmentFailures: 2, disabled: false };
    const mirror = new ClipboardMirror(
      (text, signal) =>
        writeClipboardInChildProcess(text, signal, {
          ...compiledWriter,
          platform: "win32",
          spawn: fixture.run,
        }),
      undefined,
      breaker,
    );
    mirror.mirror("slow fallbacks");
    t.mock.timers.tick(5000);
    fixture.calls[0]?.child.close(1);
    await flush();
    assert.equal(fixture.calls.length, 2);
    t.mock.timers.tick(499);
    assert.deepEqual(fixture.calls[1]?.child.kills, []);
    t.mock.timers.tick(1);
    await flush();
    assert.deepEqual(fixture.calls[1]?.child.kills, ["SIGKILL"]);
    assert.equal(mirror.hasPendingWrite(), false);
    assert.equal(mirror.lastWriteFailed(), true);
    assert.deepEqual(breaker, {
      consecutiveEnvironmentFailures: 0,
      disabled: false,
    });
  });

  it("writer replacement kills the old child before the latest text starts", async () => {
    const old = fakeSpawner();
    const next = fakeSpawner((child) => child.close());
    const mirror = new ClipboardMirror((text, signal) =>
      writeClipboardInChildProcess(text, signal, {
        ...compiledWriter,
        spawn: old.run,
      }),
    );
    mirror.mirror("old");
    const child = old.calls[0]?.child;
    assert.ok(child);
    child.autoCloseOnKill = false;
    mirror.setWriteFn((text, signal) =>
      writeClipboardInChildProcess(text, signal, {
        ...compiledWriter,
        spawn: next.run,
      }),
    );
    mirror.mirror("latest");
    await flush();
    assert.deepEqual(child.kills, ["SIGKILL"]);
    assert.equal(next.calls.length, 0);
    child.close(null, "SIGKILL");
    await drain(mirror);
    assert.deepEqual(
      next.calls.map((call) => call.child.input),
      ["latest"],
    );
    assert.equal(mirror.lastWriteFailed(), false);
  });

  for (const kind of ["environment", "backend", "mixed", "signal"] as const) {
    it(`${kind} failure has correct circuit-breaker classification`, async () => {
      const fixture = fakeSpawner((child, index) => {
        if (kind === "environment" || (kind === "mixed" && index % 2 === 1)) {
          child.emit(
            "error",
            Object.assign(new Error(), {
              code: "ENOENT",
              syscall: "spawn powershell.exe",
            }),
          );
          child.close(-2);
        } else if (kind === "signal") child.close(null, "SIGTERM");
        else child.close(2);
      });
      const breaker = { consecutiveEnvironmentFailures: 0, disabled: false };
      const mirror = new ClipboardMirror(
        (text, signal) =>
          writeClipboardInChildProcess(text, signal, {
            ...compiledWriter,
            platform: "win32",
            spawn: fixture.run,
          }),
        5500,
        breaker,
      );
      for (let i = 0; i < 4; i++) {
        mirror.mirror(`write${i}`);
        await drain(mirror);
      }
      assert.equal(mirror.lastWriteFailed(), true);
      assert.equal(breaker.disabled, kind === "environment");
      assert.equal(
        breaker.consecutiveEnvironmentFailures,
        kind === "environment" ? 3 : 0,
      );
      assert.equal(fixture.calls.length, kind === "environment" ? 6 : 8);
    });
  }
});
