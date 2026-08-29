import { execSync } from "node:child_process";
import { posix } from "node:path";
import { extractPackResult } from "./pack-json.js";

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
  "settings.ts",
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

const FORBIDDEN_REGEX_BY_GLOB: Record<
  (typeof FORBIDDEN_GLOBS)[number],
  RegExp
> = {
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
  // Issue #32 modularization: index.ts module-level subsystems move into
  // sibling modules (cursor-shape, mode-colors, mode-change-command,
  // clipboard-mirror), raising the packed file count 10 -> 14 and adding
  // import/export boilerplate (~2 KB unpacked, measured). Same code
  // otherwise. Keep budgets tight enough to catch accidental docs/tests
  // in the package.
  //
  // Counted line-end operators (Nd$/Nc$ across lines, plus count-ignoring
  // Nd0/Nd^/Nc0/Nc^): index.ts adds applyLineEndOperator +
  // moveCursorAfterDeleteToLineEnd and two operator-dispatch guards.
  // Measured: packed 35341 -> 36099 (+758 B), unpacked 151762 -> 155801
  // (+4039 B). Budgets bumped 35500 -> 36400 and 153000 -> 156500 to fit
  // the feature with ~300 B / ~700 B headroom (test files are excluded
  // from the package, so their new cases do not count).
  //
  // Dot repeat (.): index.ts gains the keystroke-recorder (RepeatRecording
  // capture, count-override replay, failed-replay snapshot rollback, and
  // insertTextAtCursor/Enter/Tab recording-cancel guards), a `.`
  // interception, and repeat rows in the README. Measured: packed 36099 ->
  // 38298 (+2199 B), unpacked 155801 -> 166012 (+10211 B; README + the
  // wider try/finally dispatch surface). Budgets bumped 36400 -> 38700 and
  // 156500 -> 167000 to fit the feature with ~400 B / ~1000 B headroom.
  //
  // Mode-label extraction (Track 2 ModalEditor split): fitModeLabel +
  // takeModeLabelSuffix move from index.ts into a new mode-label.ts module.
  // A pure move (behavior identical), but the new file pays its own import
  // + doc-comment boilerplate and a package file entry, so it grows rather
  // than relieves the budget. Measured: packed 38298 -> 38996 (+698 B),
  // unpacked 166012 -> 167258 (+1246 B), files 15 -> 16. Budgets bumped
  // 38700 -> 39300 and 167000 -> 168000 to fit with ~300 B / ~740 B
  // headroom (test files are excluded from the package). File count is now
  // at the maxFiles cap; the next new module needs a maxFiles bump too.
  //
  // Visual mode (v / V): index.ts gains the visualAnchor state, the
  // handleVisualMode dispatch branch, applyVisualOperator and its helpers,
  // and the VISUAL / V-LINE labels; a new visual.ts holds the pure selection
  // geometry; README gains a visual-mode reference section plus three
  // known-difference rows. Measured: packed 38996 -> 42330 (+3334 B),
  // unpacked 167258 -> 179171 (+11913 B), files 16 -> 17. README is inside
  // the package `files` list, so its ~5 KB of new prose dominates the
  // unpacked growth. Budgets bumped to 42800 / 180000 / 17, leaving ~470 B
  // packed and ~829 B unpacked headroom.
  //
  // EX pi-command bridge: index.ts gains the mirrored builtin command names,
  // the reserved-name set, the name/args split in submitPendingExCommand, and
  // dispatchSlashCommand plus its three injected seams; settings.ts gains the
  // exCommand reader and resolver; README gains the pi-command bridge section
  // and a rewritten comparison row. Measured after the README edits (they ship
  // in the package `files` list): packed 42576 -> 45627 (+3051 B), unpacked
  // 179906 -> 189116 (+9210 B), files unchanged at 17 (no new module — the
  // bridge lands in index.ts + settings.ts precisely to avoid a maxFiles bump).
  // Roughly a third of the packed delta is the 21-name builtin mirror, which a
  // future upstream re-export of BUILTIN_SLASH_COMMANDS would remove. Budgets
  // bumped to 46100 / 189900, leaving ~473 B packed and ~784 B unpacked
  // headroom. maxFiles stays at the cap: the next new module must bump it.
  //
  // Async EX restoration: index.ts now retains the latest prompt snapshot while
  // a dispatched submit is pending and restores delayed clears on settlement.
  // Measured: packed 46138 B, unpacked 191265 B. Budgets bumped 46100 -> 46600
  // and 189900 -> 192000, leaving ~462 B / ~735 B headroom. Files stay at 17.
  //
  // Global-only EX clipboard settings plus the defensive trust mirror entry:
  // measured packed 46432 B, unpacked 192572 B. The packed budget still fits;
  // unpacked is bumped 192000 -> 193300, leaving ~728 B headroom. Files stay at
  // 17.
  //
  // Exhausted counted-join replay cursor parity: measured packed 46598 B and
  // unpacked 193368 B. The packed budget still fits; unpacked is bumped 193300
  // -> 193700, leaving ~332 B headroom. Files stay at 17.
  //
  // No-op line-end delete register parity: measured packed 46604 B and unpacked
  // 193388 B. The unpacked budget still fits; packed is bumped 46600 -> 46900,
  // leaving ~296 B headroom. Files stay at 17.
  //
  // Implicit-insert dot-repeat: index.ts synthesizes an `i` recording on the
  // first keystroke of a startup/post-submit implicit insert, and a
  // suppression flag keeps a host-tainted insert session out of dot-repeat.
  // Plus a README paragraph documenting the behavior. Measured packed 47580 B,
  // unpacked 196332 B. Budgets bumped 46900 -> 47900 and 193700 -> 196600,
  // leaving ~320 B / ~268 B headroom. Files stay at 17.
  //
  // `:!cmd` shell dispatch through the EX bridge: index.ts routes a bare leading
  // `!` ex line through the shared submit seam so it reaches Pi's bash mode,
  // with the same save/restore and paste-safety as slash dispatch. Plus README
  // rows/precedence documenting it. Measured packed 48014 B, unpacked 197664 B.
  // Budgets bumped 47900 -> 48400 and 196600 -> 198000, leaving ~386 B / ~336 B
  // headroom. Files stay at 17.
  //
  // Wave-2 review fixes: index.ts excludes the Kitty CSI-u Enter (`\x1b[13u`)
  // from implicit-insert dot-repeat so a replay cannot re-submit, refreshes the
  // pending async-dispatch restore snapshot on out-of-band public setters, and
  // drops a leaked count on swallowed visual-mode keys; plus README
  // trust-boundary, paste-policy, and getMode() corrections. Measured packed
  // 48885 B, unpacked 200117 B. Budgets bumped 48400 -> 49400 and 198000 ->
  // 200600, leaving ~515 B / ~483 B headroom. Files stay at 17.
  //
  // Vim-change-scoped undo: index.ts adds an undo window hung on the recorder's
  // change boundaries (plus visual operators and the dot-repeat replay) that
  // collapses the host undo stack to one snapshot per vim change, so one `u`
  // reverts a whole change. ~90 LOC of fields, helpers, and wiring plus a README
  // undo-unit paragraph, comparison row, and non-goals; no new shipped files
  // (tests are excluded from the package). Measured packed 50585 B, unpacked
  // 205430 B. Budgets bumped 49400 -> 51000 and 200600 -> 205900, leaving
  // ~415 B / ~470 B headroom. Files stay at 17.
  //
  // gM motion with {count} percentage: index.ts adds the gM branch (halfway
  // the text of the line), consumes the pending count so 50gMx deletes one
  // character instead of fifty, and honors nvim's counted form — 1..100
  // moves to that percentage of the line's text, higher counts fall back to
  // halfway. Plus the README navigation row for gM/{count}gM. Measured
  // packed 49278 B, unpacked 201240 B. The packed budget still fits;
  // unpacked is bumped 200600 -> 201600, leaving ~360 B headroom. Files
  // stay at 17.
  //
  // Border-color "inherit" neutral-default detection: mode-colors.ts gains
  // buildOffBorderColor + isNeutralBorder, index.ts tracks the host-assigned
  // border base and resolves the token-based thinking-color precedence
  // (borderMuted > thinking > accent; the label inherits the thinking color),
  // and the README documents the mode plus its precedence rule. Rebased on
  // top of the undo-scope and gM features, the stacked package measures
  // packed 53459 B, unpacked 213919 B. Budgets bumped 51000 -> 54000 and
  // 207100 -> 214500, leaving ~541 B / ~581 B headroom. Files stay at 17.
  //
  // "inherit" explicit-wins redesign: index.ts swaps the borderMuted-token
  // precedence for an explicit-config check (an explicitly configured mode
  // wins over a non-neutral host border; an unconfigured mode defers) and the
  // README's two "inherit" paragraphs are rewritten to that contract. Measured
  // packed 53506 B, unpacked 214184 B — both still under the existing budgets,
  // so they are unchanged, leaving ~494 B / ~316 B headroom. Files stay at 17.
  //
  // Line-wise put cursor fix (issue #39): putAfter/putBefore capture the first
  // pasted line and move the cursor to its first non-blank after inserting
  // (adapted from PR #40); README documents the cursor placement plus the
  // all-whitespace-first-line `^` divergence, and modal-editor/nvim-parity
  // tests pin it. Measured packed 53820 B, unpacked 215321 B. The packed budget
  // still fits (~180 B headroom); unpacked is bumped 214500 -> 215800, leaving
  // ~479 B headroom. Files stay at 17.
  //
  // Inner-word (iw/aw) three-class parity: text-objects.ts replaces the
  // two-class word/non-word scan with nvim's blank/punctuation/word classes
  // (Unicode-aware word chars), so `iw`/`aw` select the run under the cursor
  // and count consecutive runs like nvim. README documents the behavior and
  // modal-editor + nvim-parity-text-objects tests pin it. Measured packed
  // 54710 B, unpacked 217561 B. Budgets bumped 54000 -> 55000 and 215800 ->
  // 218500, leaving ~290 B / ~939 B headroom. Files stay at 17.
  //
  // README rewrite: reorganized the README to lead with a capabilities
  // pitch and a highlights tour (`:!cmd`, the pi-command bridge, one-`u`
  // undo, dot-repeat, visual mode, mode-aware borders) plus gif placeholders,
  // and moved the settings block into a reorganized settings reference. Pure
  // docs (no code change), but README ships in the package `files` list, so
  // its net prose growth counts. Measured packed 55500 B, unpacked 220633 B.
  // Budgets bumped 55000 -> 56000 and 218500 -> 221500, leaving ~500 B /
  // ~867 B headroom. Files stay at 17.
  //
  // borderSync/labelSync redesign: the released explicit-wins "inherit" model
  // is replaced by two per-mode enum maps ("mode"/"host"/"thinking") over the
  // border and label surfaces. index.ts swaps the explicit-config resolver for
  // a shared per-surface resolver plus a trap-skip gate (the all-default case
  // installs no border trap); settings.ts adds the two whole-map readers and
  // the legacy-key resolver; README's border section is rewritten to the three
  // values, the defaults, and two worked examples, and the settings block spells
  // out the default-equivalent maps. Measured packed 56735 B, unpacked 225596 B.
  // Budgets bumped 56000 -> 57300 and 221500 -> 226300, leaving ~565 B / ~704 B
  // headroom. Files stay at 17.
  //
  // Post-release text-object parity fixes: text-objects.ts classifies word
  // classes per grapheme (so astral letters and emoji + variation selectors stay
  // one class run) and cancels unsatisfiable counted objects; index.ts adds the
  // EOL-deletion cursor clamp plus the failed-object cursor move. Only shipped
  // .ts grows — the new parity cases live in test/, which the package excludes.
  // Measured packed 57943 B, unpacked 228770 B. Budgets bumped 57300 -> 58500
  // and 226300 -> 229600, leaving ~557 B / ~830 B headroom. Files stay at 17.
  //
  // Fail-soft host resolution: clipboard helper source is built lazily so
  // virtual or non-filesystem Pi entrypoints cannot block extension activation;
  // helper tests call the same source builders used at runtime. Measured packed
  // 58363 B, unpacked 230546 B. Budgets bumped 58500 -> 59000 and 229600 ->
  // 231400, leaving ~637 B / ~854 B headroom. Files stay at 17.
  maxFiles: 17,
  maxSize: 59000,
  maxUnpackedSize: 231400,
} as const;

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
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
    throw new Error(
      `Failed to parse npm pack JSON output: ${formatError(error)}`,
    );
  }

  const firstResult = extractPackResult(parsed);

  const files = firstResult.files;
  const size = firstResult.size;
  const unpackedSize = firstResult.unpackedSize;

  if (!Array.isArray(files)) {
    throw new Error(
      "npm pack --dry-run --json is missing required field: files[]",
    );
  }

  if (typeof size !== "number" || !Number.isFinite(size)) {
    throw new Error(
      "npm pack --dry-run --json is missing required numeric field: size",
    );
  }

  if (typeof unpackedSize !== "number" || !Number.isFinite(unpackedSize)) {
    throw new Error(
      "npm pack --dry-run --json is missing required numeric field: unpackedSize",
    );
  }

  const packFiles = files.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("path" in entry) ||
      typeof entry.path !== "string" ||
      entry.path.length === 0
    ) {
      throw new Error(
        `npm pack --dry-run --json files[${index}] is missing string field: path`,
      );
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
    throw new Error(
      `Invalid empty pack path after normalization: ${pathValue}`,
    );
  }

  if (posix.isAbsolute(normalized)) {
    throw new Error(
      `Pack path must be relative, got absolute path: ${pathValue}`,
    );
  }

  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Pack path escapes package root: ${pathValue}`);
  }

  return normalized;
}

function normalizePaths(files: PackFile[]): string[] {
  return files.map((file) => normalizePath(file.path)).sort(compareStrings);
}

function checkRequired(paths: string[]): string[] {
  const pathSet = new Set(paths);

  return REQUIRED_FILES.filter(
    (requiredPath) => !pathSet.has(requiredPath),
  ).sort(compareStrings);
}

function matchForbidden(paths: string[]): ForbiddenMatch[] {
  const matches: ForbiddenMatch[] = [];

  for (const path of paths) {
    const globs = FORBIDDEN_GLOBS.filter((glob) =>
      FORBIDDEN_REGEX_BY_GLOB[glob].test(path),
    );

    if (globs.length > 0) {
      matches.push({ path, globs });
    }
  }

  return matches;
}

function checkThresholds(result: PackResult): string[] {
  const violations: string[] = [];

  if (result.files.length > THRESHOLDS.maxFiles) {
    violations.push(
      `files.length ${result.files.length} > ${THRESHOLDS.maxFiles}`,
    );
  }

  if (result.size > THRESHOLDS.maxSize) {
    violations.push(`size ${result.size} > ${THRESHOLDS.maxSize}`);
  }

  if (result.unpackedSize > THRESHOLDS.maxUnpackedSize) {
    violations.push(
      `unpackedSize ${result.unpackedSize} > ${THRESHOLDS.maxUnpackedSize}`,
    );
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
  const sameEntries =
    sameLength &&
    firstPaths.every((path, index) => path === secondPaths[index]);

  if (sameEntries) {
    return {
      passed: true,
      details: [
        `Stable file set across two consecutive dry-runs (${firstPaths.length} files)`,
      ],
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

function printSummary(
  result: PackResult,
  paths: string[],
  summaries: CheckSummary[],
): void {
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
      details:
        missingRequired.length === 0
          ? [`All required files present (${REQUIRED_FILES.length})`]
          : missingRequired.map((path) => `Missing required file: ${path}`),
    });

    const forbiddenMatches = matchForbidden(normalizedPaths);
    summaries.push({
      name: "forbidden globs",
      passed: forbiddenMatches.length === 0,
      details:
        forbiddenMatches.length === 0
          ? ["No forbidden file paths matched"]
          : forbiddenMatches.map(
              (match) => `${match.path} matches ${match.globs.join(", ")}`,
            ),
    });

    const thresholdViolations = checkThresholds(packResult);
    summaries.push({
      name: "size thresholds",
      passed: thresholdViolations.length === 0,
      details:
        thresholdViolations.length === 0
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
      console.error(
        `pack:check failed (${failedChecks.length} check${failedChecks.length === 1 ? "" : "s"})`,
      );
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
