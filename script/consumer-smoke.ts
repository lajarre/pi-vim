/**
 * Published-package consumer smoke test (issue #33).
 *
 * Packs this repo with `npm pack` and installs the tarball in two throwaway
 * consumer workspaces. One provides real @earendil-works/pi-* peers. The other
 * matches Pi's managed install, which omits host peers and supplies them as
 * Jiti virtual modules. Both load the installed package.json extension entries
 * and probe modal editing. This catches publish-only failures that test/ cannot
 * see because test/ is not published.
 */

import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";

import {
  findPackageRoot,
  formatUnknownError,
  isRecord,
  packLocalPackage,
  projectRoot,
  runNpmInstall,
} from "./consumer-workspace.js";

// Renamed during PR #27; if the tarball still references either old name,
// npm install materializes it at the workspace top level.
const OLD_NAME_PACKAGES = [
  "@mariozechner/pi-tui",
  "@mariozechner/pi-coding-agent",
] as const;

type PiExtension = (pi: unknown) => void;
type CreateJiti = (
  baseUrl: string,
  options: {
    moduleCache: boolean;
    tryNative: boolean;
    virtualModules: Record<string, unknown>;
  },
) => {
  import(path: string, options: { default: boolean }): Promise<unknown>;
};

type EditorFactory = (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
) => unknown;

type EditorSurface = {
  render(width: number): unknown;
  handleInput(data: string): void;
  getText(): string;
  getMode(): string;
};

function fail(message: string): never {
  throw new Error(message);
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (actual !== expected) {
    fail(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function readPackageJson(
  packageJsonPath: string,
): Promise<Record<PropertyKey, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
  } catch (error) {
    fail(
      `FAIL-INFRA: unable to read or parse ${packageJsonPath}: ${formatUnknownError(error)}`,
    );
  }
  if (!isRecord(parsed)) fail(`${packageJsonPath} is not a JSON object`);
  return parsed;
}

async function createWorkspace(
  packageName: string,
  includePeers: boolean,
): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "pi-vim-consumer-smoke-"));
  const dependencies: Record<string, string> = {
    [packageName]: packLocalPackage(projectRoot, workspace, packageName),
  };

  if (includePeers) {
    dependencies["@earendil-works/pi-ai"] =
      `file:${findPackageRoot("@earendil-works/pi-ai")}`;
    dependencies["@earendil-works/pi-coding-agent"] =
      `file:${findPackageRoot("@earendil-works/pi-coding-agent")}`;
    dependencies["@earendil-works/pi-tui"] =
      `file:${findPackageRoot("@earendil-works/pi-tui")}`;
  }

  await writeFile(
    join(workspace, "package.json"),
    `${JSON.stringify({ private: true, type: "module", dependencies }, null, 2)}\n`,
  );
  runNpmInstall(workspace, includePeers ? [] : ["--legacy-peer-deps"]);
  return workspace;
}

function assertNoOldNamePackages(workspace: string): void {
  for (const oldName of OLD_NAME_PACKAGES) {
    if (existsSync(join(workspace, "node_modules", ...oldName.split("/")))) {
      fail(
        `consumer workspace contains ${oldName} — the packed tarball still references a pre-rename package`,
      );
    }
  }
}

function assertManagedPeersOmitted(workspace: string): void {
  for (const peerName of [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
  ]) {
    if (existsSync(join(workspace, "node_modules", ...peerName.split("/")))) {
      fail(`managed consumer workspace unexpectedly contains ${peerName}`);
    }
  }
}

function resolveInstalledPackageDir(
  workspace: string,
  packageName: string,
): string {
  const workspaceRequire = createRequire(join(workspace, "package.json"));
  let packageJsonPath: string;
  try {
    packageJsonPath = workspaceRequire.resolve(`${packageName}/package.json`);
  } catch (error) {
    fail(
      `installed ${packageName} is not resolvable from the consumer workspace: ${formatUnknownError(error)}`,
    );
  }

  const workspaceRoot = realpathSync(workspace);
  if (!packageJsonPath.startsWith(workspaceRoot)) {
    fail(
      `resolved ${packageName} outside the consumer workspace: ${packageJsonPath}`,
    );
  }
  return dirname(packageJsonPath);
}

async function readExtensionEntries(
  installedDir: string,
  packageName: string,
  expectedVersion: string,
): Promise<string[]> {
  const installedPackageJson = await readPackageJson(
    join(installedDir, "package.json"),
  );
  assertEqual(installedPackageJson.name, packageName, "installed package name");
  assertEqual(
    installedPackageJson.version,
    expectedVersion,
    "installed package version",
  );

  const pi = installedPackageJson.pi;
  if (!isRecord(pi) || !Array.isArray(pi.extensions)) {
    fail('installed package.json is missing the "pi"."extensions" array');
  }
  const entries = pi.extensions.filter(
    (entry): entry is string => typeof entry === "string",
  );
  if (entries.length === 0 || entries.length !== pi.extensions.length) {
    fail('installed "pi"."extensions" must be a non-empty string array');
  }
  return entries.map((entry) => join(installedDir, entry));
}

async function importExtension(entryPath: string): Promise<PiExtension> {
  if (!existsSync(entryPath)) {
    fail(`extension entry is missing from the tarball: ${entryPath}`);
  }

  let module: unknown;
  try {
    module = (await import(pathToFileURL(entryPath).href)) as unknown;
  } catch (error) {
    fail(
      `installed extension failed to import: ${entryPath}: ${formatUnknownError(error)}`,
    );
  }
  if (!isRecord(module) || typeof module.default !== "function") {
    fail(`extension default export is not a function: ${entryPath}`);
  }
  return module.default as PiExtension;
}

async function importExtensionWithVirtualPeers(
  entryPath: string,
  hostEntrypoint = join(
    findPackageRoot("@earendil-works/pi-coding-agent"),
    "dist",
    "cli.js",
  ),
): Promise<PiExtension> {
  const codingAgentRoot = findPackageRoot("@earendil-works/pi-coding-agent");
  const requireFromCodingAgent = createRequire(
    join(codingAgentRoot, "package.json"),
  );
  const { createJiti } = requireFromCodingAgent("jiti") as {
    createJiti: CreateJiti;
  };
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    tryNative: false,
    virtualModules: {
      "@earendil-works/pi-coding-agent": piCodingAgent,
      "@earendil-works/pi-tui": piTui,
    },
  });
  const originalArgv1 = process.argv[1];
  process.argv[1] = hostEntrypoint;

  try {
    const extension = await jiti.import(entryPath, { default: true });
    if (typeof extension !== "function") {
      fail(`extension default export is not a function: ${entryPath}`);
    }
    return extension as PiExtension;
  } catch (error) {
    return fail(
      `managed extension failed to import with virtual peers: ${entryPath}: ${formatUnknownError(error)}`,
    );
  } finally {
    if (originalArgv1 === undefined) {
      process.argv.splice(1, 1);
    } else {
      process.argv[1] = originalArgv1;
    }
  }
}

function createActivationHarness(workspace: string) {
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: unknown) => unknown>
  >();
  let editorFactory: EditorFactory | undefined;

  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    events: {
      on() {},
      emit(): boolean {
        return true;
      },
    },
  };

  const ctx = {
    cwd: workspace,
    hasUI: true,
    isIdle() {
      return true;
    },
    ui: {
      theme: {
        borderColor: (s: string) => s,
        fg: (_k: string, s: string) => s,
        bold: (s: string) => s,
      },
      setWidget() {},
      setEditorComponent(factory: EditorFactory | undefined) {
        editorFactory = factory;
      },
      getEditorComponent() {
        return editorFactory;
      },
      notify() {},
    },
    shutdown() {},
  };

  return {
    pi,
    async emit(event: string): Promise<void> {
      for (const handler of handlers.get(event) ?? []) {
        await handler({}, ctx);
      }
    },
    getEditorFactory(): EditorFactory {
      if (!editorFactory) {
        fail("session_start did not register an editor component");
      }
      return editorFactory;
    },
  };
}

function assertEditorSurface(editor: unknown): asserts editor is EditorSurface {
  if (!isRecord(editor)) fail("editor factory did not return an object");
  for (const method of [
    "render",
    "handleInput",
    "getText",
    "getMode",
  ] as const) {
    if (typeof editor[method] !== "function") {
      fail(`editor is missing method ${method}`);
    }
  }
}

function disableClipboardWrites(editor: EditorSurface): void {
  const candidate = editor as EditorSurface & {
    setClipboardFn?: (fn: (text: string) => unknown) => void;
    setClipboardReadFn?: (fn: () => string | null) => void;
  };

  candidate.setClipboardFn?.(() => {});
  candidate.setClipboardReadFn?.(() => null);
}

function assertModalSmoke(editor: EditorSurface): void {
  assertEqual(editor.getMode(), "insert", "editor should start in INSERT mode");

  for (const char of "abc") editor.handleInput(char);
  assertEqual(editor.getText(), "abc", "INSERT input should update text");

  editor.handleInput("\x1b");
  assertEqual(editor.getMode(), "normal", "escape should enter NORMAL mode");

  editor.handleInput("0");
  editor.handleInput("x");
  assertEqual(editor.getText(), "bc", "NORMAL 0x should delete the first char");

  const rendered = editor.render(80);
  if (!Array.isArray(rendered) || rendered.length === 0) {
    fail("render(80) should return a non-empty array of lines");
  }
}

async function activateAndProbe(
  workspace: string,
  entryPath: string,
  importer: (path: string) => Promise<PiExtension> = importExtension,
): Promise<void> {
  const extension = await importer(entryPath);
  const harness = createActivationHarness(workspace);

  extension(harness.pi);
  await harness.emit("session_start");

  const editor = harness.getEditorFactory()(
    { requestRender() {}, terminal: { rows: 40, cols: 120 } },
    {
      borderColor: (s: string) => s,
      fg: (_k: string, s: string) => s,
      bold: (s: string) => s,
    },
    { matches: () => false },
  );
  assertEditorSurface(editor);
  disableClipboardWrites(editor);
  assertModalSmoke(editor);
}

async function main(): Promise<void> {
  const repoPackageJson = await readPackageJson(
    join(projectRoot, "package.json"),
  );
  const packageName = repoPackageJson.name;
  const version = repoPackageJson.version;
  if (typeof packageName !== "string" || typeof version !== "string") {
    fail("repo package.json is missing name or version");
  }

  const workspace = await createWorkspace(packageName, true);
  console.log("consumer-smoke: npm install --ignore-scripts completed");

  // session_start reads user-global settings and modeChange may execute a
  // shell command on mode transitions; point HOME at the empty workspace so
  // the probe only ever sees pi-vim defaults.
  process.env.HOME = workspace;
  process.env.USERPROFILE = workspace;

  assertNoOldNamePackages(workspace);
  const installedDir = resolveInstalledPackageDir(workspace, packageName);
  const entries = await readExtensionEntries(
    installedDir,
    packageName,
    version,
  );

  for (const entryPath of entries) {
    await activateAndProbe(workspace, entryPath);
    console.log(`PASS activate ${entryPath}`);
  }

  const managedWorkspace = await createWorkspace(packageName, false);
  console.log(
    "consumer-smoke: managed npm install --legacy-peer-deps completed",
  );
  process.env.HOME = managedWorkspace;
  process.env.USERPROFILE = managedWorkspace;
  assertManagedPeersOmitted(managedWorkspace);
  const managedInstalledDir = resolveInstalledPackageDir(
    managedWorkspace,
    packageName,
  );
  const managedEntries = await readExtensionEntries(
    managedInstalledDir,
    packageName,
    version,
  );

  for (const entryPath of managedEntries) {
    await activateAndProbe(
      managedWorkspace,
      entryPath,
      importExtensionWithVirtualPeers,
    );
    console.log(`PASS managed activate ${entryPath}`);

    await activateAndProbe(managedWorkspace, entryPath, (path) =>
      importExtensionWithVirtualPeers(path, "/$bunfs/root/pi"),
    );
    console.log(`PASS standalone activate ${entryPath}`);
  }

  console.log("PASS consumer-smoke");
}

void main().catch((error: unknown) => {
  console.error(formatUnknownError(error));
  process.exitCode = 1;
});
