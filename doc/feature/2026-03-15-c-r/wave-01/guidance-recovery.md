# wave-01 guidance recovery

## 1) missing artifacts

The following guidance paths from `LOOP.md` are not present in this
worktree:

- `.pi/todos/3aa0bb1c.md`
- `doc/feature/2026-03-03-full-vim-counts/spec.md`

Proof command:

- `rg --files | rg '3aa0bb1c|full-vim-counts'` → no matches

## 2) repo-local authoritative replacements

Use these sources as binding guidance for this wave:

- `README.md`
- `doc/feature/2026-03-15-c-r/spec.md`
- `test/modal-editor.test.ts` (count-heavy coverage)

Recovered scope and ownership from the current spec:

- Working locus: `index.ts`, `README.md`, `test/modal-editor.test.ts`,
  `test/harness.ts` (only if test seams need extension)
- Owned units: `ModalEditor` runtime, package docs (`README.md`),
  automated tests under `test/`
- Documentation impact: promote redo from deferred to supported,
  document normal-mode redo semantics and count behavior, and keep
  remaining non-goals explicit
- Promotion targets: `README.md` feature matrix and README command
  tables / out-of-scope section

## 3) binding constraints recovered from local sources

- Count state must not leak into later commands (spec count semantics;
  count-state safety tests in `test/modal-editor.test.ts`).
- `MAX_COUNT` is capped at `9999` (README count docs; count bounds tests
  such as `99999x is bounded and deletes only available text`).
- Documentation promotion targets for shipped redo behavior live in
  `README.md` and must be updated there when behavior changes.
