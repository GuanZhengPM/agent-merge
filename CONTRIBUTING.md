# Contributing to agent-merge

## Development setup

You need Node.js ≥ 23.6 — the repo runs TypeScript natively, so there is no build step during development.

```bash
pnpm install          # workspace dependencies
pnpm run typecheck    # tsc --noEmit over src + tests, strictest settings
pnpm test             # node --test over tests/*.test.ts
pnpm run build        # emit dist/ (library + CLI)
```

## Ground rules

- **Zero runtime dependencies.** The library and CLI use `node:` builtins only. Dev dependencies are fine.
- **The object model is the contract.** Anything that changes how ids are computed (canonical JSON, object headers, step schema) is a breaking change to every existing store — treat it accordingly.
- **Determinism.** Core code must not read the wall clock or produce randomness that reaches stored content. Sanctioned exceptions, none of which reach stored bytes: `fsutil`'s temp-file names (never outlive a rename) and the advisory lock's staleness timing in `FsRefStore`.
- **Strict boundaries.** Data crossing a storage boundary gets validated (`assertStep` / `assertTrajectoryEvent`); hashes are verified on read; ref writes stay atomic.
- **Tests accompany behavior.** Every bug fix and feature lands with a test that fails without it.

## Style

`tsconfig.json` is the style guide: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. If it typechecks under those flags and reads like the surrounding code, it's fine. Keep the erasable-syntax subset of TypeScript (no enums, no namespaces, no parameter properties) so the repo stays runnable without a compile step.
