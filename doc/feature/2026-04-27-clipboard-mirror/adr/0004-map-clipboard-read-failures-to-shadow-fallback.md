# 0004. Map clipboard read failures to shadow fallback

Date: 2026-04-27

## Status

Accepted

## Context

When `p` and `P` read the OS clipboard first, the editor needs deterministic behavior for backend failures and for an empty clipboard. The internal unnamed register still exists as a synchronous shadow/cache, but using it too eagerly would paste stale text when the OS clipboard was successfully read as empty.

## Decision

Clipboard read failures map to `null`. A `null` result triggers fallback to the internal unnamed-register shadow. Timeout, non-zero exit, signal, spawn error, max-buffer failure, and thrown read-seam errors are treated as failures. An empty string is a successful clipboard read and produces a no-op paste rather than falling back to stale shadow text.

## Alternatives Considered

### Treat empty string as failure
- Pros: Users might still get the last editor register content when the OS clipboard is empty.
- Cons: Makes an empty OS clipboard indistinguishable from read failure; can paste stale internal text contrary to OS-backed register semantics.

### Surface read failures as user-visible errors
- Pros: Makes backend problems explicit.
- Cons: Interrupts normal paste workflows; exposes implementation details; makes paste less resilient than the previous internal-register behavior.

### Paste nothing on any read failure
- Pros: Avoids stale shadow text entirely.
- Cons: Loses the resilience benefit of keeping the internal shadow; makes paste fail even after recent in-editor yanks/deletes.

### Use `null` for failures and reserve `""` for successful empty reads
- Pros: Separates failure from empty clipboard; preserves Vim-like OS-backed semantics; retains a fallback for backend failures.
- Cons: Backend failures are silent unless tested or observed through behavior.

## Consequences

The paste-source helper can use nullish fallback: OS text wins for all string values, including `""`; only `null` selects the shadow. Tests cover null fallback, thrown fallback, and empty-clipboard no-op behavior. Future read implementations must preserve the distinction between failure and empty success.
