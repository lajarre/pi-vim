# AGENTS.md

This repo is not expected, for now, to be imported as a dependency; treat exported internals as pi-vim-local unless documented otherwise.

For every new or changed Vim-like feature, add curated nvim parity coverage in `test/nvim-parity*.ts` unless the behavior is intentionally not Vim-compatible. If it is an intentional divergence, make that explicit in tests and documentation.

Known nvim parity gaps may live as skipped tests. Apply the boy scout principle: when a branch touches the relevant behavior, unskip and fix nearby skipped parity cases alongside the branch's own change, or document why the gap remains out of scope. Do not batch unrelated parity fixes into a conflict-heavy branch.

Behavior the harnesses cannot reach — the terminal, Pi's own prompt widgets, a real paste, a wrapping extension — is checked by hand. A branch that adds or changes such a TTY-only surface updates the maintainer QA runbook (kept outside the published tree) and adds or adjusts the corresponding simulated tests in-repo.

`doc/dev/scoreboard.md` is generated, never hand-written: it reports parity, unit, performance, and package-footprint numbers straight from the harnesses. Run `npm run scoreboard -- --write` after a branch changes parity coverage, adds a benchmark, or moves a `pack:check` budget.

Perf and hot-path changes — pull requests included — must clear the evidence bar in `doc/dev/render-perf-strategy.md`: land before/after benchmarks on the documented input set, and defer by default when there are no numbers.

When reviewing changes — including agent self-review before opening or merging a PR — follow `doc/review-guidelines.md`; its project-specific MUST-flag rules take precedence over general review heuristics.

npm publishing is automated in CI (`.github/workflows/publish.yml`): every push to `main` publishes the `package.json` version if it is not already on npm. Do not run `npm publish` or ask for publish access — to release, bump the version in `package.json`. The full release sequence (preconditions, bump, fast-forward, tag, push, GitHub release, issue and PR replies) is in `doc/dev/releasing.md`.
