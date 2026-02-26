# Config

| Field | Value |
|---|---|
| chain | `inline-3-step (implementer -> spec-reviewer -> code-quality-reviewer)` |
| batch_size | 3–5 |
| verify_commands | `npm test`<br/>`node --import tsx/esm script/perf-bench.ts --json` |
| plan_path | `doc/feature/2026-02-26-deep-optimization-path/plan.md` |
| spec_path | `doc/feature/2026-02-26-deep-optimization-path/spec.md` |
| tracker_path | `TODO-d7eef400` |

# Pre-Flight

- [ ] Node+tsx runtime available (`node --import tsx/esm -e ""`)
- [ ] Baseline test suite passes (`npm test`)
- [ ] Working tree clean before first dispatch
- [ ] No external credentials/services required for this plan

# Probe

- [ ] Attempt: `try-01`
  - Probe result: `PENDING`
  - Action: `pending`

# Memory

- _none yet_
