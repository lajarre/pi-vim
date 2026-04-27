# OS-backed clipboard register spec

## context

`pi-vim` implements a Vim-like unnamed register for delete, change, yank, and put commands. The desired default is to match Vim with `set clipboard=unnamed`: the unnamed register is backed by the operating-system clipboard, while pi-vim keeps an internal shadow register for resilience.

Clipboard integration must stay bounded. Clipboard backends can be slow, unavailable, terminal-dependent, or platform-specific, and editing must not depend on every OS clipboard operation succeeding.

## goals

- Make the unnamed register OS-backed by default, matching Vim's `set clipboard=unnamed` behavior.
- Keep delete/change/yank register writes synchronous from the editor's perspective.
- Mirror local register writes to the OS clipboard best-effort without blocking the editor loop.
- Coalesce rapid local register writes so, after writes settle, only the latest pending value is mirrored.
- Make `p` and `P` read OS clipboard text first.
- Fall back to the internal shadow register when OS clipboard reads fail or time out.
- Preserve immediate local yank/delete/change → put ordering by using the shadow while a local mirror is still pending or in flight.
- Treat an empty OS clipboard text read as a successful empty value, not as a failure.
- Keep platform clipboard backend ownership with Pi-compatible clipboard behavior wherever possible.

## non-goals

- Preserve every intermediate OS clipboard value during rapid register writes.
- Guarantee OS clipboard updates on every machine, terminal, display server, or backend.
- Add user-facing warnings for clipboard mirror failures.
- Add a register configuration option in this slice.
- Implement named registers.
- Reimplement every platform clipboard backend in pi-vim.

## behavioral contract

```text
local delete/change/yank
  -> update internal shadow synchronously
  -> enqueue best-effort OS clipboard mirror
  -> rapid writes coalesce to the latest pending value

p / P
  -> if local mirror pending/in flight: use internal shadow
  -> otherwise read OS clipboard text first
  -> on OS read failure/timeout: use internal shadow
```

Rules:

1. Register writes are synchronous and never wait for the OS clipboard.
2. Clipboard mirror failures are swallowed.
3. A newer mirror request replaces any pending request.
4. A newer mirror request does not abort an active write solely for staleness.
5. Active writes may be aborted for timeout or explicit writer replacement in tests.
6. While a local mirror is pending or active, `p` and `P` use the internal shadow to preserve same-editor ordering.
7. When no local mirror is pending or active, `p` and `P` prefer OS clipboard text.
8. `null` from the clipboard read path means failure and falls back to the shadow.
9. `""` from the clipboard read path means a successful empty clipboard and causes a no-op put.
10. Repeated helper spawn/environment failures disable mirroring for the current process.

## platform notes

- macOS and Windows native clipboard writes are delegated through Pi-compatible behavior.
- Linux clipboard behavior is best-effort across Wayland, X11, Termux, and terminal OSC 52 support.
- Wayland `wl-copy` fallback ownership is best-effort in this slice; pi-vim documents the caveat rather than guaranteeing every stale owner can be fenced.
- SSH / OSC 52 behavior is terminal-dependent.

## acceptance tests

- `dw` followed immediately by `p` pastes the just-deleted text even if the OS clipboard still contains older text.
- After a local mirror settles, `p` and `P` read a changed OS clipboard value instead of stale shadow text.
- A failed or timed-out OS clipboard read falls back to the shadow register.
- A successful empty OS clipboard read causes `p` / `P` to no-op instead of pasting stale shadow text.
- Rapid local writes do not block editing and coalesce mirror work to the latest pending value.
- A timed-out mirror write is aborted and later pending text can still mirror.
- Repeated spawn/environment failures disable further mirror attempts while register writes continue.
- README states the OS-backed unnamed-register default and notes that an internal-only mode may become optional later.
