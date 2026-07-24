# SkillProof self-development benchmark

This is a small, public engineering check for the SkillProof skill itself. It
compares:

- GPT-5.6 Luna with medium reasoning;
- GPT-5.6 Terra with high reasoning;
- clean baseline, automatic availability, and forced use;
- one positive benchmark-design task and one adjacent negative coding task.

Run it with:

```bash
npm run benchmark:self
```

The Windows configuration opts into `danger-full-access` for these trusted,
disposable fixtures because the tested native Codex build degraded
`workspace-write` to read-only. Do not copy that setting into a benchmark that
contains untrusted material. Use a container or virtual machine instead.

## Current evidence status

No release score is checked into the repository. Development iterations exposed
and fixed two benchmark defects:

1. a native Windows sandbox mismatch that prevented candidate writes;
2. an assertion that rewarded one exact JSON shape instead of equivalent
   benchmark behavior.

After those repairs, saved local development artifacts showed the granular
checker distinguishing baseline, automatic, and forced outputs. The final full
matrix could not produce candidates because the provider usage quota was
exhausted. SkillProof now classifies that outcome as an infrastructure failure,
so it cannot be mistaken for a skill regression.

This two-case, one-repeat, public corpus is intentionally not release evidence.
A publishable claim needs a frozen holdout, more cases and repeats, trusted
activation telemetry, and independent review where judgment is required.
