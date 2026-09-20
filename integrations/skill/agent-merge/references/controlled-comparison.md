# Controlled comparisons

Use branches only when alternatives can share a frozen starting point.

1. Append a pre-trial checkpoint containing objective, hypothesis, shared inputs, versions, metrics, acceptance rule, and stopping rule.
2. Fork every arm from that exact step. Use names such as `trial/baseline`, `trial/a`, and `trial/b`.
3. Append directly with `--on <branch>` so concurrent writers do not move HEAD.
4. End each arm with observations, inference, limitations, artifact references, and recommendation.
5. Compare `diff` and materialized evidence before judging.

For stochastic outcomes, run an identical-control A/A check before interpreting small treatment differences. Stop with “no demonstrated improvement” when a treatment does not exceed observed noise or a predeclared practical threshold.

Separate discovery from confirmation. Cases used to design an approach cannot be its only adoption evidence.

When several layers can fail, record a funnel instead of one blended score. A generic funnel is:

`input accepted → action selected → arguments valid → dependency succeeded → structured result present → downstream delivery succeeded → user-facing claim accurate`

Adapt the layers to the task. Always preserve denominators, failures, excluded cases, and unknowns.
