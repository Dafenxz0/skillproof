import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const workspace = process.env.SKILLPROOF_WORKSPACE;
const benchmark = JSON.parse(await readFile(join(workspace, "benchmark.json"), "utf8"));
const criterion = process.argv[2];
const body = benchmark.benchmark ?? benchmark;
const mode = benchmark.mode ?? body.mode;
const conditionIds = (benchmark.conditions ?? body.conditions ?? []).map((item) => (
  typeof item === "string" ? item : item.id
));
const repeats = benchmark.repeats
  ?? benchmark.execution?.runs_per_configuration
  ?? body.repeats
  ?? body.execution?.runs_per_configuration;
const runners = benchmark.runners ?? benchmark.models ?? body.runners ?? body.models ?? [];
const runnerIdentities = new Set(runners.map((runner) => {
  const model = String(runner.model ?? "").toLowerCase().replaceAll(/[\s_.-]+/g, "");
  const reasoning = String(runner.reasoning_effort ?? runner.reasoning ?? "").toLowerCase();
  return `${model}/${reasoning}`;
}));
const cases = benchmark.cases ?? body.cases ?? [];
const applicability = new Set(cases.map((item) => item.applicability));
const serialized = JSON.stringify(benchmark).toLowerCase();
const cannotProve = benchmark.limitations
  ?? benchmark.claims?.cannot_prove
  ?? benchmark.cannot_prove
  ?? benchmark.claims?.cannot_support
  ?? body.limitations
  ?? body.claims?.cannot_prove
  ?? body.cannot_prove
  ?? body.claims?.cannot_support
  ?? body.claims?.limitations
  ?? [];
const canProve = benchmark.claims?.can_prove
  ?? benchmark.can_prove
  ?? benchmark.claims?.can_support
  ?? body.claims?.can_prove
  ?? body.can_prove
  ?? body.claims?.can_support
  ?? [];

if (criterion === "causal") {
  assert.equal(mode, "development");
  assert.deepEqual(
    [...conditionIds].sort(),
    ["skill_available_auto", "skill_forced", "without_skill"].sort(),
  );
  assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 3);
} else if (criterion === "matrix") {
  assert.ok(Array.isArray(runners) && runners.length >= 3);
  assert.ok(runnerIdentities.has("gpt56luna/medium"));
  assert.ok(runnerIdentities.has("gpt56terra/medium"));
  assert.ok(runnerIdentities.has("gpt56terra/high"));
} else if (criterion === "boundaries") {
  assert.ok(Array.isArray(cases) && cases.length >= 3);
  assert.ok(applicability.has("positive"));
  assert.ok(applicability.has("negative"));
  assert.ok(applicability.has("ambiguous"));
  assert.ok(cases.every((item) => item.prompt && item.fixture));
} else if (criterion === "measurement") {
  for (const concept of ["quality", "activation"]) {
    assert.ok(serialized.includes(concept), `missing ${concept} measurement`);
  }
  assert.ok(
    ["token", "cost", "latency"].filter((concept) => serialized.includes(concept)).length >= 2,
    "missing operational measurements",
  );
  assert.ok(serialized.includes("assertion") || serialized.includes("test"));
} else if (criterion === "limitations") {
  assert.ok(Array.isArray(cannotProve) && cannotProve.length >= 2);
  assert.ok(Array.isArray(canProve) && canProve.length >= 1);
  assert.ok(Number.isInteger(repeats) && repeats <= 3);
  assert.ok(serialized.includes("development"));
} else {
  throw new Error(`Unknown criterion: ${criterion}`);
}
