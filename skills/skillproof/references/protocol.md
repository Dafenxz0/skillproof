# SkillProof Release Protocol

Use this protocol for public claims. Smaller suites are suitable for development, not generalization.

## Experimental Unit

The cluster is the task case. Repeats estimate stochastic variation but do not create new task diversity.

For each runner, execute every frozen case under:

1. `without_skill`
2. `skill_available_auto`
3. `skill_forced`

Randomize condition order inside each case/repeat block. Keep prompts and non-target tools identical.

## Recommended Corpus

- 12 or more public development cases.
- 40 frozen evaluation cases: 20 positive and 20 negative.
- Three independent repeats per case and condition.
- Ambiguous cases remain diagnostic and do not enter headline activation rates.

Keep a holdout inaccessible to the skill author during iteration. Rotate it after publication or tuning.

## Primary Endpoint

Predeclare one primary endpoint. Normally:

`positive-case automatic quality − without-skill quality`

Use task-paired differences and a task-cluster bootstrap confidence interval.

Secondary endpoints:

- forced quality delta;
- automatic activation recall and precision;
- false activation rate;
- negative-case quality delta;
- new critical failures;
- median token/cost changes;
- p95 latency change.

## Activation

Runtime telemetry should distinguish:

- catalog exposed;
- skill selected;
- resource loaded;
- script or asset used;
- activation timestamp;
- activation failure.

The binary v1 endpoint is resource loaded or a native equivalent.

Report Wilson intervals and raw denominators for activation proportions. If no run activated, precision is undefined rather than zero.

## Blind Review

Assign random candidate labels per artifact. Strip transport metadata but do not change semantic content. Ask reviewers to score absolute rubrics and cite files, tests, screenshots, or behavior.

Use two reviewers. Predeclare a third-reviewer trigger, such as:

- more than 15 points disagreement;
- opposite winners;
- conflicting critical findings.

Report inter-rater agreement, adjudication rate, and compromised blinding.

## Regressions

Treat any of these as a regression:

- a newly failing critical assertion;
- a paired quality loss past the frozen margin;
- a previously passing frozen assertion now failing;
- a negative-case scope expansion;
- false activation increase;
- a frozen token/cost/latency gate breach.

Do not let average improvement hide a critical regression.

## Provenance

Record:

- target skill hash and commit;
- config and case hashes;
- exact runner, model, version, and model settings;
- tools and other available skills;
- runtime/container and operating system;
- price catalog hash and date;
- raw provider telemetry;
- artifact hashes;
- every failed, excluded, and rerun generation;
- reviewer identity or stable pseudonym and rubric version.

## Validity Threats

Always consider:

- public-case overfitting;
- treatment leakage;
- demand effects in forced runs;
- weak blinding;
- same-author benchmark bias;
- judge self-preference and verbosity bias;
- model/runtime drift;
- synthetic fixture bias;
- ceiling effects;
- cherry-picked seeds or discarded failures;
- repeat-level pseudoreplication;
- artifact prompt injection;
- claims broader than the sampled corpus.

Human accountability remains necessary for ambiguous applicability, rubric design, visual quality, provenance, privacy, license review, safety, disagreement adjudication, and release wording.
