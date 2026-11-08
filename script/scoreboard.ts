/**
 * Generates `doc/dev/scoreboard.md` from this repo's own harnesses. No number
 * in the scoreboard is hand-entered; every one of them comes from a command
 * you can re-run yourself:
 *
 *   - each `test/nvim-parity-*.ts` file, run one at a time under Node's TAP
 *     reporter against real headless nvim -> per-suite pass / fail / skip plus
 *     the name of every skipped known gap;
 *   - `test/**\/*.test.ts` under the same reporter -> the unit-test total;
 *   - `script/perf-bench.ts --json` -> startup, memory, and responsiveness;
 *   - `npm pack --dry-run --json` -> the published footprint, compared against
 *     the budgets that `script/pack-check.ts` enforces.
 *
 * Usage:
 *   npm run scoreboard              print the document to stdout
 *   npm run scoreboard -- --write   rewrite doc/dev/scoreboard.md in place
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import { findPackageRoot } from "./consumer-workspace.js";
import { extractPackResult } from "./pack-json.js";

const REPO_ROOT = process.cwd();
const DOC_PATH = path.join("doc", "dev", "scoreboard.md");
const PACK_CHECK_PATH = path.join("script", "pack-check.ts");
const PARITY_DIR = "test";
const PARITY_PREFIX = "nvim-parity";

/** Every parity suite marks a documented divergence with this exact prefix. */
const KNOWN_GAP_PREFIX = "known nvim parity gap: ";

type TapCounts = {
  tests: number;
  pass: number;
  fail: number;
  skipped: number;
};

type ParitySuite = TapCounts & {
  file: string;
  titles: string[];
  gaps: string[];
};

type SampledStats = {
  min: number;
  median: number;
  p95: number;
  max: number;
};

type SampledMetric = {
  unit: string;
  samples: number[];
  stats: SampledStats;
};

type PerfPayload = {
  nodeVersion: string;
  startupRuns: number;
  memoryRuns: number;
  startup: Record<string, SampledMetric>;
  startupIncrementalMs: number;
  memory: Record<string, SampledMetric>;
  memoryIncrementalBytes: number;
  responsiveness: Record<string, SampledMetric>;
};

type PackFootprint = {
  files: number;
  size: number;
  unpackedSize: number;
};

type PackBudgets = {
  maxFiles: number;
  maxSize: number;
  maxUnpackedSize: number;
};

/**
 * How much work one measured operation covers. A `10w` sample times three
 * `handleInput` calls (two count digits and the motion); a `w` sample times
 * one. Reporting a single "slowest operation" across both would compare a
 * whole command against a keystroke.
 */
type MetricKind = "keystroke" | "command";

type MetricLabel = {
  label: string;
  kind: MetricKind;
};

/**
 * Human labels for `script/perf-bench.ts` metric keys. An unlabelled key falls
 * back to its raw name and is left out of the per-kind summaries, so the
 * scoreboard survives a new benchmark without an edit here.
 */
const RESPONSIVENESS_LABELS: Record<string, MetricLabel> = {
  h: { label: "`h` one column left, on a 4k-column line", kind: "keystroke" },
  ignored_printable: {
    label: "an unbound printable key in normal mode (no-op)",
    kind: "keystroke",
  },
  "10w": { label: "`10w` across a 400-word line", kind: "command" },
  "3fX": { label: "`3fX` across a 600-column line", kind: "command" },
  "200j": { label: "`200j` down a 320-line buffer", kind: "command" },
  "50p": { label: "`50p` char-wise put of a yanked word", kind: "command" },
  p_chars_1000: {
    label: "`p` char-wise put of 1,000 ASCII characters",
    kind: "command",
  },
  p_chars_4000: {
    label: "`p` char-wise put of 4,000 ASCII characters",
    kind: "command",
  },
  p_chars_16000: {
    label: "`p` char-wise put of 16,000 ASCII characters",
    kind: "command",
  },
  w_words_20: { label: "`w` on a 20-word line", kind: "keystroke" },
  w_words_50: { label: "`w` on a 50-word line", kind: "keystroke" },
  w_words_100: { label: "`w` on a 100-word line", kind: "keystroke" },
  w_words_200: { label: "`w` on a 200-word line", kind: "keystroke" },
  w_words_400: { label: "`w` on a 400-word line", kind: "keystroke" },
  b_words_20: { label: "`b` on a 20-word line", kind: "keystroke" },
  b_words_50: { label: "`b` on a 50-word line", kind: "keystroke" },
  b_words_100: { label: "`b` on a 100-word line", kind: "keystroke" },
  b_words_200: { label: "`b` on a 200-word line", kind: "keystroke" },
  b_words_400: { label: "`b` on a 400-word line", kind: "keystroke" },
  dw_words_400: { label: "`dw` on a 400-word line", kind: "command" },
  yw_words_400: { label: "`yw` on a 400-word line", kind: "command" },
};

for (const size of [4_096, 16_384]) {
  for (const width of [20, 80]) {
    for (const command of ["gj", "9999gj"]) {
      RESPONSIVENESS_LABELS[`${command}_chars_${size}_width_${width}`] = {
        label: `\`${command}\` on ${size.toLocaleString("en-US")} ASCII characters, ${width} text columns`,
        kind: "command",
      };
    }
  }
}

const WRAP_WIDTH = 78;

/**
 * Stands in for a space inside a `**bold**` or `` `code` `` span while wrapping.
 * Must be a single non-whitespace character: it has to survive a `\s+` split
 * (which U+00A0 would not) and occupy one column so the wrap width stays exact.
 */
const SPACE_SENTINEL = String.fromCharCode(0);

/**
 * Reflows generated prose to a fixed width. Interpolated numbers vary in
 * length, so these paragraphs cannot be wrapped by hand.
 *
 * Spaces inside `**bold**` and `` `code` `` spans are masked before the split,
 * so a span is always one token: breaking a line inside one would break the
 * markup, and splitting punctuation off the end of one ("`code` .") would
 * strand it. Masking preserves token widths, so the wrap stays exact.
 */
function paragraph(text: string): string[] {
  const masked = text
    .trim()
    .replace(/\*\*[^*]+\*\*|`[^`]+`/g, (span) =>
      span.replaceAll(" ", SPACE_SENTINEL),
    );

  const lines: string[] = [];
  let line = "";

  for (const token of masked.split(/\s+/).filter(Boolean)) {
    if (line.length === 0) {
      line = token;
    } else if (line.length + 1 + token.length <= WRAP_WIDTH) {
      line = `${line} ${token}`;
    } else {
      lines.push(line);
      line = token;
    }
  }

  if (line.length > 0) lines.push(line);

  return [...lines.map((l) => l.replaceAll(SPACE_SENTINEL, " ")), ""];
}

function fail(message: string): never {
  console.error(`scoreboard: ${message}`);
  process.exit(1);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function runNodeScript(args: string[]): { stdout: string; status: number } {
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    fail(`failed to spawn node: ${formatError(result.error)}`);
  }

  return { stdout: result.stdout ?? "", status: result.status ?? 1 };
}

function readTapCount(tap: string, field: keyof TapCounts): number {
  const match = new RegExp(`^# ${field} (\\d+)$`, "m").exec(tap);
  if (!match?.[1]) {
    fail(`could not read "# ${field}" from the TAP output`);
  }
  return Number.parseInt(match[1], 10);
}

function readTapCounts(tap: string): TapCounts {
  return {
    tests: readTapCount(tap, "tests"),
    pass: readTapCount(tap, "pass"),
    fail: readTapCount(tap, "fail"),
    skipped: readTapCount(tap, "skipped"),
  };
}

/**
 * Top-level `ok N - title` lines are the `describe()` suites: every parity
 * case lives inside one, so only the suite lines sit at zero indentation.
 */
function readTapSuiteTitles(tap: string): string[] {
  const titles: string[] = [];
  for (const line of tap.split("\n")) {
    const match = /^(?:not )?ok \d+ - (.+)$/.exec(line);
    if (match?.[1]) titles.push(match[1]);
  }
  return titles;
}

function readTapKnownGaps(tap: string): string[] {
  const pattern = new RegExp(
    `^\\s+(?:not )?ok \\d+ - ${KNOWN_GAP_PREFIX}(.+?) # SKIP\\s*$`,
  );

  const gaps: string[] = [];
  for (const line of tap.split("\n")) {
    const match = pattern.exec(line);
    if (match?.[1]) gaps.push(match[1]);
  }
  return gaps;
}

function listParityFiles(): string[] {
  return readdirSync(PARITY_DIR)
    .filter((name) => name.startsWith(PARITY_PREFIX) && name.endsWith(".ts"))
    .sort()
    .map((name) => path.posix.join(PARITY_DIR, name));
}

function runParitySuite(file: string): ParitySuite {
  const { stdout, status } = runNodeScript([
    "--test",
    "--test-reporter=tap",
    file,
  ]);

  const counts = readTapCounts(stdout);

  if (status !== 0 || counts.fail > 0) {
    fail(
      `${file} is not green (${counts.fail} failing) — the scoreboard only publishes a green tree`,
    );
  }

  return {
    ...counts,
    file,
    titles: readTapSuiteTitles(stdout),
    gaps: readTapKnownGaps(stdout),
  };
}

function runUnitTests(): TapCounts {
  const { stdout, status } = runNodeScript([
    "--test",
    "--test-reporter=tap",
    "test/**/*.test.ts",
  ]);

  const counts = readTapCounts(stdout);

  if (status !== 0 || counts.fail > 0) {
    fail(
      `npm test is not green (${counts.fail} failing) — the scoreboard only publishes a green tree`,
    );
  }

  return counts;
}

function runPerfBench(): PerfPayload {
  const { stdout, status } = runNodeScript(["script/perf-bench.ts", "--json"]);
  if (status !== 0) fail("script/perf-bench.ts exited non-zero");

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    fail(`could not parse perf-bench JSON: ${formatError(error)}`);
  }

  if (!isObject(parsed) || !isObject(parsed.responsiveness)) {
    fail("perf-bench JSON is missing the responsiveness block");
  }

  return parsed as unknown as PerfPayload;
}

function runPackDryRun(): PackFootprint {
  let raw: string;
  try {
    raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
  } catch (error) {
    fail(`npm pack --dry-run --json failed: ${formatError(error)}`);
  }

  const parsed: unknown = JSON.parse(raw);
  let first: Record<string, unknown>;
  try {
    first = extractPackResult(parsed);
  } catch (error) {
    fail(formatError(error));
  }
  const files = first.files;
  const size = first.size;
  const unpackedSize = first.unpackedSize;

  if (
    !Array.isArray(files) ||
    typeof size !== "number" ||
    typeof unpackedSize !== "number"
  ) {
    fail("npm pack --dry-run --json is missing files[] / size / unpackedSize");
  }

  return { files: files.length, size, unpackedSize };
}

/**
 * The budgets are the single source of truth in `script/pack-check.ts`; read
 * them back rather than restating them, so the two can never disagree.
 */
function readPackBudgets(): PackBudgets {
  const source = readFileSync(path.join(REPO_ROOT, PACK_CHECK_PATH), "utf8");

  const read = (key: keyof PackBudgets): number => {
    const match = new RegExp(`${key}: (\\d+)`).exec(source);
    if (!match?.[1]) fail(`could not read ${key} from ${PACK_CHECK_PATH}`);
    return Number.parseInt(match[1], 10);
  };

  return {
    maxFiles: read("maxFiles"),
    maxSize: read("maxSize"),
    maxUnpackedSize: read("maxUnpackedSize"),
  };
}

function readNvimVersion(): string {
  try {
    const out = execFileSync("nvim", ["--version"], { encoding: "utf8" });
    return out.split("\n")[0]?.trim() ?? "unknown";
  } catch (error) {
    fail(
      `nvim is not on PATH, so the parity suites cannot run: ${formatError(error)}`,
    );
  }
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatKib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function spread(metric: SampledMetric): number {
  return metric.stats.max - metric.stats.min;
}

function formatMsRange(metric: SampledMetric): string {
  return `${metric.stats.min.toFixed(1)}–${metric.stats.max.toFixed(1)} ms`;
}

function formatKibRange(metric: SampledMetric): string {
  return `${(metric.stats.min / 1024).toFixed(1)}–${(metric.stats.max / 1024).toFixed(1)} KiB`;
}

/**
 * The startup delta is a difference of two ~600 ms process launches whose own
 * run-to-run spread is tens of milliseconds, and `index.ts` imports the host,
 * so the extension launch is measured second with the host's modules already
 * warm. Say which of those two regimes this run landed in rather than printing
 * a headline number the harness cannot support.
 */
function renderStartupReading(delta: number, hostSpread: number): string[] {
  if (delta < 0) {
    return paragraph(`
      Subtracting those two medians gives **${delta.toFixed(1)} ms** for pi-vim's own
      share — a negative cost, which is the harness saying the two launches are
      indistinguishable. The extension import is measured second, so it reuses
      the module and page caches the host import just warmed. Read this as
      *below the noise floor*, never as a speedup.
    `);
  }

  if (delta < hostSpread) {
    return paragraph(`
      Subtracting those two medians gives **${delta.toFixed(1)} ms** for pi-vim's own
      share, but the host import's own run-to-run spread is
      **${hostSpread.toFixed(1)} ms** — wider than the gap itself — and the extension
      import is measured second, on caches the host import warmed. Treat it as
      an upper bound rather than a measurement; on a loaded machine the same
      subtraction comes out negative.
    `);
  }

  return paragraph(`
    Subtracting those two medians gives **${delta.toFixed(1)} ms** for pi-vim's own
    share, above the host import's ${hostSpread.toFixed(1)} ms run-to-run spread. The
    extension import is still measured second, on caches the host import warmed,
    so read it as a lower bound; on a loaded machine the same subtraction has
    come out negative.
  `);
}

function suiteLabel(suite: ParitySuite): string {
  return suite.titles.length > 0 ? suite.titles.join(" + ") : suite.file;
}

function renderParitySection(suites: ParitySuite[]): string[] {
  const lines: string[] = [];

  lines.push("## parity against real nvim");
  lines.push("");
  lines.push(
    ...paragraph(`
      Each case drives headless nvim and pi-vim through the same keystrokes from
      the same buffer, then compares text, cursor, mode, and the unnamed
      register. A row's skips are documented divergences, listed in full below —
      never silently-passing tests.
    `),
  );

  lines.push("| suite | pass | fail | skip |");
  lines.push("| --- | ---: | ---: | ---: |");

  const totals = { pass: 0, fail: 0, skipped: 0 };
  for (const suite of suites) {
    totals.pass += suite.pass;
    totals.fail += suite.fail;
    totals.skipped += suite.skipped;
    lines.push(
      `| ${suiteLabel(suite)} | ${suite.pass} | ${suite.fail} | ${suite.skipped} |`,
    );
  }
  lines.push(
    `| **total** | **${totals.pass}** | **${totals.fail}** | **${totals.skipped}** |`,
  );
  lines.push("");

  const withGaps = suites.filter((suite) => suite.gaps.length > 0);
  if (withGaps.length === 0) {
    lines.push("No known gaps: every parity case passes.", "");
    return lines;
  }

  lines.push(
    "### known gaps",
    "",
    ...paragraph(`
      Every skipped case, verbatim from the harness. Each one is a place pi-vim
      knowingly differs from nvim; \`README.md\` explains the user-visible ones.
    `),
  );

  for (const suite of withGaps) {
    lines.push(`**${suiteLabel(suite)}**`, "");
    for (const gap of suite.gaps) lines.push(`- ${gap}`);
    lines.push("");
  }

  return lines;
}

function renderPerfSection(perf: PerfPayload): string[] {
  const lines: string[] = [];
  const startup = perf.startup;
  const memory = perf.memory;

  lines.push(
    "## performance",
    "",
    ...paragraph(`
      From \`script/perf-bench.ts\`. Startup and heap ask what pi-vim adds to a Pi
      process; responsiveness asks how long \`handleInput\` takes to turn a
      keystroke into an edit. Rendering is excluded throughout.
    `),
  );

  lines.push(
    "### startup",
    "",
    ...paragraph(`
      Median and range over ${perf.startupRuns} cold process launches. \`index.ts\`
      imports the Pi host, so the last two rows share almost all of their work.
    `),
    "| stage | median | min–max |",
    "| --- | ---: | ---: |",
    `| node runtime only | ${startup.runtime_only.stats.median.toFixed(1)} ms | ${formatMsRange(startup.runtime_only)} |`,
    `| Pi host import | ${startup.host_import.stats.median.toFixed(1)} ms | ${formatMsRange(startup.host_import)} |`,
    `| + pi-vim import | ${startup.extension_import.stats.median.toFixed(1)} ms | ${formatMsRange(startup.extension_import)} |`,
    "",
    ...renderStartupReading(
      perf.startupIncrementalMs,
      spread(startup.host_import),
    ),
    "",
  );

  const memorySpread = Math.max(
    spread(memory.host_import),
    spread(memory.extension_import),
  );

  lines.push(
    "### memory",
    "",
    ...paragraph(`
      Median \`heapUsed\` right after import, over ${perf.memoryRuns} runs with gc
      forced.
    `),
    "| stage | median heap | min–max |",
    "| --- | ---: | ---: |",
    `| Pi host import | ${formatKib(memory.host_import.stats.median)} | ${formatKibRange(memory.host_import)} |`,
    `| + pi-vim import | ${formatKib(memory.extension_import.stats.median)} | ${formatKibRange(memory.extension_import)} |`,
    `| **pi-vim's own heap** | **${formatKib(perf.memoryIncrementalBytes)}** | — |`,
    "",
    ...paragraph(`
      Unlike startup, this difference is resolvable: it is
      ${(perf.memoryIncrementalBytes / memorySpread).toFixed(0)}× the widest run-to-run
      spread of either row (${formatKib(memorySpread)}).
    `),
  );

  lines.push(
    "### responsiveness",
    "",
    ...paragraph(`
      Time spent inside \`handleInput\`. A *keystroke* row times one key; a
      *command* row times every key of the command, count digits included.
    `),
    "| operation | per | median | p95 |",
    "| --- | --- | ---: | ---: |",
  );

  const slowestByKind = new Map<MetricKind, [MetricLabel, SampledMetric]>();

  for (const [key, metric] of Object.entries(perf.responsiveness)) {
    const known = RESPONSIVENESS_LABELS[key];

    if (known) {
      const best = slowestByKind.get(known.kind);
      if (!best || metric.stats.median > best[1].stats.median) {
        slowestByKind.set(known.kind, [known, metric]);
      }
    }

    lines.push(
      `| ${known?.label ?? `\`${key}\``} | ${known?.kind ?? "—"} | ${metric.stats.median.toFixed(2)} µs | ${metric.stats.p95.toFixed(2)} µs |`,
    );
  }
  lines.push("");

  const slowestKeystroke = slowestByKind.get("keystroke");
  const slowestCommand = slowestByKind.get("command");

  if (slowestKeystroke && slowestCommand) {
    lines.push(
      ...paragraph(`
        The costliest single keystroke is ${slowestKeystroke[0].label}, at
        ${slowestKeystroke[1].stats.median.toFixed(0)} µs; the costliest whole command is
        ${slowestCommand[0].label}, at ${slowestCommand[1].stats.median.toFixed(0)} µs. Both
        scale with the text they walk — the \`w\` and \`b\` ladders from 20 to 400
        words isolate that scaling.
      `),
    );
  }

  return lines;
}

function renderPackSection(
  pack: PackFootprint,
  budgets: PackBudgets,
): string[] {
  return [
    "## published footprint",
    "",
    ...paragraph(`
      From \`npm pack --dry-run\`, against the budgets \`npm run pack:check\`
      enforces on every commit. Tests and docs are excluded from the package, so
      only shipped code and \`README.md\` count.
    `),
    "| measure | actual | budget | headroom |",
    "| --- | ---: | ---: | ---: |",
    `| files | ${pack.files} | ${budgets.maxFiles} | ${budgets.maxFiles - pack.files} |`,
    `| packed size | ${formatNumber(pack.size)} B | ${formatNumber(budgets.maxSize)} B | ${formatNumber(budgets.maxSize - pack.size)} B |`,
    `| unpacked size | ${formatNumber(pack.unpackedSize)} B | ${formatNumber(budgets.maxUnpackedSize)} B | ${formatNumber(budgets.maxUnpackedSize - pack.unpackedSize)} B |`,
    "",
  ];
}

function readHostVersion(name: string): string {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(findPackageRoot(name), "package.json"), "utf8"),
  );
  if (!isObject(manifest) || typeof manifest.version !== "string") {
    fail(`missing installed host version for ${name}`);
  }
  return manifest.version;
}

function renderDocument(data: {
  date: string;
  host: string;
  nvimVersion: string;
  cpu: string;
  platform: string;
  suites: ParitySuite[];
  unit: TapCounts;
  perf: PerfPayload;
  pack: PackFootprint;
  budgets: PackBudgets;
}): string {
  const lines: string[] = [];

  lines.push(
    "<!-- Generated by script/scoreboard.ts. Do not edit by hand: run",
    "     `npm run scoreboard -- --write` to refresh it. -->",
    "",
    "# scoreboard",
    "",
    ...paragraph(`
      What pi-vim's own harnesses report about it: how closely it tracks real
      nvim, what it costs a Pi process, and how big it ships. Every number below
      is generated — \`npm run scoreboard\` reprints this document from the
      suites themselves.
    `),
    "| | |",
    "| --- | --- |",
    `| measured | ${data.date} |`,
    `| node | ${data.perf.nodeVersion} |`,
    `| pi host | ${data.host} |`,
    `| nvim | ${data.nvimVersion} |`,
    `| platform | ${data.platform} |`,
    `| cpu | ${data.cpu} |`,
    "",
    ...paragraph(`
      Timings are machine-dependent, and the startup figure is fragile enough
      that the performance section spells out how to read it. Parity counts and
      the package footprint are neither — they reproduce anywhere.
    `),
  );

  lines.push(...renderParitySection(data.suites));

  lines.push(
    "## unit tests",
    "",
    ...paragraph(`
      \`npm test\` covers the pure modules and \`ModalEditor\`'s observable
      behavior:
      **${formatNumber(data.unit.pass)} pass, ${data.unit.fail} fail, ${data.unit.skipped} skip**.
    `),
    ...paragraph(`
      The EX-to-Pi command bridge has no parity suite by design — it is a Pi
      integration surface, not a vim motion, so nvim has nothing to say about
      it. Unit tests cover it alone.
    `),
  );

  lines.push(...renderPerfSection(data.perf));
  lines.push(...renderPackSection(data.pack, data.budgets));

  lines.push(
    "## reproducing this",
    "",
    "```sh",
    "npm ci",
    "npm test           # unit tests",
    "npm run test:nvim  # parity suites (needs nvim on PATH)",
    "npm run pack:check # published footprint vs budgets",
    "npm run scoreboard # regenerate this document",
    "```",
    "",
  );

  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

function main(): void {
  const write = process.argv.includes("--write");

  const nvimVersion = readNvimVersion();
  const suites = listParityFiles().map(runParitySuite);
  if (suites.length === 0) fail("found no test/nvim-parity*.ts suites");

  const unit = runUnitTests();
  const perf = runPerfBench();
  const pack = runPackDryRun();
  const budgets = readPackBudgets();

  const document = renderDocument({
    date: new Date().toISOString().slice(0, 10),
    host: `coding-agent ${readHostVersion("@earendil-works/pi-coding-agent")} / pi-tui ${readHostVersion("@earendil-works/pi-tui")}`,
    nvimVersion,
    cpu: cpus()[0]?.model ?? "unknown",
    platform: `${process.platform}-${process.arch}`,
    suites,
    unit,
    perf,
    pack,
    budgets,
  });

  if (!write) {
    process.stdout.write(document);
    return;
  }

  writeFileSync(path.join(REPO_ROOT, DOC_PATH), document, "utf8");
  console.log(`scoreboard: wrote ${DOC_PATH}`);
}

main();
