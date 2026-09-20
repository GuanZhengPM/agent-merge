# Test-gated coding orchestration

Use `agent-merge run` only for a coding task with a concrete acceptance command.

```bash
agent-merge run \
  --task task.md \
  --agents 3 \
  --runner auto \
  --test '<acceptance command>' \
  --retries 1 \
  --agent-timeout 900000 \
  --test-timeout 300000
```

The default is selection without application. Use `--apply` only when modifying the current working tree is in scope. `--dry-run` remains a compatibility alias for the safe default.

## Required gates

- Start from a clean, checked-out Git branch.
- Freeze one task and one acceptance command for all candidates.
- Only passing candidates are eligible.
- If multiple candidates pass and correctness tests do not distinguish quality, use an explicit `--judge-command` or report the deterministic smallest-patch fallback.
- If no candidate passes after repair rounds, leave the main working tree unchanged.
- Treat `--agent-command`, `--test`, and `--judge-command` as trusted shell input; worktrees isolate files but are not a security sandbox.

## Recording

`--recording summary` is the default and stores hashes, sizes, status, duration, files, and artifact references without command output or patch bodies.

- `redacted`: persist bounded output after generic redaction.
- `full`: explicit opt-in for trusted, non-sensitive environments.

Always report the recording mode, winner, whether it was applied, base commit, task hash, report path, and failures.
