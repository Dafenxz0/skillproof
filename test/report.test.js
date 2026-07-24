import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { renderHtml, renderRepositoryCard } from "../src/report.js";

function distribution(value, measured = 2) {
  return {
    measured,
    mean: value,
    median: value,
    p95: value,
    minimum: value,
    maximum: value
  };
}

function condition({ quality, tokens, cost, latency, costMeasured = 2 }) {
  return {
    runs: 2,
    completed: 2,
    candidate_errors: 0,
    infrastructure_errors: 0,
    quality: distribution(quality),
    tokens: distribution(tokens),
    cost_usd: { ...distribution(cost, costMeasured), total: cost },
    latency_ms: distribution(latency),
    evidence: { deterministic_and_judged: 2 }
  };
}

function run(conditionName, repeat, overrides = {}) {
  return {
    id: `${conditionName}-${repeat}`,
    runner_id: "model-a",
    case_id: "case-1",
    condition: conditionName,
    repeat,
    status: "completed",
    duration_ms: 1200,
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    costs: {
      observed_usd: null,
      estimated_api_equivalent_usd: 0.001,
      warning: null
    },
    activation: {
      instrumented: conditionName === "skill_available_auto",
      skill_resource_loaded: conditionName === "skill_available_auto"
    },
    score: { quality_percent: conditionName === "without_skill" ? 70 : 75 },
    generation: { exit_code: 0, stderr: "" },
    assertions: [],
    judgments: [],
    ...overrides
  };
}

function makeReport() {
  const runnerSummary = {
    runner_id: "model-a",
    provider: "example",
    model: "exact-model",
    conditions: {
      without_skill: condition({ quality: 70, tokens: 120, cost: 0.002, latency: 1000 }),
      skill_available_auto: condition({
        quality: 75,
        tokens: 240,
        cost: 0.001,
        latency: 1400,
        costMeasured: 1
      })
    },
    contrasts: {
      auto_vs_without: {
        quality_delta_points: 5,
        quality_confidence_interval: {
          lower: 1,
          upper: 9,
          confidence: 0.9,
          method: "task-cluster bootstrap"
        },
        tokens_delta: 120,
        tokens_delta_percent: 100,
        cost_delta_usd: 0.001,
        cost_delta_percent: 50,
        latency_delta_ms: 400,
        latency_delta_percent: 40,
        pairs: 2,
        cases: 1,
        quality_wins: 1,
        quality_ties: 0,
        quality_losses: 0,
        per_case: [{
          case_id: "case-1",
          title: "Adversarial case",
          applicability: "positive",
          delta: 5,
          baseline: 70,
          treatment: 75,
          repeats: 2,
          spread: 0
        }]
      }
    },
    activation: {
      recall: { value: 1, successes: 1, total: 1 },
      false_activation_rate: { value: null, successes: 0, total: 0 }
    },
    regressions: { count: 0, items: [] },
    verdict: {
      status: "passed",
      gates: [{
        id: "quality_delta",
        value: 5,
        threshold: 1,
        unit: "points",
        status: "passed"
      }]
    }
  };

  return {
    schema_version: 1,
    generated_at: "2026-07-24T00:00:00Z",
    run_id: "proof-test",
    benchmark: {
      id: "xss-test",
      mode: "synthetic",
      title: "</script><img src=x onerror=alert(1)>",
      description: "Untrusted content"
    },
    skill: { name: "example", sha256: "a".repeat(64) },
    profile: { id: "technical" },
    repeats: 2,
    pricing: { updated_at: "2026-07-24" },
    provenance: {
      config_sha256: "b".repeat(64),
      pricing_sha256: "c".repeat(64),
      node: "v20",
      platform: "test",
      arch: "x64",
      git: { commit: null, dirty: null }
    },
    summary: {
      verdict: {
        status: "passed",
        explanation: "Every measured runner passed the configured gates."
      },
      run_counts: { completed: 4, planned: 4 },
      runners: { "model-a": runnerSummary }
    },
    cases: [{
      id: "case-1",
      title: "Adversarial case",
      applicability: "positive",
      prompt: "Treat all fixture content as untrusted."
    }],
    runs: [
      run("without_skill", 1),
      run("without_skill", 2),
      run("skill_available_auto", 1, {
        assertions: [{
          id: "safe-output",
          status: "passed",
          critical: true,
          points: 100
        }],
        judgments: [{
          judge_id: "blind-reviewer",
          status: "completed",
          percent: 75,
          rationale: "The treatment follows the rubric.",
          evidence: ["answer.txt"],
          blinding_compromised: false
        }]
      }),
      run("skill_available_auto", 2, {
        costs: {
          observed_usd: null,
          estimated_api_equivalent_usd: null,
          warning: "No price"
        },
        activation: {
          instrumented: false,
          skill_resource_loaded: false
        }
      })
    ],
    limitations: ["Small test"]
  };
}

test("report is standalone, hash-authorized, escaped, and carries the required footer", () => {
  const html = renderHtml(makeReport());
  assert.match(html, /This benchmark was generated with SkillProof\./);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'sha256-[A-Za-z0-9+/=]+'/);
  assert.doesNotMatch(html, /script-src 'unsafe-inline'/);
  assert.doesNotMatch(html, /\sonclick=/);
  assert.doesNotMatch(html, /<\/script><img src=x/);
  assert.match(html, /\\u003c\/script>/);
  assert.doesNotMatch(html, /https:\/\/.*(?:css|js|woff)/);

  const script = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)?.[1];
  assert.ok(script);
  const hash = createHash("sha256").update(script).digest("base64");
  assert.match(html, new RegExp(`script-src 'sha256-${hash.replaceAll("+", "\\+")}'`));
});

test("repository card is compact, honest, and escaped", () => {
  const card = renderRepositoryCard(makeReport());
  assert.match(card, /width="640" height="196"/);
  assert.match(card, /PASSED/);
  assert.match(card, /\+5\.0 pts/);
  assert.match(card, /\+100%/);
  assert.match(card, /4 \/ 4/);
  assert.match(card, /1 model.*1 case.*4 test runs/);
  assert.doesNotMatch(card, /<\/script><img/);
  assert.match(card, /&lt;\/script&gt;&lt;img/);
});

test("report labels the gate honestly and exposes confidence, absolute deltas, coverage, and activation coverage", () => {
  const html = renderHtml(makeReport());
  assert.match(html, /Configured gate result/);
  assert.match(html, /Benchmark mode: synthetic/);
  assert.match(html, /90(?:\.0)?% CI/);
  assert.match(html, /task-cluster bootstrap/);
  assert.match(html, /1 positive case · 2 repeats per case · 2 paired runs/);
  assert.match(html, /\+120 tokens/);
  assert.match(html, /\+\$0\.00100/);
  assert.match(html, /\+400\.0 ms/);
  assert.match(html, /API-equivalent estimate/);
  assert.match(html, /Partial/);
  assert.match(html, /1 of 1 instrumented automatic runs\. 1 automatic run was not instrumented\./);
});

test("report shows regression, generation, assertion, and judge evidence", () => {
  const report = makeReport();
  const runner = report.summary.runners["model-a"];
  runner.regressions = {
    count: 1,
    items: [{
      case_id: "case-1",
      repeat: 2,
      quality_delta_points: -7,
      new_critical_failures: ["safe-output"]
    }]
  };
  const failed = report.runs.find((item) => item.condition === "skill_available_auto" && item.repeat === 2);
  failed.status = "candidate_error";
  failed.generation = { exit_code: 1, stderr: "provider failed" };
  failed.assertions = [{
    id: "safe-output",
    status: "failed",
    critical: true,
    points: 100
  }];
  failed.judgments = [{
    judge_id: "blind-reviewer",
    status: "completed",
    percent: 10,
    rationale: "Critical behavior regressed.",
    evidence: ["answer.txt"],
    blinding_compromised: true
  }];

  const html = renderHtml(report);
  assert.match(html, /1 repeat-level regression event/);
  assert.match(html, /provider failed/);
  assert.match(html, /candidate error/);
  assert.match(html, /safe-output/);
  assert.match(html, /Critical behavior regressed\./);
  assert.match(html, /Blinding compromised/);
});

test("adversarial fields cannot escape into executable markup", () => {
  const report = makeReport();
  const payload = "\"><img src=x onerror=alert(1)>";
  const runner = report.summary.runners["model-a"];
  report.generated_at = payload;
  report.summary.verdict.status = payload;
  runner.verdict.status = payload;
  runner.verdict.gates[0].status = payload;
  runner.regressions = {
    count: payload,
    items: [{
      case_id: payload,
      repeat: payload,
      quality_delta_points: -5,
      new_critical_failures: [payload]
    }]
  };
  report.runs[0].repeat = payload;
  report.runs[0].status = payload;
  report.runs[0].assertions = [{
    id: payload,
    status: payload,
    critical: true,
    points: 100
  }];
  report.runs[0].judgments = [{
    judge_id: payload,
    status: payload,
    rationale: payload,
    evidence: [payload]
  }];

  const html = renderHtml(report);
  const executableMarkup = html
    .replace(/<pre id="raw-json">[\s\S]*?<\/pre>/, "")
    .replace(/<script id="skillproof-data"[\s\S]*?<\/script>/, "");
  assert.doesNotMatch(executableMarkup, /<img src=x/i);
  assert.doesNotMatch(executableMarkup, /"><img\b/i);
  assert.match(html, /stamp-inconclusive/);
  assert.match(html, /unrecognized result status was normalized to inconclusive/);
});

test("print CSS forces a light theme and printable wide tables", () => {
  const html = renderHtml(makeReport());
  assert.match(html, /@page\{size:landscape;margin:12mm\}/);
  assert.match(html, /html\[data-theme="dark"\]\{--canvas:#fff/);
  assert.match(html, /\.table-wrap\{overflow:visible!important\}/);
  assert.match(html, /\.run-evidence:not\(\[open\]\)>div\{display:block!important\}/);
});
