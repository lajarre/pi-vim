# 0003. Load the clipboard backend through Pi's dependency graph

Date: 2026-04-27

## Status

Accepted

## Context

pi-vim needs OS clipboard text for `p` and `P`, but the extension should not grow a direct runtime dependency or duplicate platform-specific clipboard backend logic. The existing write mirror already relies on Pi-owned clipboard behavior. The read path needed the same ownership boundary without importing private Pi internals.

## Decision

The clipboard read helper child process loads `@mariozechner/clipboard` through Pi's dependency graph using `createRequire(PI_CODING_AGENT_MODULE_URL)`. pi-vim does not add a direct runtime dependency on the clipboard package, does not import Pi private internals, and does not shell out to platform-specific clipboard commands.

## Alternatives Considered

### Add `@mariozechner/clipboard` as a direct pi-vim runtime dependency
- Pros: Makes the dependency explicit in pi-vim's package metadata; normal module resolution is straightforward.
- Cons: Duplicates ownership of the clipboard backend; can create version skew with Pi; expands pi-vim's runtime dependency surface.

### Import Pi private clipboard utilities
- Pros: Reuses Pi behavior directly.
- Cons: Couples pi-vim to non-public Pi internals; private refactors in Pi could break the extension.

### Shell out to platform clipboard commands
- Pros: Avoids Node package dependency concerns; can be direct on each platform.
- Cons: Requires platform-specific command selection and escaping; increases security and portability risk; duplicates backend responsibility that Pi already owns.

### Resolve Pi's public clipboard package from the helper child process
- Pros: Keeps backend ownership with Pi; avoids direct dependency and private internals; works inside the bounded child-process read architecture.
- Cons: Assumes Pi's module location remains available through `PI_CODING_AGENT_MODULE_URL`; failures become read failures and fall back to the shadow register.

## Consequences

pi-vim stays aligned with Pi's clipboard backend behavior without owning platform-specific clipboard integration. If Pi changes the public clipboard dependency boundary, the helper source may need to change. Read failures from dependency resolution follow the same shadow-fallback semantics as other clipboard read failures.
