# Configuration Reference

SkillProof uses JSON so the CLI remains dependency-free.

## Minimal Shape

```json
{
  "version": 1,
  "benchmark": {
    "id": "release-1",
    "title": "My Skill release benchmark",
    "mode": "release"
  },
  "skill": { "path": "./skills/my-skill" },
  "profile": "technical",
  "conditions": [
    "without_skill",
    "skill_available_auto",
    "skill_forced"
  ],
  "repeats": 3,
  "seed": 42,
  "runners": [],
  "cases": [],
  "judges": [],
  "gates": {},
  "statistics": {},
  "output": ".skillproof/results"
}
```

Built-in profiles are `technical`, `behavioral-ui`, `visual`, `writing`, and `generic`.

## Runners

Every runner has a stable ID and exact provider/model identity.

```json
{
  "id": "codex-terra",
  "adapter": "command",
  "preset": "codex",
  "provider": "openai",
  "model": "gpt-5.6-terra",
  "command": "codex",
  "parser": "jsonl",
  "skill_install": "codex-home",
  "reasoning_effort": "medium",
  "inherit_auth": true,
  "sandbox": "workspace-write",
  "billing_route": "chatgpt-subscription",
  "timeout_ms": 900000
}
```

Create a separate runner ID for every provider, exact model ID, model version,
and reasoning setting. SkillProof never averages two such configurations into
one headline. Requested identity and provider-observed identities are both kept
in the result.

`inherit_auth` copies only Codex's authentication file into the disposable agent home. It is opt-in because generated commands may be hostile. Use it only with trusted fixtures or an outer sandbox.

`sandbox` defaults to `workspace-write`. The `danger-full-access` value is
rejected unless `allow_unsandboxed` is explicitly `true`; use that escape hatch
only for trusted fixtures already enclosed by a container or virtual machine.

Custom command arguments may use `{prompt}`, `{workspace}`, and `{agent_home}`. The harness deliberately does not reveal the condition, target skill path, or skill name to the candidate process. Prefer standard input for long prompts when the adapter supports it.

Activation telemetry must come from trusted native runner events. Candidate-written telemetry files are not evidence. A provider without native skill-load events is reported as uninstrumented; SkillProof does not guess from prose.

The normalized native shape is:

```json
{
  "usage": {
    "input_tokens": 1200,
    "cached_input_tokens": 400,
    "output_tokens": 300,
    "reasoning_tokens": 80
  },
  "observed_cost_usd": null,
  "activation": {
    "skill_selected": true,
    "skill_resource_loaded": true,
    "skill_asset_used": false,
    "activation_timestamp": "2026-07-24T12:00:00Z"
  }
}
```

Missing fields remain null.

## Cases

```json
{
  "id": "case-017",
  "title": "Recover an uncertain write",
  "applicability": "positive",
  "prompt": "Original user request.",
  "fixture": "./fixtures/case-017",
  "rubric": [
    { "id": "safe-retry", "points": 20, "criterion": "..." }
  ],
  "assertions": [
    {
      "id": "no-duplicate-write",
      "command": "node",
      "args": ["../hidden/check.mjs", "{workspace}"],
      "points": 40,
      "critical": true,
      "timeout_ms": 120000
    }
  ]
}
```

Fixture paths resolve from the config file. Assertions run against a separate
verification copy of the frozen candidate artifact. Keep trusted check code and
expected answers outside both candidate and verification workspaces.

## Judges

A command judge receives blinded candidate and case paths through:

- `SKILLPROOF_ARTIFACT`
- `SKILLPROOF_CANDIDATE`
- `SKILLPROOF_CASE_FILE`
- `SKILLPROOF_JUDGE_RESULT`

It should write:

```json
{
  "score": 82,
  "maximum": 100,
  "criteria": [],
  "rationale": "Evidence-backed explanation.",
  "evidence": ["src/example.js:42", "check no-duplicate-write"],
  "blinding_compromised": false
}
```

Use a different judge family from the generator when practical.

## Gates

```json
{
  "minimum_quality_delta": 3,
  "regression_drop_points": 3,
  "maximum_regressions": 0,
  "minimum_activation_recall": 0.8,
  "minimum_activation_precision": 0.8,
  "maximum_false_activation_rate": 0.1,
  "maximum_token_increase_percent": 25,
  "maximum_latency_increase_percent": 30
}
```

Thresholds are product policy. Freeze them before seeing evaluation results.
