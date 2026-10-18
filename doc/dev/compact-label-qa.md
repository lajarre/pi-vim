# Mode-label QA and evidence

Labels/placement are intentional Pi UI divergences; no nvim editing semantics or parity cases change.

Using disposable settings, test both styles in editor/status placement: INSERT → NORMAL → VISUAL → V-LINE, EX entry/cancellation/submission, pending `2d3f`, and Unicode EX overflow at narrow widths. Check label colors/`labelSync`, symmetric inner padding, no duplicate editor/status label, theme replacement, resize, wrappers, and `/reload`. Removing the settings must restore the full editor label.

Real Pi 1.3.0 PTY checks passed native status in both styles and compact Powerline placement, EX/count feedback, resize/reload, and editor wrappers. No prompt was submitted. Physical-terminal/IME checks remain manual.

Before/after evidence uses frozen upstream `e55b07c`, Node 24.19.0, Linux/x64, Ryzen 5800X. Default full/editor output checksums match. For overflowing Unicode EX (560 UTF-16 units, 12/80-column fixtures), optional compact/status input cost rose ~20–24 → 59–68 µs/key; input+render rose ~67–82 → 100–122 µs. The callback hashes labels, not a real footer; no speedup or performance equivalence is claimed.

Package measurement: 60004 B packed / 236372 B unpacked versus baseline 58576 / 231210, still 17 files and no dependencies. Budgets rise to 60500 / 237000 for the settings, publication/fitting code, and README; test/QA files are not shipped.

Reproducible harnesses, all samples, and limitations are archived outside this PR: [input/publication](https://github.com/francisqureshi/pi-vim/blob/2ef2907b9130bd18b14bf84643f3f91447671bee/doc/dev/status-input-evidence.md), [render](https://github.com/francisqureshi/pi-vim/blob/2ef2907b9130bd18b14bf84643f3f91447671bee/doc/dev/compact-label-evidence.md). The input/render implementation is unchanged from that measured snapshot; unrelated cursor-lifecycle changes are excluded here.
