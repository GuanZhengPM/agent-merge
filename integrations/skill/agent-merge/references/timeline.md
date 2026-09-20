# Timeline workflows

## Checkpoint and resume

Inspect before appending:

```bash
agent-merge root
agent-merge status
agent-merge log
agent-merge branch
```

Use `materialize <ref> --pretty` for the model-visible record and `diff <a> <b>` for divergent evidence. Do not infer branch contents from names.

Append meaningful requirements, actions, observations, and conclusions as their actual event kinds:

```json
{"kind":"tool_result","at":1723456789000,"actor":"test","payload":{"status":0,"artifact":"results/check.json","artifactHash":"<sha256>"}}
```

Use repository-relative artifact paths and SHA-256 digests. Keep main concise; raw evidence belongs on source branches or in hashed artifacts.

## Corrections

History is append-only. If a conclusion changes, append an `annotation` with:

- the superseded step id and label;
- the corrected conclusion;
- new evidence;
- remaining limits.

## Bisect

1. Identify known-good and known-bad step ids with `log`.
2. Write a bounded command that reads `$AGENT_MERGE_CONTEXT` and exits non-zero once the failure is present.
3. Run `agent-merge bisect <good> <bad> --run '<command>'`.
4. Report the first bad step, introduced events, probe count, and predicate limitations.

Freeze or repeatedly measure noisy dependencies before bisecting. A noisy predicate cannot establish a causal first-bad step.
