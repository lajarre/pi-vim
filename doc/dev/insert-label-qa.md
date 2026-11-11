# INSERT label QA

- In Pi 1.0.0, use a light terminal with color reporting disabled and the `system` theme. The default INSERT label must use normal panel/text colors, not a black reversed block.
- Repeat with the built-in `light` and `dark` themes and at narrow widths.
- Set `modeColors.insert` to another token; its mode-colored block must remain unchanged.
- Check NORMAL, VISUAL, V-LINE, EX, and host/thinking label synchronization remain unchanged.

The focused test covers absent and explicit-default insert colors at 8, 40, and 80 columns. Existing tests cover custom colors and other modes.

A temporary render harness compared unmodified `main` with this fix over 54 fixtures: 40/80/120 columns, empty/long/wide prompts, INSERT/NORMAL/EX, and cache hits/misses. Each fixture used 50 warmups and the median of five 50-render samples. Node 26.8.1, macOS arm64, repository-pinned editor peers and Pi 1.0.0's actual system theme; measurements are noisy and are not performance claims.

| 80-column INSERT cache hit | Before µs/render | After µs/render |
| --- | ---: | ---: |
| Empty | 0.790 | 0.713 |
| Long ASCII | 332.137 | 367.796 |
| Wide graphemes | 163.464 | 164.237 |
