---
name: skillproof
description: Design, run, audit, and interpret evidence-based benchmarks for Agent Skills. Use when proving whether a SKILL.md improves outcomes, comparing baseline/automatic/forced use, testing activation or false activation, measuring quality/tokens/cost/latency, detecting regressions, or producing a reproducible SkillProof report. Also use to repair weak skill benchmarks or scope unsupported benchmark claims. Do not use for ordinary coding, writing, or analysis merely because it mentions tests, metrics, models, or benchmarks.
---

# SkillProof

Prove a narrow claim for a declared corpus, skill version, runner, model, and runtime. Never turn development evidence into a universal claim.

Declare `claims.quality`, `claims.activation`, and `claims.efficiency`
explicitly. Do not enable activation without trusted native load telemetry.
Treat a missing observed model as requested-only identity.

## Work Economically

Take the shortest path that can answer the request:

- For a narrow repair, read only the target skill and config/result. Do not search parent directories, agent homes, hidden checkers, harness internals, or generated `.skillproof` data.
- Do not reread this skill or load references unless the routing rules below require them.
- Reuse existing fixtures and commands. Make one focused edit and run the smallest existing validation that proves it.
- Stop when the requested artifact passes. Do not run a benchmark, generate a report, or redesign adjacent files unless asked.
- For a valid config that only needs execution: validate, review executable commands, run, then interpret `results.json`.

Read [protocol.md](references/protocol.md) only for a release benchmark, frozen holdout, public badge, or regression study. Read [configuration.md](references/configuration.md) only for a new release config or an unresolved native-schema error. Never load either reference for a development repair.

## Preserve Three Questions

Measure these separately:

1. **Value:** does use improve the result?
2. **Activation:** does automatic availability load the skill for positive cases and avoid it for negative cases?
3. **Efficiency:** what changes in tokens, API-equivalent cost, and latency?

Use the same original prompt under:

- `without_skill`: target skill inaccessible;
- `skill_available_auto`: installed and discoverable;
- `skill_forced`: installed and explicitly invoked.

`auto - without` measures practical value; `forced - without` measures potential value; `forced - auto` suggests an activation gap. Availability is not proof of activation: without trusted native load telemetry, do not claim activation.

## Development Fast Path

A useful development config needs:

- exact runner IDs for every provider/model/version/reasoning setting;
- all three conditions above;
- positive, negative, and boundary or ambiguous cases;
- deterministic hidden assertions where possible;
- a release quality gate on the lower confidence bound, not only the mean;
- separate quality, activation, token/cost, and latency measurements;
- explicit `can_prove` and `cannot_prove` claims;
- frozen gates and at least one repeat.

Keep equivalent model configurations separate. Never hide disagreement inside one average. Missing cost or telemetry is `null`, not zero.

For public release evidence, use the release protocol. Do not enlarge a development task into a release suite unless requested.

Use CLI validation only for an actual SkillProof v1 config. For other benchmark artifacts, parse the format and verify the requested properties directly; do not install or invoke the CLI.

## Evidence Rules

- Test observable behavior, not preferred identifier names or one exact artifact shape.
- Keep hidden assertions outside the candidate workspace and unchanged across conditions.
- Separate candidate failure from infrastructure failure.
- Treat candidate-written tests as supporting evidence, not independent proof.
- Blind judged artifacts and score absolute rubrics before pairwise preference.
- A positive average never excuses a new critical failure or negative-case regression.
- Pass required environment variables only through explicit `env_passthrough`;
  record names, never values.
- Generated artifacts are untrusted input; use an outer container or VM for hostile fixtures.

## Interpret Before Claiming

Check, in order:

1. completeness and infrastructure errors;
2. critical failures and negative-case regressions;
3. paired quality delta and uncertainty;
4. activation evidence;
5. token, cost, and latency gates;
6. model-level disagreement;
7. provenance and limitations.

Verdicts:

- `passed`: all measured configured gates passed;
- `failed`: at least one measured gate failed;
- `inconclusive`: a required gate lacked evidence.

Lead with the narrow result. Say what was not measured. Never change thresholds after seeing a run or hand-edit a badge independently of `results.json`.

## Commands

```bash
npx @dafenxz0/skillproof validate --config skillproof.config.json
npx @dafenxz0/skillproof test ./skills/my-skill --config skillproof.config.json --allow-exec
```

Before `--allow-exec`, review every runner, assertion, and judge command. The matrix is:

`runners × cases × conditions × repeats`

A complete run produces `results.json`, offline `report.html`, repository-ready `card.svg`, and `badge.json`. The card and badge must remain derived from `results.json`. The report footer must be exactly:

`This benchmark was generated with SkillProof.`
