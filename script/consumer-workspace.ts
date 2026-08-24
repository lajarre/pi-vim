/**
 * Shared helpers for scripts that assemble a throwaway consumer workspace
 * and install packages into it (image-attachments e2e, consumer smoke).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentRequire = createRequire(import.meta.url);

export const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

function createNpmCommandEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NPM_CONFIG_BEFORE;
  delete env.npm_config_before;
  delete env.NPM_CONFIG_MIN_RELEASE_AGE;
  delete env.npm_config_min_release_age;
  return env;
}

export function isRecord(
  value: unknown,
): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function readPackageName(packageJsonPath: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `FAIL-INFRA: unable to read or parse package.json at ${packageJsonPath}: ${formatUnknownError(error)}`,
      { cause: error },
    );
  }

  if (isRecord(parsed) && typeof parsed.name === "string") return parsed.name;
  return null;
}

export function hasPackageName(
  packageDir: string,
  expectedName: string,
): boolean {
  const packageJsonPath = join(packageDir, "package.json");
  return (
    existsSync(packageJsonPath) &&
    readPackageName(packageJsonPath) === expectedName
  );
}

function findPackageRootInAncestorNodeModules(
  specifier: string,
): string | null {
  let dir = projectRoot;

  while (true) {
    const nodeModulesCandidate = join(
      dir,
      "node_modules",
      ...specifier.split("/"),
    );
    if (hasPackageName(nodeModulesCandidate, specifier))
      return nodeModulesCandidate;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

// npm keeps the peer's dependency tree nested under the peer itself in this
// repo's lockfile, so @earendil-works/pi-ai lives inside pi-coding-agent's
// node_modules rather than at the top level.
function findPackageRootNestedInCodingAgent(specifier: string): string | null {
  const hostSpecifier = "@earendil-works/pi-coding-agent";
  if (specifier === hostSpecifier) return null;

  const hostRoot = findPackageRootInAncestorNodeModules(hostSpecifier);
  if (!hostRoot) return null;

  const nestedCandidate = join(
    hostRoot,
    "node_modules",
    ...specifier.split("/"),
  );
  return hasPackageName(nestedCandidate, specifier) ? nestedCandidate : null;
}

export function findPackageRoot(specifier: string): string {
  const ancestorNodeModulesPackage =
    findPackageRootInAncestorNodeModules(specifier);
  if (ancestorNodeModulesPackage) return ancestorNodeModulesPackage;

  const codingAgentNestedPackage =
    findPackageRootNestedInCodingAgent(specifier);
  if (codingAgentNestedPackage) return codingAgentNestedPackage;

  let dir: string;
  try {
    dir = dirname(currentRequire.resolve(specifier));
  } catch (error) {
    if (isRecord(error) && error.code === "MODULE_NOT_FOUND") {
      throw new Error(
        `FAIL-INFRA: unable to locate installed package root for ${specifier}`,
      );
    }
    throw new Error(
      `FAIL-INFRA: unable to resolve installed package root for ${specifier}: ${formatUnknownError(error)}`,
      { cause: error },
    );
  }

  while (true) {
    const packageJsonPath = join(dir, "package.json");
    if (
      existsSync(packageJsonPath) &&
      readPackageName(packageJsonPath) === specifier
    ) {
      return dir;
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `FAIL-INFRA: unable to locate installed package root for ${specifier}`,
  );
}

export function packLocalPackage(
  packageDir: string,
  destination: string,
  label: string,
): string {
  try {
    const output = execFileSync(
      "npm",
      ["pack", packageDir, "--pack-destination", destination],
      {
        cwd: destination,
        encoding: "utf8",
        env: {
          ...createNpmCommandEnv(),
          npm_config_ignore_scripts: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    const tarballName = output.split("\n").filter(Boolean).at(-1);
    if (!tarballName) throw new Error("npm pack did not report a tarball name");
    return `file:${join(destination, tarballName)}`;
  } catch (error) {
    throw new Error(
      `FAIL-INFRA: unable to pack ${label}: ${formatUnknownError(error)}`,
    );
  }
}

export function runNpmInstall(
  workspace: string,
  extraArgs: string[] = [],
): void {
  try {
    execFileSync("npm", ["install", "--ignore-scripts", ...extraArgs], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...createNpmCommandEnv(),
        npm_config_audit: "false",
        npm_config_fund: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const output = isRecord(error)
      ? [error.stdout, error.stderr]
          .filter((value): value is string => typeof value === "string")
          .join("\n")
      : "";
    throw new Error(
      `FAIL-INFRA: npm install failed${output ? `\n${output}` : ""}`,
    );
  }
}
