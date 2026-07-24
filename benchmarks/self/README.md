# SkillProof self-development benchmark

This is a small, public engineering check for the SkillProof skill itself. It
compares:

- GPT-5.6 Luna with medium reasoning;
- GPT-5.6 Terra with high reasoning;
- clean baseline, automatic availability, and forced use;
- two positive benchmark/evidence tasks and two adjacent negative coding tasks.

Run it with:

```bash
npm run benchmark:self
```

Before spending on the full matrix, run the worst-case one-model canary:

```bash
npm run benchmark:efficiency
```

The Windows configuration opts into `danger-full-access` for these trusted,
disposable fixtures because the tested native Codex build degraded
`workspace-write` to read-only. Do not copy that setting into a benchmark that
contains untrusted material. Use a container or virtual machine instead.

## Current evidence status

The first complete real-agent run on 2026-07-24 used the original two-case
corpus and completed all 12 generations. Automatic availability improved the
positive task from 20 to 60 points on GPT-5.6 Luna and from 20 to 80 on
GPT-5.6 Terra, while every condition kept 100 points on the adjacent coding
task. The overall verdict still failed because Luna's automatic condition
exceeded the frozen token-overhead gate.

That run motivated two development changes:

1. a shorter fast path that avoids unnecessary reference reads and searches;
2. a four-case corpus covering claim interpretation and a second adjacent
   negative task.

The expanded four-case run then completed all 24 generations. Automatic
availability improved positive-case quality by 40 points on Luna and 60 on
Terra, with no paired quality regressions. Its token overhead was 66.6% on Luna
and 18.8% on Terra; both stayed below the frozen 100% development gate.

Trace inspection found that the isolated Codex catalog advertised a `.system`
skill path while the harness installed only the normal user path. The resulting
failed lookup caused recursive searches outside the candidate workspace.
SkillProof now provides the advertised isolated alias and keeps provider control
files outside the candidate workspace.

The final worst-case efficiency canary measured Luna automatic availability at
69,768 tokens versus 66,781 without the skill: 4.5% overhead, down from 163.4%
in the immediately preceding canary. Quality increased from 0 to 60 points and
latency decreased by 6.4%. This is strong development evidence for the specific
case, not a population estimate.

This four-case, one-repeat, public corpus is intentionally not release evidence.
A publishable claim needs a frozen holdout, more cases and repeats, trusted
activation telemetry, and independent review where judgment is required.
