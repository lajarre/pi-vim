# 0002. Read the clipboard synchronously in a bounded child process

Date: 2026-04-27

## Status

Accepted

## Context

`handleInput()` and normal-mode editing commands are synchronous. Making `p` and `P` read the OS clipboard introduces I/O at command time. The implementation needed to preserve the existing synchronous command model while preventing a clipboard backend from hanging the editor indefinitely or producing unbounded output.

## Decision

Explicit `p` and `P` commands perform a synchronous clipboard read through `spawnSync()` in a helper child process. The child process uses a fixed argument vector, no shell, ignored stderr, `stdout` capped at 1 MiB, a 750 ms timeout, and `windowsHide: true`. The read happens only for explicit put commands, not for every yank/delete/change.

## Alternatives Considered

### Make `handleInput()` asynchronous
- Pros: Avoids blocking the event loop while the clipboard backend responds.
- Cons: Requires changing a broad editor-command contract; risks reentrancy and ordering bugs; expands the scope beyond paste behavior.

### Read the clipboard in process
- Pros: Avoids child-process startup cost; simpler data flow.
- Cons: Couples the editor process directly to clipboard backend behavior; failures or backend hangs can affect the editor process; does not isolate dependency loading.

### Use a bounded synchronous child process for explicit puts
- Pros: Preserves the current command API; isolates backend work; bounds hangs and output size; limits blocking to user-requested paste commands.
- Cons: Adds process startup overhead to paste; a slow clipboard backend can still block the editor until the timeout.

## Consequences

Normal-mode command handling remains synchronous. Paste may block briefly, but the timeout and buffer cap prevent unbounded process lifetime or memory growth. Future changes to clipboard reads should preserve the bounded execution contract unless they intentionally redesign the editor input pipeline.
