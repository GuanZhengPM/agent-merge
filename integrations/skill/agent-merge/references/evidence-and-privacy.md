# Evidence and privacy

## Evidence envelope

A decision milestone should identify:

- objective and hypothesis;
- frozen inputs and version/configuration fingerprints;
- metrics with denominators and failure counts;
- artifact path and digest;
- scope limits and next validation gate;
- decision: continue, reject, confirm, or adopt.

Do not make a timeline annotation-only when replay or bisect matters. Preserve decisive inputs/configuration as `tool_call` and observations as `tool_result`; use `annotation` for interpretation.

## Recording policy

Default to summary recording. Redact before persistence and never record credentials merely because an upstream event is JSON.

Sensitive material includes:

- authorization headers, cookies, API keys, tokens, passwords, and environment secrets;
- personal data and attachment contents not required for the decision;
- machine-specific home-directory paths;
- large raw tool/model outputs when a digest and bounded summary suffice.

Use full recording only with explicit intent in a trusted environment. Custom integrations should provide a domain-specific redactor in addition to generic filtering.

## Product claims

Do not claim that semantic merge preserved useful knowledge merely because events were merged. When that claim matters, compare downstream task quality, context size/cost, or recovery time across `pick`, `conclusions`, and `champion`.
