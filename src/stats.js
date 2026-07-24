import {
  average,
  CONDITIONS,
  createPrng,
  median,
  percentDelta,
  quantile,
  sum
} from "./utils.js";

export function summarizeBenchmark(runs, config) {
  const byRunner = Object.fromEntries(
    config.runners.map((runner) => [
      runner.id,
      summarizeRunner(
        runs.filter((run) => run.runner_id === runner.id),
        runner,
        config,
      )
    ]),
  );
  const statuses = Object.values(byRunner).map((summary) => summary.verdict.status);
  const overall = statuses.includes("failed")
    ? "failed"
    : statuses.includes("inconclusive") ? "inconclusive" : "passed";
  return {
    verdict: {
      status: overall,
      explanation: overall === "passed"
        ? "Every measured runner passed the configured gates."
        : overall === "failed"
          ? "At least one runner failed a configured quality, regression, activation, or efficiency gate."
          : "The benchmark lacks enough measured evidence for at least one configured gate."
    },
    runners: byRunner,
    run_counts: {
      planned: config.runners.length
        * config.cases.length
        * config.repeats
        * (config.conditions?.length ?? 3),
      completed: runs.filter((run) => run.status === "completed").length,
      candidate_errors: runs.filter((run) => run.status === "candidate_error").length,
      infrastructure_errors: runs.filter((run) => run.status === "infrastructure_error").length
    }
  };
}

function summarizeRunner(runs, runner, config) {
  const conditionMetrics = Object.fromEntries(
    (config.conditions ?? []).map((condition) => [
      condition,
      summarizeCondition(runs.filter((run) => run.condition === condition)),
    ]),
  );
  const auto = pairedContrast(runs, "skill_available_auto", config);
  const forced = pairedContrast(runs, "skill_forced", config);
  const activation = summarizeActivation(runs);
  const regressions = findRegressions(runs, config);
  const completeness = summarizeCompleteness(runs, config);
  const gates = evaluateGates({
    auto,
    activation,
    completeness,
    regressions,
    config
  });
  const gateStatuses = gates.map((gate) => gate.status);
  const status = gateStatuses.includes("failed")
    ? "failed"
    : gateStatuses.includes("inconclusive") ? "inconclusive" : "passed";
  return {
    runner_id: runner.id,
    provider: runner.provider,
    model: runner.model,
    conditions: conditionMetrics,
    contrasts: {
      auto_vs_without: auto,
      forced_vs_without: forced
    },
    activation,
    completeness,
    regressions,
    verdict: {
      status,
      gates
    }
  };
}

function summarizeCondition(runs) {
  const measured = runs.filter((run) => run.status !== "infrastructure_error");
  const completed = runs.filter((run) => run.status === "completed");
  const tokenTotals = measured.map(totalTokens);
  const costs = measured.map(preferredCost);
  const durations = measured.map((run) => run.duration_ms);
  return {
    runs: runs.length,
    completed: completed.length,
    candidate_errors: runs.filter((run) => run.status === "candidate_error").length,
    infrastructure_errors: runs.filter((run) => run.status === "infrastructure_error").length,
    quality: distribution(measured.map((run) => run.score.quality_percent)),
    tokens: distribution(tokenTotals),
    cost_usd: {
      ...distribution(costs),
      total: sum(costs)
    },
    latency_ms: distribution(durations),
    evidence: countBy(measured.map((run) => run.score.evidence))
  };
}

function pairedContrast(runs, treatment, config) {
  const pairs = pairRuns(runs, treatment);
  const positivePairs = pairs.filter((pair) => pair.treatment.applicability === "positive");
  const tokenDeltas = pairs.map((pair) => subtract(totalTokens(pair.treatment), totalTokens(pair.baseline)));
  const costDeltas = pairs.map((pair) => subtract(preferredCost(pair.treatment), preferredCost(pair.baseline)));
  const latencyDeltas = pairs.map((pair) => pair.treatment.duration_ms - pair.baseline.duration_ms);
  const caseDeltas = aggregateCaseDeltas(pairs);
  const positiveCaseDeltas = caseDeltas.filter((item) => item.applicability === "positive");
  const negativeCaseDeltas = caseDeltas.filter((item) => item.applicability === "negative");
  const ci = clusteredBootstrap(
    positiveCaseDeltas,
    config.statistics?.bootstrap_samples ?? 2000,
    config.statistics?.confidence ?? 0.95,
    `${config.seed ?? 1}:${treatment}`,
  );
  const tieMargin = config.statistics?.tie_margin_points ?? 1;
  return {
    treatment,
    pairs: positivePairs.length,
    cases: positiveCaseDeltas.length,
    quality_delta_points: average(positiveCaseDeltas.map((item) => item.delta)),
    negative_quality_delta_points: average(negativeCaseDeltas.map((item) => item.delta)),
    quality_confidence_interval: ci,
    quality_wins: positiveCaseDeltas.filter((item) => item.delta > tieMargin).length,
    quality_ties: positiveCaseDeltas.filter((item) => Math.abs(item.delta) <= tieMargin).length,
    quality_losses: positiveCaseDeltas.filter((item) => item.delta < -tieMargin).length,
    tokens_delta: median(tokenDeltas),
    tokens_delta_percent: median(pairs.map((pair) => percentDelta(
      totalTokens(pair.treatment),
      totalTokens(pair.baseline),
    ))),
    cost_delta_usd: median(costDeltas),
    cost_delta_percent: median(pairs.map((pair) => percentDelta(
      preferredCost(pair.treatment),
      preferredCost(pair.baseline),
    ))),
    latency_delta_ms: quantile(latencyDeltas, 0.95),
    latency_delta_percent: quantile(pairs.map((pair) => percentDelta(
      pair.treatment.duration_ms,
      pair.baseline.duration_ms,
    )), 0.95),
    efficiency_estimators: {
      tokens: "median paired delta",
      cost: "median paired delta",
      latency: "p95 paired delta"
    },
    per_case: caseDeltas
  };
}

function pairRuns(runs, treatment) {
  const baseline = new Map(
    runs
      .filter((run) => run.condition === "without_skill"
        && run.status !== "infrastructure_error"
        && Number.isFinite(run.score.quality_percent))
      .map((run) => [`${run.case_id}:${run.repeat}`, run]),
  );
  return runs
    .filter((run) => run.condition === treatment
      && run.status !== "infrastructure_error"
      && Number.isFinite(run.score.quality_percent))
    .flatMap((run) => {
      const match = baseline.get(`${run.case_id}:${run.repeat}`);
      return match ? [{ baseline: match, treatment: run }] : [];
    });
}

function aggregateCaseDeltas(pairs) {
  const grouped = new Map();
  for (const pair of pairs) {
    const delta = subtract(pair.treatment.score.quality_percent, pair.baseline.score.quality_percent);
    if (!Number.isFinite(delta)) continue;
    const item = grouped.get(pair.treatment.case_id) ?? {
      case_id: pair.treatment.case_id,
      title: pair.treatment.case_title,
      applicability: pair.treatment.applicability,
      deltas: [],
      baseline: [],
      treatment: []
    };
    item.deltas.push(delta);
    item.baseline.push(pair.baseline.score.quality_percent);
    item.treatment.push(pair.treatment.score.quality_percent);
    grouped.set(pair.treatment.case_id, item);
  }
  return [...grouped.values()].map((item) => ({
    case_id: item.case_id,
    title: item.title,
    applicability: item.applicability,
    delta: average(item.deltas),
    baseline: average(item.baseline),
    treatment: average(item.treatment),
    repeats: item.deltas.length,
    spread: quantile(item.deltas, 0.75) - quantile(item.deltas, 0.25)
  }));
}

function clusteredBootstrap(caseDeltas, samples, confidence, seed) {
  if (caseDeltas.length < 2) return { lower: null, upper: null, confidence, method: "task-cluster bootstrap" };
  const random = createPrng(seed);
  const estimates = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const selected = Array.from(
      { length: caseDeltas.length },
      () => caseDeltas[Math.floor(random() * caseDeltas.length)].delta,
    );
    estimates.push(average(selected));
  }
  const tail = (1 - confidence) / 2;
  return {
    lower: quantile(estimates, tail),
    upper: quantile(estimates, 1 - tail),
    confidence,
    method: "task-cluster bootstrap"
  };
}

function summarizeActivation(runs) {
  const auto = runs.filter(
    (run) => run.condition === "skill_available_auto" && run.status !== "infrastructure_error",
  );
  const instrumented = auto.filter((run) => run.activation.instrumented);
  const positives = instrumented.filter((run) => run.applicability === "positive");
  const negatives = instrumented.filter((run) => run.applicability === "negative");
  const classified = [...positives, ...negatives];
  const activated = classified.filter((run) => run.activation.skill_resource_loaded === true);
  const activatedPositive = positives.filter((run) => run.activation.skill_resource_loaded === true);
  const activatedNegative = negatives.filter((run) => run.activation.skill_resource_loaded === true);
  const recall = ratio(activatedPositive.length, positives.length);
  const precision = ratio(activatedPositive.length, activated.length);
  const falseRate = ratio(activatedNegative.length, negatives.length);
  return {
    instrumented_runs: instrumented.length,
    total_auto_runs: auto.length,
    recall: metricWithWilson(activatedPositive.length, positives.length),
    precision: metricWithWilson(activatedPositive.length, activated.length),
    false_activation_rate: metricWithWilson(activatedNegative.length, negatives.length),
    activated_positive: activatedPositive.length,
    positive_runs: positives.length,
    activated_negative: activatedNegative.length,
    negative_runs: negatives.length,
    uninstrumented_runs: auto.length - instrumented.length,
    value: { recall, precision, false_activation_rate: falseRate }
  };
}

function metricWithWilson(successes, total) {
  return {
    value: ratio(successes, total),
    successes,
    total,
    confidence_interval: wilson(successes, total)
  };
}

function wilson(successes, total, z = 1.959963984540054) {
  if (!total) return { lower: null, upper: null, confidence: 0.95, method: "Wilson" };
  const p = successes / total;
  const denominator = 1 + z ** 2 / total;
  const center = (p + z ** 2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * total)) / total) / denominator;
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    confidence: 0.95,
    method: "Wilson"
  };
}

function findRegressions(runs, config) {
  const threshold = config.gates?.regression_drop_points ?? 3;
  const pairs = pairRuns(runs, "skill_available_auto");
  const items = [];
  for (const pair of pairs) {
    const delta = subtract(pair.treatment.score.quality_percent, pair.baseline.score.quality_percent);
    const baselineCritical = new Set(
      pair.baseline.assertions
        .filter((assertion) => assertion.critical && assertion.status === "passed")
        .map((assertion) => assertion.id),
    );
    const newCriticalFailures = pair.treatment.assertions
      .filter((assertion) => assertion.critical
        && baselineCritical.has(assertion.id)
        && assertion.status !== "passed")
      .map((assertion) => assertion.id);
    if ((Number.isFinite(delta) && delta < -threshold) || newCriticalFailures.length) {
      items.push({
        case_id: pair.treatment.case_id,
        repeat: pair.treatment.repeat,
        quality_delta_points: delta,
        new_critical_failures: newCriticalFailures
      });
    }
  }
  return {
    kind: "paired_quality_regression_events",
    label: "Paired quality regression events",
    threshold_drop_points: threshold,
    count: items.length,
    items: items.map((item) => ({
      kind: "paired_quality_regression_event",
      ...item
    }))
  };
}

function summarizeCompleteness(runs, config) {
  const expectedRuns = config.cases.length
    * config.repeats
    * (config.conditions?.length ?? CONDITIONS.length);
  const infrastructureErrors = runs.filter((run) => run.status === "infrastructure_error").length;
  return {
    expected_runs: expectedRuns,
    observed_runs: runs.length,
    infrastructure_errors: infrastructureErrors,
    valid_run_ratio: expectedRuns
      ? Math.min(1, (runs.length - infrastructureErrors) / expectedRuns)
      : null,
    complete: runs.length === expectedRuns && infrastructureErrors === 0
  };
}

function evaluateGates({ auto, activation, completeness, regressions, config }) {
  const gates = config.gates ?? {};
  const evaluated = [
    {
      id: "run_completeness",
      value: completeness.valid_run_ratio,
      threshold: 1,
      unit: "ratio",
      status: completeness.complete ? "passed" : "inconclusive",
      expected_runs: completeness.expected_runs,
      observed_runs: completeness.observed_runs,
      infrastructure_errors: completeness.infrastructure_errors
    },
    compareGate(
      "quality_delta",
      auto.quality_delta_points,
      gates.minimum_quality_delta ?? 0,
      (value, limit) => value >= limit,
      "points",
    ),
    compareGate(
      "paired_quality_regression_events",
      regressions.count,
      gates.maximum_regressions ?? 0,
      (value, limit) => value <= limit,
      "count",
    ),
    compareGate(
      "false_activation_rate",
      activation.false_activation_rate.value,
      gates.maximum_false_activation_rate ?? 0.1,
      (value, limit) => value <= limit,
      "ratio",
    ),
    compareGate(
      "token_increase",
      auto.tokens_delta_percent,
      gates.maximum_token_increase_percent ?? 25,
      (value, limit) => value <= limit,
      "percent",
    ),
    compareGate(
      "latency_increase",
      auto.latency_delta_percent,
      gates.maximum_latency_increase_percent ?? 30,
      (value, limit) => value <= limit,
      "percent",
    )
  ];
  if (config.benchmark?.mode === "release") {
    evaluated.push(
      compareGate(
        "activation_recall_ci_lower",
        activation.recall.confidence_interval.lower,
        gates.minimum_activation_recall,
        (value, limit) => value >= limit,
        "ratio",
      ),
      compareGate(
        "activation_precision_ci_lower",
        activation.precision.confidence_interval.lower,
        gates.minimum_activation_precision,
        (value, limit) => value >= limit,
        "ratio",
      ),
    );
  }
  return evaluated;
}

function compareGate(id, value, threshold, test, unit) {
  return {
    id,
    value,
    threshold,
    unit,
    status: Number.isFinite(value) ? test(value, threshold) ? "passed" : "failed" : "inconclusive"
  };
}

function distribution(values) {
  const valid = values.filter(Number.isFinite);
  return {
    measured: valid.length,
    mean: average(valid),
    median: median(valid),
    p95: quantile(valid, 0.95),
    minimum: valid.length ? Math.min(...valid) : null,
    maximum: valid.length ? Math.max(...valid) : null
  };
}

function totalTokens(run) {
  if (Number.isFinite(run.usage.total_tokens)) return run.usage.total_tokens;
  if (!Number.isFinite(run.usage.input_tokens) || !Number.isFinite(run.usage.output_tokens)) return null;
  const exclusiveInput = run.usage.input_token_semantics === "exclusive"
    ? (run.usage.cached_input_tokens ?? 0) + (run.usage.cache_write_tokens ?? 0)
    : 0;
  return run.usage.input_tokens + exclusiveInput + run.usage.output_tokens;
}

function preferredCost(run) {
  return run.costs.observed_usd ?? run.costs.estimated_api_equivalent_usd;
}

function subtract(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) ? left - right : null;
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
