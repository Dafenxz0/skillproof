import test from "node:test";
import assert from "node:assert/strict";
import { summarizeBenchmark } from "../src/stats.js";

function run({
  caseId,
  applicability,
  condition,
  quality,
  activation = false,
  activationInstrumented = true,
  cost,
  duration,
  status = "completed",
  repeat = 1,
  tokens
}) {
  return {
    runner_id: "runner",
    provider: "example",
    model: "model-v1",
    case_id: caseId,
    case_title: caseId,
    applicability,
    condition,
    repeat,
    status,
    duration_ms: duration ?? (condition === "without_skill" ? 100 : 110),
    activation: {
      instrumented: activationInstrumented,
      skill_resource_loaded: activation
    },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: tokens ?? (condition === "without_skill" ? 100 : 110)
    },
    costs: {
      observed_usd: null,
      estimated_api_equivalent_usd: cost ?? (condition === "without_skill" ? 0.01 : 0.011)
    },
    assertions: [],
    score: {
      quality_percent: quality,
      evidence: "deterministic_only"
    }
  };
}

const config = {
  benchmark: { mode: "development" },
  seed: 1,
  conditions: ["without_skill", "skill_available_auto", "skill_forced"],
  runners: [{ id: "runner", provider: "example", model: "model-v1" }],
  cases: [
    { id: "positive", applicability: "positive" },
    { id: "negative", applicability: "negative" }
  ],
  repeats: 1,
  gates: {
    minimum_quality_delta: 5,
    maximum_regressions: 0,
    maximum_false_activation_rate: 0.1,
    maximum_token_increase_percent: 25,
    maximum_latency_increase_percent: 30
  },
  statistics: {
    bootstrap_samples: 100,
    confidence: 0.95,
    tie_margin_points: 1
  }
};

test("headline quality uses positive cases and reports negatives separately", () => {
  const runs = [
    run({ caseId: "positive", applicability: "positive", condition: "without_skill", quality: 40 }),
    run({ caseId: "positive", applicability: "positive", condition: "skill_available_auto", quality: 80, activation: true }),
    run({ caseId: "positive", applicability: "positive", condition: "skill_forced", quality: 80, activation: true }),
    run({ caseId: "negative", applicability: "negative", condition: "without_skill", quality: 90 }),
    run({ caseId: "negative", applicability: "negative", condition: "skill_available_auto", quality: 80 }),
    run({ caseId: "negative", applicability: "negative", condition: "skill_forced", quality: 90, activation: true })
  ];
  const summary = summarizeBenchmark(runs, config).runners.runner;
  assert.equal(summary.contrasts.auto_vs_without.quality_delta_points, 40);
  assert.equal(summary.contrasts.auto_vs_without.negative_quality_delta_points, -10);
  assert.equal(summary.activation.recall.value, 1);
  assert.equal(summary.activation.false_activation_rate.value, 0);
  assert.equal(summary.regressions.count, 1);
  assert.equal(summary.regressions.kind, "paired_quality_regression_events");
  assert.equal(summary.regressions.items[0].kind, "paired_quality_regression_event");
  assert.equal(summary.verdict.status, "failed");
});

test("candidate failures remain scoreable rather than disappearing from pairs", () => {
  const runs = [
    run({ caseId: "positive", applicability: "positive", condition: "without_skill", quality: 80 }),
    run({
      caseId: "positive",
      applicability: "positive",
      condition: "skill_available_auto",
      quality: 0,
      status: "candidate_error",
      activation: true
    }),
    run({ caseId: "positive", applicability: "positive", condition: "skill_forced", quality: 80, activation: true }),
    run({ caseId: "negative", applicability: "negative", condition: "without_skill", quality: 90 }),
    run({ caseId: "negative", applicability: "negative", condition: "skill_available_auto", quality: 90 }),
    run({ caseId: "negative", applicability: "negative", condition: "skill_forced", quality: 90, activation: true })
  ];
  const contrast = summarizeBenchmark(runs, config).runners.runner.contrasts.auto_vs_without;
  assert.equal(contrast.pairs, 1);
  assert.equal(contrast.quality_delta_points, -80);
});

test("headline quality gives every positive case equal weight when repeats are missing", () => {
  const runs = [];
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    runs.push(
      run({ caseId: "frequent", applicability: "positive", condition: "without_skill", quality: 0, repeat }),
      run({ caseId: "frequent", applicability: "positive", condition: "skill_available_auto", quality: 100, repeat }),
    );
  }
  runs.push(
    run({ caseId: "sparse", applicability: "positive", condition: "without_skill", quality: 100 }),
    run({ caseId: "sparse", applicability: "positive", condition: "skill_available_auto", quality: 0 }),
  );
  const localConfig = {
    ...config,
    cases: [
      { id: "frequent", applicability: "positive" },
      { id: "sparse", applicability: "positive" }
    ],
    repeats: 3
  };
  const contrast = summarizeBenchmark(runs, localConfig).runners.runner.contrasts.auto_vs_without;
  assert.equal(contrast.quality_delta_points, 0);
});

test("efficiency overhead uses paired medians for tokens and cost and paired p95 for latency", () => {
  const runs = [];
  for (const [repeat, increase] of [[1, 10], [2, 20], [3, 100]]) {
    runs.push(
      run({
        caseId: "positive",
        applicability: "positive",
        condition: "without_skill",
        quality: 50,
        repeat,
        tokens: 100,
        cost: 1,
        duration: 100
      }),
      run({
        caseId: "positive",
        applicability: "positive",
        condition: "skill_available_auto",
        quality: 60,
        repeat,
        tokens: 100 + increase,
        cost: 1 + increase / 100,
        duration: 100 + increase
      }),
    );
  }
  const localConfig = {
    ...config,
    cases: [{ id: "positive", applicability: "positive" }],
    repeats: 3
  };
  const contrast = summarizeBenchmark(runs, localConfig).runners.runner.contrasts.auto_vs_without;
  assert.equal(contrast.tokens_delta, 20);
  assert.equal(contrast.tokens_delta_percent, 20);
  assert.ok(Math.abs(contrast.cost_delta_usd - 0.2) < 1e-9);
  assert.ok(Math.abs(contrast.cost_delta_percent - 20) < 1e-9);
  assert.equal(contrast.latency_delta_ms, 92);
  assert.equal(contrast.latency_delta_percent, 92);
  assert.deepEqual(contrast.efficiency_estimators, {
    tokens: "median paired delta",
    cost: "median paired delta",
    latency: "p95 paired delta"
  });
});

test("activation precision excludes ambiguous cases from its denominator", () => {
  const runs = [
    run({ caseId: "positive", applicability: "positive", condition: "skill_available_auto", quality: 80, activation: true }),
    run({ caseId: "negative", applicability: "negative", condition: "skill_available_auto", quality: 80 }),
    run({ caseId: "ambiguous", applicability: "ambiguous", condition: "skill_available_auto", quality: 80, activation: true })
  ];
  const summary = summarizeBenchmark(runs, {
    ...config,
    cases: [
      { id: "positive", applicability: "positive" },
      { id: "negative", applicability: "negative" },
      { id: "ambiguous", applicability: "ambiguous" }
    ]
  }).runners.runner;
  assert.equal(summary.activation.precision.value, 1);
  assert.equal(summary.activation.precision.total, 1);
});

test("release activation gates use Wilson lower bounds", () => {
  const cases = [];
  const runs = [];
  for (let index = 0; index < 20; index += 1) {
    for (const applicability of ["positive", "negative"]) {
      const caseId = `${applicability}-${index}`;
      cases.push({ id: caseId, applicability });
      for (const condition of config.conditions) {
        runs.push(run({
          caseId,
          applicability,
          condition,
          quality: condition === "without_skill" ? 50 : 60,
          activation: condition !== "without_skill" && applicability === "positive"
        }));
      }
    }
  }
  const summary = summarizeBenchmark(runs, {
    ...config,
    benchmark: { mode: "release" },
    cases,
    gates: {
      ...config.gates,
      minimum_activation_recall: 0.8,
      minimum_activation_precision: 0.8
    }
  }).runners.runner;
  const recallGate = summary.verdict.gates.find((gate) => gate.id === "activation_recall_ci_lower");
  const precisionGate = summary.verdict.gates.find((gate) => gate.id === "activation_precision_ci_lower");
  assert.equal(recallGate.value, summary.activation.recall.confidence_interval.lower);
  assert.equal(precisionGate.value, summary.activation.precision.confidence_interval.lower);
  assert.equal(recallGate.status, "passed");
  assert.equal(precisionGate.status, "passed");
});

test("unavailable activation telemetry does not block a development verdict", () => {
  const runs = [
    run({ caseId: "positive", applicability: "positive", condition: "without_skill", quality: 50 }),
    run({
      caseId: "positive",
      applicability: "positive",
      condition: "skill_available_auto",
      quality: 60,
      activationInstrumented: false
    }),
    run({
      caseId: "positive",
      applicability: "positive",
      condition: "skill_forced",
      quality: 60,
      activationInstrumented: false
    }),
    run({ caseId: "negative", applicability: "negative", condition: "without_skill", quality: 90 }),
    run({
      caseId: "negative",
      applicability: "negative",
      condition: "skill_available_auto",
      quality: 90,
      activationInstrumented: false
    }),
    run({
      caseId: "negative",
      applicability: "negative",
      condition: "skill_forced",
      quality: 90,
      activationInstrumented: false
    })
  ];
  const summary = summarizeBenchmark(runs, config).runners.runner;
  assert.equal(summary.verdict.status, "passed");
  assert.equal(
    summary.verdict.gates.some((gate) => gate.id === "false_activation_rate"),
    false,
  );
  assert.equal(summary.activation.uninstrumented_runs, 2);
});

test("infrastructure errors make an otherwise passing runner inconclusive", () => {
  const runs = [
    run({ caseId: "positive", applicability: "positive", condition: "without_skill", quality: 50 }),
    run({ caseId: "positive", applicability: "positive", condition: "skill_available_auto", quality: 60, activation: true }),
    run({
      caseId: "positive",
      applicability: "positive",
      condition: "skill_forced",
      quality: 60,
      activation: true,
      status: "infrastructure_error"
    }),
    run({ caseId: "negative", applicability: "negative", condition: "without_skill", quality: 90 }),
    run({ caseId: "negative", applicability: "negative", condition: "skill_available_auto", quality: 90 }),
    run({ caseId: "negative", applicability: "negative", condition: "skill_forced", quality: 90, activation: true })
  ];
  const summary = summarizeBenchmark(runs, config).runners.runner;
  const completenessGate = summary.verdict.gates.find((gate) => gate.id === "run_completeness");
  assert.equal(completenessGate.status, "inconclusive");
  assert.equal(completenessGate.infrastructure_errors, 1);
  assert.equal(summary.verdict.status, "inconclusive");
});
