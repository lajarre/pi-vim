import { execSync } from "node:child_process";
import { posix } from "node:path";

type PackFile = {
  path: string;
};

type PackResult = {
  files: PackFile[];
  size: number;
  unpackedSize: number;
};

type DeterminismResult = {
  passed: boolean;
  details: string[];
};

type ForbiddenMatch = {
  path: string;
  globs: string[];
};

type CheckSummary = {
  name: string;
  passed: boolean;
  details: string[];
};

const REQUIRED_FILES = [
  "LICENSE",
  "README.md",
  "package.json",
  "index.ts",
  "motions.ts",
  "types.ts",
  "word-boundary-cache.ts",
] as const;

const FORBIDDEN_GLOBS = [
  "doc/**",
  "test/**",
  ".pi/**",
  "**/*.patch",
  "**/LOOP.md",
  "**/plan*.md",
  "**/spec*.md",
  "**/report*.md",
] as const;

const FORBIDDEN_REGEX_BY_GLOB: Record<(typeof FORBIDDEN_GLOBS)[number], RegExp> = {
  "doc/**": /^doc\//,
  "test/**": /^test\//,
  ".pi/**": /^\.pi\//,
  "**/*.patch": /\.patch$/,
  "**/LOOP.md": /(?:^|\/)LOOP\.md$/,
  "**/plan*.md": /(?:^|\/)plan[^/]*\.md$/,
  "**/spec*.md": /(?:^|\/)spec[^/]*\.md$/,
  "**/report*.md": /(?:^|\/)report[^/]*\.md$/,
};

const THRESHOLDS = {
  maxFiles: 12,
  maxSize: 30000,
  maxUnpackedSize: 120000,
} as const;

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function runPackDryRun(): PackResult {
  let rawOutput: string;

  try {
    rawOutput = execSync("npm pack --dry-run --json", { encoding: "utf8" });
  } catch (error) {
    throw new Error(`npm pack --dry-run --json failed: ${formatError(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch (error) {
    throw new Error(`Failed to parse npm pack JSON output: ${formatError(error)}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("npm pack --dry-run --json returned an unexpected JSON shape (expected non-empty array)");
  }

  const firstResult = parsed[0];
  if (!isObject(firstResult)) {
    throw new Error("npm pack --dry-run --json first result is not an object");
  }

  const files = firstResult.files;
  const size = firstResult.size;
  const unpackedSize = firstResult.unpackedSize;

  if (!Array.isArray(files)) {
    throw new Error("npm pack --dry-run --json is missing required field: files[]");
  }

  if (typeof size !== "number" || !Number.isFinite(size)) {
    throw new Error("npm pack --dry-run --json is missing required numeric field: size");
  }

  if (typeof unpackedSize !== "number" || !Number.isFinite(unpackedSize)) {
    throw new Error("npm pack --dry-run --json is missing required numeric field: unpackedSize");
  }

  const packFiles = files.map((entry, index) => {
    if (!isObject(entry) || typeof entry.path !== "string" || entry.path.length === 0) {
      throw new Error(`npm pack --dry-run --json files[${index}] is missing string field: path`);
    }

    return { path: entry.path } satisfies PackFile;
  });

  return {
    files: packFiles,
    size,
    unpackedSize,
  };
}

function normalizePath(pathValue: string): string {
  const posixSeparators = pathValue.replace(/\\/g, "/");
  const withoutPackagePrefix = posixSeparators.startsWith("package/")
    ? posixSeparators.slice("package/".length)
    : posixSeparators;
  const withoutLeadingDot = withoutPackagePrefix.startsWith("./")
    ? withoutPackagePrefix.slice(2)
    : withoutPackagePrefix;
  const normalized = posix.normalize(withoutLeadingDot);

  if (normalized.length === 0 || normalized === ".") {
    throw new Error(`Invalid empty pack path after normalization: ${pathValue}`);
  }

  if (posix.isAbsolute(normalized)) {
    throw new Error(`Pack path must be relative, got absolute path: ${pathValue}`);
  }

  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Pack path escapes package root: ${pathValue}`);
  }

  return normalized;
}

function normalizePaths(files: PackFile[]): string[] {
  return files
    .map((file) => normalizePath(file.path))
    .sort(compareStrings);
}

function checkRequired(paths: string[]): string[] {
  const pathSet = new Set(paths);

  return REQUIRED_FILES
    .filter((requiredPath) => !pathSet.has(requiredPath))
    .sort(compareStrings);
}

function matchForbidden(paths: string[]): ForbiddenMatch[] {
  const matches: ForbiddenMatch[] = [];

  for (const path of paths) {
    const globs = FORBIDDEN_GLOBS
      .filter((glob) => FORBIDDEN_REGEX_BY_GLOB[glob].test(path));

    if (globs.length > 0) {
      matches.push({ path, globs });
    }
  }

  return matches;
}

function checkThresholds(result: PackResult): string[] {
  const violations: string[] = [];

  if (result.files.length > THRESHOLDS.maxFiles) {
    violations.push(`files.length ${result.files.length} > ${THRESHOLDS.maxFiles}`);
  }

  if (result.size > THRESHOLDS.maxSize) {
    violations.push(`size ${result.size} > ${THRESHOLDS.maxSize}`);
  }

  if (result.unpackedSize > THRESHOLDS.maxUnpackedSize) {
    violations.push(`unpackedSize ${result.unpackedSize} > ${THRESHOLDS.maxUnpackedSize}`);
  }

  return violations;
}

function setsDifference(a: string[], b: string[]): string[] {
  const bSet = new Set(b);
  return a.filter((item) => !bSet.has(item));
}

function checkDeterminism(): DeterminismResult {
  const firstRun = runPackDryRun();
  const secondRun = runPackDryRun();

  const firstPaths = normalizePaths(firstRun.files);
  const secondPaths = normalizePaths(secondRun.files);

  const sameLength = firstPaths.length === secondPaths.length;
  const sameEntries = sameLength && firstPaths.every((path, index) => path === secondPaths[index]);

  if (sameEntries) {
    return {
      passed: true,
      details: [`Stable file set across two consecutive dry-runs (${firstPaths.length} files)`],
    };
  }

  const onlyInFirstRun = setsDifference(firstPaths, secondPaths);
  const onlyInSecondRun = setsDifference(secondPaths, firstPaths);

  const details: string[] = ["Normalized file sets differ between dry-runs"];

  if (onlyInFirstRun.length > 0) {
    details.push(`Only in run #1: ${onlyInFirstRun.join(", ")}`);
  }

  if (onlyInSecondRun.length > 0) {
    details.push(`Only in run #2: ${onlyInSecondRun.join(", ")}`);
  }

  return {
    passed: false,
    details,
  };
}

function printSummary(result: PackResult, paths: string[], summaries: CheckSummary[]): void {
  console.log("pack:check summary");
  console.log(`- files: ${paths.length}`);
  console.log(`- size: ${result.size} bytes`);
  console.log(`- unpackedSize: ${result.unpackedSize} bytes`);
  console.log("- file list:");
  for (const path of paths) {
    console.log(`  - ${path}`);
  }

  for (const summary of summaries) {
    const label = summary.passed ? "PASS" : "FAIL";
    console.log(`- [${label}] ${summary.name}`);
    for (const detail of summary.details) {
      console.log(`    - ${detail}`);
    }
  }
}

function main(): void {
  try {
    const summaries: CheckSummary[] = [];

    const determinism = checkDeterminism();
    summaries.push({
      name: "determinism",
      passed: determinism.passed,
      details: determinism.details,
    });

    const packResult = runPackDryRun();
    const normalizedPaths = normalizePaths(packResult.files);

    const missingRequired = checkRequired(normalizedPaths);
    summaries.push({
      name: "required files",
      passed: missingRequired.length === 0,
      details: missingRequired.length === 0
        ? [`All required files present (${REQUIRED_FILES.length})`]
        : missingRequired.map((path) => `Missing required file: ${path}`),
    });

    const forbiddenMatches = matchForbidden(normalizedPaths);
    summaries.push({
      name: "forbidden globs",
      passed: forbiddenMatches.length === 0,
      details: forbiddenMatches.length === 0
        ? ["No forbidden file paths matched"]
        : forbiddenMatches.map((match) => `${match.path} matches ${match.globs.join(", ")}`),
    });

    const thresholdViolations = checkThresholds(packResult);
    summaries.push({
      name: "size thresholds",
      passed: thresholdViolations.length === 0,
      details: thresholdViolations.length === 0
        ? [
          `files.length ${packResult.files.length} <= ${THRESHOLDS.maxFiles}`,
          `size ${packResult.size} <= ${THRESHOLDS.maxSize}`,
          `unpackedSize ${packResult.unpackedSize} <= ${THRESHOLDS.maxUnpackedSize}`,
        ]
        : thresholdViolations,
    });

    printSummary(packResult, normalizedPaths, summaries);

    const failedChecks = summaries.filter((summary) => !summary.passed);

    if (failedChecks.length > 0) {
      console.error(`pack:check failed (${failedChecks.length} check${failedChecks.length === 1 ? "" : "s"})`);
      process.exit(1);
    }

    console.log("pack:check passed");
    process.exit(0);
  } catch (error) {
    console.error("pack:check failed closed");
    console.error(formatError(error));
    process.exit(1);
  }
}

main();
