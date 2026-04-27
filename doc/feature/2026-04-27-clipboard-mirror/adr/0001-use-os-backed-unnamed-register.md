# 0001. Use an OS-backed unnamed register

Date: 2026-04-27

## Status

Accepted

## Context

pi-vim already mirrored delete/change/yank writes to the OS clipboard, but `p` and `P` read only the internal unnamed register. That hybrid behavior could make the visible paste source differ from the system clipboard after another application changed the clipboard. The feature goal for wave 01 was to make default put behavior match Vim's `set clipboard=unnamed` behavior while preserving editor responsiveness and editing resilience.

## Decision

The default unnamed register is OS-backed. Delete/change/yank operations still update an internal unnamed-register shadow synchronously and mirror to the OS clipboard best-effort. `p` and `P` read the OS clipboard first and use the internal shadow only as fallback/cache when the OS clipboard read fails.

This decision supersedes earlier feature wording that described `p` and `P` as reading the internal unnamed register only.

## Alternatives Considered

### Keep the internal unnamed register as the paste source
- Pros: Fully synchronous and deterministic inside the editor process; no OS clipboard read path is needed.
- Cons: Does not match the requested Vim-like `clipboard=unnamed` default; external clipboard changes do not affect `p`/`P`; write mirroring and paste semantics remain inconsistent.

### Add a setting before changing the default
- Pros: Lets users opt into internal-only or OS-backed behavior explicitly.
- Cons: Adds configuration surface before there is a proven need; increases documentation and test matrix; delays fixing the default contract.

### Make the OS clipboard the default unnamed register with a shadow fallback
- Pros: Matches the requested Vim-like default; external clipboard changes become the paste source; the synchronous shadow remains available when OS reads fail.
- Cons: Puts now depend on bounded OS clipboard reads and can briefly block on explicit paste commands.

## Consequences

The README now describes the unnamed register as OS-backed by default. Future work that adds register configuration should treat internal-only mode as an explicit option rather than the default. Existing write behavior remains best-effort and coalesced, while paste behavior now reflects the OS clipboard whenever it can be read quickly.
