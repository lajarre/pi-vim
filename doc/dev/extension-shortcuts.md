# Normal-mode extension shortcuts

Pi extension-only control/Alt shortcuts previously reached CustomEditor only in
Insert. Normal admitted only recognized app actions. For example, registering
`alt+u` for a session rewind did nothing in Normal.

Normal now probes `onExtensionShortcut` for control/escape-prefixed input after
app-action routing and before pending Vim commands. A handled shortcut clears
pending counts/operators and cancels repeat recording, without falling back to
Pi's text editing. Plain printable input, Enter, cursor aliases, modal Escape,
Vim history, EX and Visual/V-Line retain their existing ownership. This is a
host integration policy, intentionally not nvim parity.

Focused tests cover legacy/Kitty Alt-U, Ctrl-U, pending counts/operators,
shortcut-driven buffer replacement, unhandled controls, unchanged Insert
routing, EX/Visual exclusion, paste, printable Vim keys, cursor aliases and
undo/redo. Existing app/EX ownership tests remain in place.

## Input-path evidence

Base `500929e` vs this change, Node v26.13.0, Linux x64, installed peers from
`npm ci`. Three serial rounds using `script/hotpath-compare.ts`, in base/head,
head/base, base/head order; eight samples per operation per run. Table shows
median of the three run medians/p95s in microseconds/op:

| Operation | Base median | Base p95 | Head median | Head p95 |
| --- | ---: | ---: | ---: | ---: |
| noop_key | 4.088 | 4.556 | 3.919 | 4.418 |
| motion_h_4k | 800.623 | 813.970 | 766.159 | 842.064 |
| motion_w_50 | 4.609 | 5.812 | 4.758 | 5.443 |
| insert_type | 17.495 | 18.344 | 18.241 | 18.434 |
| insert_edit | 31.250 | 32.490 | 31.459 | 32.481 |

The first-byte guard avoids key decoding/grapheme segmentation for plain
printable inputs. This is not a speedup claim: the wide-line p95 increased
about 3.5%, and Insert typing median about 4.3%, despite Insert returning before
the added branch. These are batch timings under local load, not terminal
latency bounds. The harness does not measure a real extension callback.

Reproduce with a base checkout sharing the same installed dependencies:

```sh
PIVIM_ENTRY=/path/to/base/index.ts node --import tsx/esm script/hotpath-compare.ts
node --import tsx/esm script/hotpath-compare.ts
```

`pack:check`: 77,322 B packed / 294,076 B unpacked / 20 files. Existing
thresholds pass without changes; no runtime dependency or packed file added.

## Manual QA

- Register an `alt+u` rewind extension in Pi, load pi-vim, and `/reload`.
- From Insert, then Normal, invoke Alt-U on an empty editor; verify the last
  user prompt is restored and the session rewinds exactly once.
- In Normal enter a count/operator prefix, invoke the shortcut, then move;
  verify no count/operator leaks. Keep the extension's draft/idle guards.
- In EX and Visual modes verify Alt-U does not invoke the extension-only hook.
- Verify `/tree` retains its contextual filter bindings and fullscreen scrolling
  still owns its configured keys before editor dispatch.

The user verified Normal-mode Alt-U using the initial local patch. The focused
suite simulates the refined upstream routing; the complete terminal checklist
above has not been rerun against this checkout. The maintainer's external QA
runbook is not available here; these steps are provided for inclusion there.
