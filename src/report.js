import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const VERDICT_STATUSES = new Set(["passed", "failed", "inconclusive"]);

export async function writeHtmlReport(report, outputPath) {
  await writeFile(outputPath, renderHtml(report), "utf8");
}

export async function writeRepositoryCard(report, outputPath) {
  await writeFile(outputPath, renderRepositoryCard(report), "utf8");
}

export function renderRepositoryCard(report) {
  const runners = Object.values(report.summary.runners);
  const verdict = normalizeVerdict(report.summary.verdict.status);
  const accent = {
    passed: "#78D69D",
    failed: "#F0755B",
    inconclusive: "#E8B85B"
  }[verdict];
  const quality = metricRange(
    runners.map((runner) => runner.contrasts?.auto_vs_without?.quality_delta_points),
    " pts",
  );
  const tokens = metricRange(
    runners.map((runner) => runner.contrasts?.auto_vs_without?.tokens_delta_percent),
    "%",
  );
  const completed = report.summary.run_counts.completed;
  const planned = report.summary.run_counts.planned;
  const modelCount = runners.length;
  const caseCount = report.cases.length;
  const title = truncateCardText(report.benchmark.title, 58);
  const date = String(report.generated_at ?? "").slice(0, 10) || "date unknown";
  const activationClaim = report.summary.claims?.activation?.status;
  const scope = activationClaim
    ? `${modelCount} model${modelCount === 1 ? "" : "s"} · ${integer(planned)} test runs · activation ${humanize(activationClaim).toLowerCase()}`
    : `${modelCount} model${modelCount === 1 ? "" : "s"} · ${caseCount} case${caseCount === 1 ? "" : "s"} · ${integer(planned)} test runs · ${date}`;
  const description = `${verdict} benchmark; quality ${quality}; token overhead ${tokens}; ${completed} of ${planned} runs completed.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="196" viewBox="0 0 640 196" role="img" aria-labelledby="title description">
  <title id="title">SkillProof evidence card: ${escapeHtml(title)}</title>
  <desc id="description">${escapeHtml(description)}</desc>
  <rect width="640" height="196" rx="14" fill="#101513"/>
  <rect x="0.75" y="0.75" width="638.5" height="194.5" rx="13.25" fill="none" stroke="#344039" stroke-width="1.5"/>
  <rect x="24" y="22" width="28" height="4" rx="2" fill="${accent}"/>
  <text x="62" y="29" fill="#AAB7B0" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="11" font-weight="700" letter-spacing="1.2">SKILLPROOF / EVIDENCE</text>
  <rect x="490" y="14" width="126" height="26" rx="13" fill="${accent}" fill-opacity="0.14" stroke="${accent}" stroke-opacity="0.55"/>
  <text x="553" y="31" fill="${accent}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="11" font-weight="700" letter-spacing="0.6">${escapeHtml(verdict.toUpperCase())}</text>
  <text x="24" y="68" fill="#F2F5F3" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="21" font-weight="700">${escapeHtml(title)}</text>
  <line x1="24" y1="86" x2="616" y2="86" stroke="#2C3732"/>
  ${cardMetric(24, "QUALITY LIFT", quality)}
  ${cardMetric(228, "TOKEN OVERHEAD", tokens)}
  ${cardMetric(432, "COMPLETED RUNS", `${integer(completed)} / ${integer(planned)}`)}
  <line x1="24" y1="156" x2="616" y2="156" stroke="#2C3732"/>
  <text x="24" y="179" fill="#87958E" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="11">${escapeHtml(scope)}</text>
  <text x="616" y="179" fill="#87958E" text-anchor="end" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="11">generated from results.json</text>
</svg>
`;
}

export function renderHtml(report) {
  const summary = report.summary;
  const runnerSummaries = Object.values(summary.runners);
  const verdict = normalizeVerdict(summary.verdict.status);
  const benchmarkMode = report.benchmark.mode === "development"
    ? "Engineering test"
    : report.benchmark.mode === "release" ? "Release benchmark" : report.benchmark.mode ?? "Not recorded";
  const embedded = JSON.stringify(report).replaceAll("<", "\\u003c");
  const caseIndex = new Map(report.cases.map((testCase) => [testCase.id, testCase]));
  const runnerSections = runnerSummaries.map((runner) => renderRunner(runner, report, caseIndex)).join("");
  const warnings = buildWarnings(report);
  const repositoryCard = renderRepositoryCard(report);
  const repositoryCardData = Buffer.from(repositoryCard, "utf8").toString("base64");
  const script = clientScript();
  const scriptHash = createHash("sha256").update(script).digest("base64");
  return `<!doctype html>
<html lang="en" data-theme="system">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; img-src data:; connect-src 'none'">
  <title>${escapeHtml(report.benchmark.title)} · SkillProof</title>
  <style>${styles()}</style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to evidence</a>
  <header class="topbar">
    <a class="wordmark" href="#main" aria-label="SkillProof report">SkillProof<span>/report</span></a>
    <nav aria-label="Report sections">
      <a href="#outcomes">Outcomes</a>
      <a href="#repository-card">Card</a>
      <a href="#runners">Models</a>
      <a href="#provenance">Provenance</a>
      <a href="#limitations">Limitations</a>
    </nav>
    <div class="controls">
      <label><span class="control-label">Theme</span>
        <select id="theme" aria-label="Theme">
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <button type="button" id="print">Print</button>
      <button type="button" id="download" aria-label="Download benchmark JSON"><span class="download-long">Download JSON</span><span class="download-short" aria-hidden="true">JSON</span></button>
    </div>
  </header>
  <main id="main">
    <section class="masthead" aria-labelledby="title">
      <div>
        <p class="eyebrow">${escapeHtml(report.benchmark.id)} · Benchmark mode: ${escapeHtml(benchmarkMode)} · ${escapeHtml(formatDate(report.generated_at))}</p>
        <h1 id="title">${escapeHtml(report.benchmark.title)}</h1>
        <p class="lede">${escapeHtml(report.benchmark.description ?? "Paired evidence for an Agent Skill.")}</p>
      </div>
      <div class="stamp stamp-${verdict}">
        <span>Configured gate result</span>
        <strong>${escapeHtml(verdict.toUpperCase())}</strong>
        <small>${integer(summary.run_counts.completed)} of ${integer(summary.run_counts.planned)} runs completed</small>
        <small>${integer(runnerSummaries.length)} model configuration${runnerSummaries.length === 1 ? "" : "s"}</small>
      </div>
    </section>
    ${summary.verdict.explanation ? `<p class="verdict-explanation">${escapeHtml(summary.verdict.explanation)}</p>` : ""}
    ${renderClaims(summary.claims)}

    ${warnings.length ? `<section class="notice" aria-labelledby="warnings-title">
      <h2 id="warnings-title">Read before interpreting</h2>
      <ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>
    </section>` : ""}

    <section id="outcomes" class="section" aria-labelledby="outcomes-title">
      <div class="section-heading">
        <p>01 / Summary</p>
        <h2 id="outcomes-title">Outcome ledger</h2>
      </div>
      <div class="table-wrap" role="region" aria-label="Outcome ledger" tabindex="0">
        <table>
          <caption>Automatic skill availability compared with a clean baseline, separated by runner and model.</caption>
          <thead>
            <tr><th scope="col">Runner / model</th><th scope="col">Model identity</th><th scope="col">Quality</th><th scope="col">Quality CI</th><th scope="col">Tokens</th><th scope="col">Cost</th><th scope="col">Latency</th><th scope="col">Regression events</th><th scope="col">Gate</th></tr>
          </thead>
          <tbody>
            ${runnerSummaries.map(renderLedgerRow).join("")}
          </tbody>
        </table>
      </div>
      <p class="definition">Quality is a paired positive-case difference. Efficiency deltas are relative across all paired cases. A positive quality delta is favorable; positive token, cost, or latency deltas are additional operational tax. Cost uses provider-observed estimates when present and otherwise the pinned API-equivalent catalog estimate.</p>
    </section>

    <section id="repository-card" class="section" aria-labelledby="repository-card-title">
      <div class="section-heading">
        <p>02 / Share</p>
        <h2 id="repository-card-title">Repository evidence card</h2>
      </div>
      <div class="repository-card-grid">
        <figure class="repository-card-preview">
          <img src="data:image/svg+xml;base64,${repositoryCardData}" alt="SkillProof evidence card showing the benchmark verdict and headline metrics" width="640" height="196">
          <figcaption><code>card.svg</code> is generated from this report. Keep it beside <code>report.html</code>.</figcaption>
        </figure>
        <div class="embed-instructions">
          <p>Add this small, honest summary to a repository README. The verdict and metrics cannot drift from <code>results.json</code>.</p>
          <pre><code>[![SkillProof evidence](./card.svg)](./report.html)</code></pre>
        </div>
      </div>
    </section>

    <section id="runners" class="section" aria-labelledby="runners-title">
      <div class="section-heading">
        <p>03 / Models</p>
        <h2 id="runners-title">Evidence by runner</h2>
      </div>
      ${runnerSections}
    </section>

    <section id="provenance" class="section split" aria-labelledby="provenance-title">
      <div class="section-heading">
        <p>04 / Audit trail</p>
        <h2 id="provenance-title">Provenance</h2>
      </div>
      <dl class="provenance">
        ${definition("Run ID", report.run_id)}
        ${definition("Schema", String(report.schema_version))}
        ${definition("Benchmark mode", benchmarkMode)}
        ${definition("Skill", `${report.skill.name} · ${shortHash(report.skill.sha256)}`)}
        ${definition("Profile", report.profile.id)}
        ${definition("Config hash", report.provenance.config_sha256)}
        ${definition("Price snapshot", `${report.pricing.updated_at} · ${shortHash(report.provenance.pricing_sha256)}`)}
        ${definition("Node", report.provenance.node)}
        ${definition("Platform", `${report.provenance.platform} ${report.provenance.arch}`)}
        ${definition("Environment policy", environmentPolicySummary(report.provenance.environment_allowlist))}
        ${definition("Repository commit", report.provenance.git.commit ?? "Not recorded")}
        ${definition("Repository state", report.provenance.git.dirty === null ? "Not recorded" : report.provenance.git.dirty ? "Dirty" : "Clean")}
      </dl>
    </section>

    <section id="limitations" class="section split limitations" aria-labelledby="limitations-title">
      <div class="section-heading">
        <p>05 / Boundaries</p>
        <h2 id="limitations-title">Limitations</h2>
      </div>
      <ul>
        ${report.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </section>

    <section class="section raw no-print" aria-labelledby="raw-title">
      <div class="section-heading">
        <p>06 / Source</p>
        <h2 id="raw-title">Raw benchmark data</h2>
      </div>
      <details>
        <summary>Inspect embedded JSON</summary>
        <pre id="raw-json">${escapeHtml(JSON.stringify(report, null, 2))}</pre>
      </details>
    </section>
  </main>
  <footer>This benchmark was generated with SkillProof.</footer>
  <script id="skillproof-data" type="application/json" data-schema-version="${escapeAttribute(report.schema_version)}">${embedded}</script>
  <script>${script}</script>
</body>
</html>`;
}

function renderLedgerRow(runner) {
  const contrast = runner.contrasts.auto_vs_without;
  const ci = contrast.quality_confidence_interval;
  const identity = runner.model_identity?.status ?? "requested_only";
  return `<tr>
    <th scope="row"><a href="#runner-${safeId(runner.runner_id)}">${escapeHtml(runner.runner_id)}</a><small>${escapeHtml(runner.provider)}/${escapeHtml(runner.model)}</small></th>
    <td>${escapeHtml(humanize(identity))}</td>
    <td>${metric(contrast.quality_delta_points, " pts", true)}</td>
    <td>${confidenceInterval(ci)}</td>
    <td>${metricPair(contrast.tokens_delta, (value) => `${signed(value)} tokens`, contrast.tokens_delta_percent, false)}</td>
    <td>${metricPair(contrast.cost_delta_usd, signedMoney, contrast.cost_delta_percent, false)}</td>
    <td>${metricPair(contrast.latency_delta_ms, signedDuration, contrast.latency_delta_percent, false)}</td>
    <td>${integer(runner.regressions.count)}</td>
    <td>${statusBadge(runner.verdict.status)}</td>
  </tr>`;
}

function renderClaims(claims) {
  if (!claims) return "";
  return `<section class="claim-strip" aria-label="Certified claims">
    ${Object.entries(claims).map(([name, claim]) => `<div>
      <span>${escapeHtml(humanize(name))}</span>
      <strong class="claim-${safeId(claim.status)}">${escapeHtml(humanize(claim.status))}</strong>
    </div>`).join("")}
  </section>`;
}

function environmentPolicySummary(policy) {
  if (!policy) return "Not recorded";
  const explicit = [...new Set([
    ...Object.values(policy.runners ?? {}).flat(),
    ...Object.values(policy.assertions ?? {}).flat(),
    ...Object.values(policy.judges ?? {}).flat()
  ])].sort();
  return `${policy.defaults?.length ?? 0} safe defaults · explicit: ${explicit.join(", ") || "none"}`;
}

function renderRunner(runner, report, caseIndex) {
  const contrast = runner.contrasts.auto_vs_without;
  const activation = runner.activation;
  const cases = contrast.per_case.slice().sort((a, b) => a.delta - b.delta);
  const width = cases.reduce((maximum, item) => Math.max(maximum, Math.abs(item.delta)), 1);
  const runs = report.runs.filter((run) => run.runner_id === runner.runner_id);
  return `<article class="runner" id="runner-${safeId(runner.runner_id)}">
    <header class="runner-head">
      <div>
        <p class="eyebrow">${escapeHtml(runner.provider)} · ${escapeHtml(runner.model)}</p>
        <h3>${escapeHtml(runner.runner_id)}</h3>
      </div>
      ${statusBadge(runner.verdict.status)}
    </header>

    <div class="metric-strip">
      ${metricBlock("Quality", contrast.quality_delta_points, " points", direction(contrast.quality_delta_points, true), true)}
      ${metricBlock("Activation recall", activation.recall.value === null ? null : activation.recall.value * 100, "%", fractionLabel(activation.recall))}
      ${metricBlock("False activation", activation.false_activation_rate.value === null ? null : activation.false_activation_rate.value * 100, "%", fractionLabel(activation.false_activation_rate))}
      ${metricBlock("Paired positive cases", contrast.cases, "", `${contrast.quality_wins} win · ${contrast.quality_ties} tie · ${contrast.quality_losses} loss`)}
    </div>
    ${renderConfidenceSummary(contrast)}

    ${renderConditionLedger(runner, runs)}

    <div class="runner-grid">
      <section aria-labelledby="deltas-${safeId(runner.runner_id)}">
        <h4 id="deltas-${safeId(runner.runner_id)}">Per-case quality delta</h4>
        ${cases.length ? `<ol class="delta-plot">
          ${cases.map((item) => renderDelta(item, width, runner.regressions, runner.runner_id)).join("")}
        </ol>` : `<p class="empty">No paired quality measurements were recorded.</p>`}
      </section>
      <section aria-labelledby="gates-${safeId(runner.runner_id)}">
        <h4 id="gates-${safeId(runner.runner_id)}">Configured gates</h4>
        <div class="table-wrap" role="region" aria-label="Configured gates for ${escapeAttribute(runner.runner_id)}" tabindex="0">
          <table class="compact">
            <thead><tr><th scope="col">Gate</th><th scope="col">Observed</th><th scope="col">Limit</th><th scope="col">Status</th></tr></thead>
            <tbody>${runner.verdict.gates.map(renderGate).join("")}</tbody>
          </table>
        </div>
      </section>
    </div>
    ${renderRegressions(runner)}

    <section class="cases" aria-labelledby="evidence-${safeId(runner.runner_id)}">
      <div class="case-tools no-print">
        <h4 id="evidence-${safeId(runner.runner_id)}">Per-case evidence</h4>
        <label>Filter cases
          <input class="case-search" data-runner="${safeId(runner.runner_id)}" type="search" placeholder="Search by title or ID">
        </label>
        <span class="case-count" aria-live="polite">${cases.length} cases</span>
      </div>
      ${cases.map((item) => renderCase(item, runs, caseIndex.get(item.case_id), runner.runner_id)).join("")}
    </section>
  </article>`;
}

function renderDelta(item, width, regressions, runnerId) {
  const negative = item.delta < 0;
  const deltaTone = Math.abs(item.delta) < 0.05 ? "neutral" : negative ? "bad" : "good";
  const size = Math.max(2, (Math.abs(item.delta) / width) * 48);
  const regressed = regressions.items.some((entry) => entry.case_id === item.case_id);
  return `<li>
    <span class="delta-label"><a href="#case-${safeId(runnerId)}-${safeId(item.case_id)}">${escapeHtml(item.title)}</a><small>${escapeHtml(item.applicability)}</small></span>
    <span class="delta-axis" aria-hidden="true">
      <i class="${negative ? "negative" : "positive"}" style="width:${size}%;${negative ? "right:50%" : "left:50%"}"></i>
    </span>
    <strong class="${deltaTone}">${signed(item.delta)} pts${regressed ? " · regression" : ""}</strong>
  </li>`;
}

function renderCase(item, runs, testCase, runnerId) {
  const relevant = runs.filter((run) => run.case_id === item.case_id);
  const automatic = relevant.filter((run) => run.condition === "skill_available_auto");
  const instrumented = automatic.filter((run) => run.activation?.instrumented === true);
  const activation = instrumented.filter((run) => run.activation.skill_resource_loaded === true).length;
  const uninstrumented = automatic.length - instrumented.length;
  const evidence = relevant.map(renderRunEvidence).filter(Boolean).join("");
  const deltaTone = Math.abs(item.delta) < 0.05 ? "neutral" : item.delta < 0 ? "bad" : "good";
  return `<details class="case" id="case-${safeId(runnerId)}-${safeId(item.case_id)}" data-search="${escapeAttribute(`${item.case_id} ${item.title} ${item.applicability}`.toLowerCase())}">
    <summary>
      <span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.case_id)} · ${escapeHtml(item.applicability)}</small></span>
      <span class="case-score"><span><span class="sr-only">Baseline: </span><b>${format(item.baseline)}</b></span><i aria-hidden="true">→</i><span><span class="sr-only">Skill available automatically: </span><b>${format(item.treatment)}</b></span><em class="${deltaTone}"><span class="sr-only">Delta: </span>${signed(item.delta)} pts</em></span>
    </summary>
    <div class="case-body">
      <p><strong>Prompt:</strong> ${escapeHtml(testCase?.prompt ?? "Prompt not embedded.")}</p>
      <div class="repeat-table table-wrap" role="region" aria-label="Repeat-level measurements for ${escapeAttribute(item.title)}" tabindex="0">
        <table>
          <caption>Repeat-level measurements for ${escapeHtml(item.title)}.</caption>
          <thead><tr><th scope="col">Condition</th><th scope="col">Repeat</th><th scope="col">Run status</th><th scope="col">Quality</th><th scope="col">Tokens</th><th scope="col">Cost</th><th scope="col">Latency</th><th scope="col">Activation</th></tr></thead>
          <tbody>${relevant.sort((a, b) => a.repeat - b.repeat || String(a.condition).localeCompare(String(b.condition))).map(renderRunRow).join("")}</tbody>
        </table>
      </div>
      <p class="definition">Automatic activation was observed in ${integer(activation)} of ${integer(instrumented.length)} instrumented automatic runs.${uninstrumented ? ` ${integer(uninstrumented)} automatic run${uninstrumented === 1 ? " was" : "s were"} not instrumented.` : ""} Instrumentation, not output wording, is used for this count.</p>
      ${evidence ? `<div class="run-evidence-list"><h5>Assertions and judge evidence</h5>${evidence}</div>` : ""}
    </div>
  </details>`;
}

function renderConditionLedger(runner, runs) {
  const conditions = [
    ["without_skill", "Baseline"],
    ["skill_available_auto", "Available / auto"],
    ["skill_forced", "Forced"]
  ].filter(([condition]) => runner.conditions[condition]);
  return `<div class="condition-ledger table-wrap" role="region" aria-label="Absolute condition measurements for ${escapeAttribute(runner.runner_id)}" tabindex="0">
    <table>
      <caption>Absolute condition measurements. Each metric states its own coverage. Cost is a total; tokens and latency are medians.</caption>
      <thead><tr><th scope="col">Condition</th><th scope="col">Runs</th><th scope="col">Mean quality</th><th scope="col">Median tokens</th><th scope="col">Total cost</th><th scope="col">Median latency</th></tr></thead>
      <tbody>${conditions.map(([condition, label]) => {
        const item = runner.conditions[condition];
        const conditionRuns = runs.filter((run) => run.condition === condition);
        const costSource = costSourceSummary(conditionRuns);
        return `<tr><th scope="row">${label}<small>${escapeHtml(condition)}</small></th><td>${integer(item.completed)} completed<small>${integer(item.runs)} recorded</small></td><td>${coverage(format(item.quality.mean), item.quality.measured, item.runs)}</td><td>${coverage(integer(item.tokens.median), item.tokens.measured, item.runs)}</td><td>${coverage(money(item.cost_usd.total), item.cost_usd.measured, item.runs, costSource)}</td><td>${coverage(duration(item.latency_ms.median), item.latency_ms.measured, item.runs)}</td></tr>`;
      }).join("")}</tbody>
    </table>
  </div>`;
}

function renderRunRow(run) {
  const usage = run.usage ?? {};
  const totalTokens = usage.total_tokens
    ?? (Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)
      ? usage.input_tokens
        + (usage.input_token_semantics === "exclusive"
          ? (usage.cached_input_tokens ?? 0) + (usage.cache_write_tokens ?? 0)
          : 0)
        + usage.output_tokens
      : null);
  const costs = run.costs ?? {};
  const cost = costs.observed_usd ?? costs.estimated_api_equivalent_usd;
  const costSource = Number.isFinite(costs.observed_usd)
    ? "Observed"
    : Number.isFinite(costs.estimated_api_equivalent_usd) ? "API-equivalent estimate" : "Not recorded";
  const activation = !run.activation?.instrumented
    ? "Not instrumented"
    : run.activation.skill_resource_loaded ? "Loaded" : "Not loaded";
  return `<tr>
    <th scope="row">${escapeHtml(humanize(run.condition))}</th>
    <td>${integer(run.repeat)}</td>
    <td>${escapeHtml(humanize(run.status))}</td>
    <td>${format(run.score?.quality_percent)}</td>
    <td>${integer(totalTokens)}</td>
    <td>${money(cost)}<small>${costSource}</small></td>
    <td>${duration(run.duration_ms)}</td>
    <td>${activation}</td>
  </tr>`;
}

function renderGate(gate) {
  return `<tr><th scope="row">${escapeHtml(humanize(gate.id))}</th><td>${gateValue(gate.value, gate.unit)}</td><td>${gateValue(gate.threshold, gate.unit)}</td><td>${statusBadge(gate.status)}</td></tr>`;
}

function renderConfidenceSummary(contrast) {
  const ci = contrast.quality_confidence_interval ?? {};
  const positiveCases = (contrast.per_case ?? []).filter((item) => item.applicability === "positive");
  const repeats = positiveCases.map((item) => item.repeats).filter(Number.isFinite);
  const repeatText = !repeats.length
    ? "Repeats not recorded"
    : Math.min(...repeats) === Math.max(...repeats)
      ? `${integer(repeats[0])} repeat${repeats[0] === 1 ? "" : "s"} per case`
      : `${integer(Math.min(...repeats))}-${integer(Math.max(...repeats))} repeats per case`;
  const confidence = Number.isFinite(ci.confidence) ? `${percent(ci.confidence * 100)}%` : "Confidence not recorded";
  return `<p class="confidence-line"><strong>${escapeHtml(confidence)} ${escapeHtml(ci.method ?? "interval method not recorded")}</strong><span>${integer(contrast.cases)} positive case${contrast.cases === 1 ? "" : "s"} · ${repeatText} · ${integer(contrast.pairs)} paired run${contrast.pairs === 1 ? "" : "s"}</span></p>`;
}

function renderRegressions(runner) {
  const items = runner.regressions?.items ?? [];
  if (!items.length) {
    return `<section class="regressions" aria-labelledby="regressions-${safeId(runner.runner_id)}"><h4 id="regressions-${safeId(runner.runner_id)}">Regression events</h4><p class="empty">No repeat crossed the configured regression threshold.</p></section>`;
  }
  return `<section class="regressions" aria-labelledby="regressions-${safeId(runner.runner_id)}">
    <h4 id="regressions-${safeId(runner.runner_id)}">Regression events</h4>
    <div class="table-wrap" role="region" aria-label="Regression events for ${escapeAttribute(runner.runner_id)}" tabindex="0">
      <table>
        <caption>${integer(items.length)} repeat-level regression event${items.length === 1 ? "" : "s"}. Multiple events may belong to one case.</caption>
        <thead><tr><th scope="col">Case</th><th scope="col">Repeat</th><th scope="col">Quality delta</th><th scope="col">New critical failures</th></tr></thead>
        <tbody>${items.map((item) => `<tr><th scope="row"><a href="#case-${safeId(runner.runner_id)}-${safeId(item.case_id)}">${escapeHtml(item.case_id)}</a></th><td>${integer(item.repeat)}</td><td class="bad">${signed(item.quality_delta_points)} pts</td><td>${escapeHtml((item.new_critical_failures ?? []).join(", ") || "None recorded")}</td></tr>`).join("")}</tbody>
      </table>
    </div>
  </section>`;
}

function renderRunEvidence(run) {
  const assertions = Array.isArray(run.assertions) ? run.assertions : [];
  const judgments = Array.isArray(run.judgments) ? run.judgments : [];
  const generationError = run.status !== "completed"
    || Number.isFinite(run.generation?.exit_code) && run.generation.exit_code !== 0
    || Boolean(run.generation?.stderr);
  if (!assertions.length && !judgments.length && !generationError) return "";
  const label = `${humanize(run.condition)} · repeat ${integer(run.repeat)} · ${humanize(run.status)}`;
  return `<details class="run-evidence">
    <summary>${escapeHtml(label)}</summary>
    <div>
      ${generationError ? `<div class="error-note"><strong>Generation status: ${escapeHtml(humanize(run.status))}</strong>${Number.isFinite(run.generation?.exit_code) ? `<span>Exit code ${integer(run.generation.exit_code)}</span>` : ""}${run.generation?.stderr ? `<pre>${escapeHtml(run.generation.stderr)}</pre>` : ""}</div>` : ""}
      ${assertions.length ? `<div class="table-wrap" role="region" aria-label="Assertions for ${escapeAttribute(label)}" tabindex="0"><table class="compact"><caption>Deterministic assertions.</caption><thead><tr><th scope="col">Assertion</th><th scope="col">Status</th><th scope="col">Critical</th><th scope="col">Points</th></tr></thead><tbody>${assertions.map((assertion) => `<tr><th scope="row">${escapeHtml(assertion.id)}</th><td>${escapeHtml(humanize(assertion.status))}</td><td>${assertion.critical ? "Yes" : "No"}</td><td>${integer(assertion.points)}</td></tr>`).join("")}</tbody></table></div>` : ""}
      ${judgments.map(renderJudgment).join("")}
    </div>
  </details>`;
}

function renderJudgment(judgment) {
  const evidence = Array.isArray(judgment.evidence) ? judgment.evidence : [];
  return `<article class="judgment">
    <h6>Judge ${escapeHtml(judgment.judge_id ?? "Not recorded")}</h6>
    <p><strong>Status:</strong> ${escapeHtml(humanize(judgment.status))}${Number.isFinite(judgment.percent) ? ` · ${format(judgment.percent)}%` : ""}${judgment.blinding_compromised ? " · Blinding compromised" : ""}</p>
    ${judgment.rationale ? `<p>${escapeHtml(judgment.rationale)}</p>` : ""}
    ${evidence.length ? `<p><strong>Evidence:</strong> ${evidence.map((item) => escapeHtml(item)).join(", ")}</p>` : ""}
  </article>`;
}

function coverage(value, measured, total, note = "") {
  const partial = Number.isFinite(measured) && Number.isFinite(total) && measured < total;
  const coverageText = Number.isFinite(measured) && Number.isFinite(total)
    ? `${integer(measured)} of ${integer(total)} measured`
    : "Coverage not recorded";
  return `${value}<small>${note ? `${escapeHtml(note)} · ` : ""}${coverageText}${partial ? ' · <span class="partial">Partial</span>' : ""}</small>`;
}

function costSourceSummary(runs) {
  const observed = runs.filter((run) => Number.isFinite(run.costs?.observed_usd)).length;
  const estimated = runs.filter((run) => !Number.isFinite(run.costs?.observed_usd) && Number.isFinite(run.costs?.estimated_api_equivalent_usd)).length;
  if (observed && estimated) return "Mixed observed and API-equivalent estimates";
  if (observed) return "Observed";
  if (estimated) return "API-equivalent estimate";
  return "Not recorded";
}

function styles() {
  return String.raw`
:root {
  --canvas:#f5f7f8;--surface:#fff;--ink:#15191c;--muted:#58616a;--rule:#d8dde1;
  --accent:#1f5eff;--baseline:#68737d;--good:#16794b;--bad:#b42318;--warn:#8a5d00;
  --code:ui-monospace,"Cascadia Mono",Consolas,monospace;--sans:ui-sans-serif,system-ui,"Segoe UI",sans-serif
}
html[data-theme="dark"]{--canvas:#111416;--surface:#171b1e;--ink:#edf1f4;--muted:#a8b1b9;--rule:#30363b;--accent:#78a0ff;--baseline:#9aa4ad;--good:#58c58f;--bad:#ff8177;--warn:#e2b85b}
@media(prefers-color-scheme:dark){html[data-theme="system"]{--canvas:#111416;--surface:#171b1e;--ink:#edf1f4;--muted:#a8b1b9;--rule:#30363b;--accent:#78a0ff;--baseline:#9aa4ad;--good:#58c58f;--bad:#ff8177;--warn:#e2b85b}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.55 var(--sans);font-variant-numeric:tabular-nums lining-nums}
a{color:inherit;text-decoration-color:var(--accent);text-underline-offset:3px}
button,select,input{min-height:40px;font:inherit;color:inherit;background:var(--surface);border:1px solid var(--rule);border-radius:4px;padding:7px 10px}
button{cursor:pointer}button:hover{border-color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip-link{position:fixed;z-index:20;top:8px;left:8px;padding:8px;background:var(--ink);color:var(--surface);transform:translateY(-150%)}
.skip-link:focus{transform:none}
.topbar{position:sticky;z-index:10;top:0;display:flex;align-items:center;gap:28px;min-height:56px;padding:8px clamp(16px,4vw,64px);background:color-mix(in srgb,var(--canvas) 92%,transparent);border-bottom:1px solid var(--rule);backdrop-filter:blur(12px)}
.wordmark{font:700 14px var(--code);text-decoration:none}.wordmark span{color:var(--muted);font-weight:400}
.topbar nav{display:flex;gap:18px;margin-right:auto;font-size:13px}.topbar nav a{text-decoration:none;color:var(--muted)}.topbar nav a:hover{color:var(--ink)}
.controls{display:flex;align-items:center;gap:8px}.controls label{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px}.download-short{display:none}
main{width:min(1440px,calc(100% - 32px));margin:auto}
.masthead{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:48px;align-items:end;padding:56px 0 40px;border-bottom:1px solid var(--ink)}
.eyebrow,.section-heading p{margin:0 0 8px;color:var(--muted);font:12px var(--code);text-transform:uppercase;letter-spacing:.06em}
h1{max-width:22ch;overflow-wrap:anywhere;margin:0;font-size:clamp(36px,5vw,60px);line-height:1;letter-spacing:-.045em}
h2{margin:0;font-size:clamp(26px,3vw,42px);line-height:1;letter-spacing:-.035em}
h3{margin:0;font-size:28px;letter-spacing:-.025em}h4{margin:0 0 16px;font-size:17px}h5{margin:24px 0 10px;font-size:15px}h6{margin:0;font-size:13px}
.lede{max-width:65ch;margin:20px 0 0;color:var(--muted);font-size:17px}.verdict-explanation{max-width:80ch;margin:18px 0 0;color:var(--muted)}
.claim-strip{display:flex;flex-wrap:wrap;gap:1px;margin:22px 0;background:var(--rule);border:1px solid var(--rule);border-radius:12px;overflow:hidden}.claim-strip div{display:flex;gap:18px;justify-content:space-between;min-width:190px;flex:1;padding:14px 16px;background:var(--surface)}.claim-strip span{color:var(--muted)}.claim-strip strong{font-size:13px;text-transform:uppercase;letter-spacing:.06em}.claim-verified{color:var(--good)}.claim-failed{color:var(--bad)}.claim-inconclusive,.claim-not-measured,.claim-not-claimed{color:var(--warn)}
.stamp{width:230px;padding:16px;border:1px solid currentColor;border-left-width:5px}.stamp span,.stamp small{display:block;color:var(--muted);font:12px var(--code)}.stamp strong{display:block;margin:7px 0;font:800 24px var(--code)}
.stamp-passed{color:var(--good)}.stamp-failed{color:var(--bad)}.stamp-inconclusive{color:var(--warn)}
.notice{display:grid;grid-template-columns:220px 1fr;gap:32px;margin:24px 0 0;padding:18px;border-left:5px solid var(--warn);background:color-mix(in srgb,var(--warn) 7%,var(--surface))}.notice h2{font-size:17px}.notice ul{margin:0;padding-left:20px}
.section{padding:64px 0;border-bottom:1px solid var(--rule)}.section-heading{display:grid;grid-template-columns:220px 1fr;gap:32px;align-items:end;margin-bottom:32px}
.repository-card-grid{display:grid;grid-template-columns:minmax(0,640px) minmax(260px,1fr);gap:36px;align-items:center}.repository-card-preview{margin:0}.repository-card-preview img{display:block;width:100%;height:auto;border-radius:14px;box-shadow:0 16px 44px rgb(0 0 0 / .12)}.repository-card-preview figcaption{margin-top:10px;color:var(--muted);font-size:12px}.embed-instructions p{max-width:52ch;color:var(--muted)}.embed-instructions pre{overflow:auto;padding:14px;background:var(--surface);border:1px solid var(--rule);font:12px/1.5 var(--code)}
.table-wrap{max-width:100%;overflow:auto;overscroll-behavior-inline:contain}.table-wrap:focus-visible{outline-offset:4px}
table{width:100%;border-collapse:collapse;text-align:left}caption{padding:0 0 12px;color:var(--muted);text-align:left;font-size:13px}
th,td{padding:13px 12px;border-bottom:1px solid var(--rule);vertical-align:top}thead th{color:var(--muted);font:11px var(--code);text-transform:uppercase;letter-spacing:.045em}tbody th{font-weight:650}
tbody th small,td small{display:block;color:var(--muted);font:11px var(--code)}.definition{max-width:80ch;color:var(--muted);font-size:12px}
.status{display:inline-block;border-bottom:2px solid currentColor;font:700 11px var(--code);text-transform:uppercase}.status-passed{color:var(--good)}.status-failed{color:var(--bad)}.status-inconclusive{color:var(--warn)}
.good{color:var(--good)}.bad{color:var(--bad)}.neutral{color:var(--muted)}.muted{color:var(--muted)}.partial{color:var(--warn);font-weight:700}
.runner{margin-top:48px;padding:24px;background:var(--surface);border:1px solid var(--rule);border-radius:4px}.runner:first-of-type{margin-top:0}
.runner-head{display:flex;align-items:flex-start;justify-content:space-between;padding-bottom:20px;border-bottom:1px solid var(--rule)}
.metric-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-bottom:1px solid var(--rule)}.metric-block{padding:20px 16px;border-right:1px solid var(--rule)}.metric-block:last-child{border-right:0}
.metric-block span,.metric-block small{display:block;color:var(--muted);font-size:12px}.metric-block strong{display:block;margin:5px 0;font:700 clamp(24px,3vw,38px) var(--code)}
.confidence-line{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 24px;margin:0;padding:12px 16px;border-bottom:1px solid var(--rule);color:var(--muted);font:12px var(--code)}.confidence-line strong{color:var(--ink)}
.condition-ledger{padding:28px 0;border-bottom:1px solid var(--rule)}.runner-grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(340px,.8fr);gap:40px;padding:32px 0}
.delta-plot{list-style:none;margin:0;padding:0}.delta-plot li{display:grid;grid-template-columns:minmax(140px,1fr) minmax(180px,1.4fr) 150px;gap:12px;align-items:center;min-height:46px;border-bottom:1px solid var(--rule)}
.delta-label{min-width:0;overflow-wrap:anywhere}.delta-label small{display:block;color:var(--muted);font:10px var(--code);text-transform:uppercase}
.delta-axis{position:relative;height:18px;background:linear-gradient(90deg,transparent calc(50% - .5px),var(--rule) 50%,transparent calc(50% + .5px))}.delta-axis i{position:absolute;top:6px;height:6px}.delta-axis .positive{background:var(--good)}.delta-axis .negative{background:var(--bad)}
.compact th,.compact td{padding:9px 8px}.regressions{padding:0 0 32px}
.case-tools{display:flex;align-items:end;gap:16px;margin:16px 0}.case-tools h4{margin:0 auto 0 0}.case-tools label{display:grid;gap:4px;color:var(--muted);font-size:11px}.case-count{min-width:60px;color:var(--muted);font:11px var(--code)}
.case{border-top:1px solid var(--rule)}.case:last-child{border-bottom:1px solid var(--rule)}.case summary{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:17px 4px;cursor:pointer}.case summary>span:first-child small{display:block;color:var(--muted);font:11px var(--code)}
.case-score{display:flex;align-items:center;gap:12px;font-family:var(--code)}.case-score i{color:var(--muted);font-style:normal}.case-score em{min-width:85px;font-style:normal;font-weight:700}
.case-body{padding:4px 24px 24px;border-left:2px solid var(--accent)}.repeat-table{margin-top:20px}
.run-evidence{margin-top:8px;border:1px solid var(--rule);border-radius:4px}.run-evidence>summary{padding:10px 12px;font:12px var(--code);cursor:pointer}.run-evidence>div{padding:0 12px 12px}.error-note{padding:12px;border-left:4px solid var(--bad);background:color-mix(in srgb,var(--bad) 6%,var(--surface))}.error-note strong,.error-note span{display:block}.error-note pre{white-space:pre-wrap;overflow-wrap:anywhere}
.judgment{margin-top:12px;padding:12px;border-left:2px solid var(--accent);background:color-mix(in srgb,var(--accent) 4%,var(--surface))}.judgment p{margin:6px 0}
.split{display:grid;grid-template-columns:220px 1fr;gap:32px}.split .section-heading{display:block;margin:0}
.provenance{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule)}.provenance div{min-width:0;padding:14px;background:var(--surface)}.provenance dt{color:var(--muted);font:10px var(--code);text-transform:uppercase}.provenance dd{overflow-wrap:anywhere;margin:5px 0 0;font:13px var(--code)}
.limitations ul{margin:0;padding-left:20px;columns:2;column-gap:40px}.limitations li{break-inside:avoid;margin-bottom:12px}
.raw pre{max-height:560px;overflow:auto;padding:20px;background:var(--surface);border:1px solid var(--rule);font:12px/1.6 var(--code)}
footer{padding:40px 16px;text-align:center;color:var(--muted);font:12px var(--code)}.empty{padding:18px;border:1px dashed var(--rule);color:var(--muted)}
@media(max-width:900px){.topbar nav{display:none}.controls{margin-left:auto}.masthead{grid-template-columns:1fr}.stamp{width:100%}.section-heading,.notice,.split,.repository-card-grid{grid-template-columns:1fr}.metric-strip{grid-template-columns:repeat(2,1fr)}.metric-block:nth-child(2){border-right:0}.runner-grid{grid-template-columns:1fr}.limitations ul{columns:1}}
@media(max-width:720px){main{width:min(100% - 24px,1440px)}.topbar{gap:10px;padding:8px 12px}.controls{gap:5px}.control-label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.download-long{display:none}.download-short{display:inline}.masthead{padding-top:40px}h1{font-size:40px}.runner{padding:16px}.metric-strip{grid-template-columns:1fr}.metric-block{border-right:0}.delta-plot li{grid-template-columns:1fr 110px}.delta-axis{display:none}.case-tools{align-items:stretch;flex-direction:column}.case-tools h4{margin:0}.case summary{align-items:flex-start;flex-direction:column}.case-score{width:100%;justify-content:space-between}.case-body{padding-right:12px}.provenance{grid-template-columns:1fr}button,select,input{min-height:44px}}
@media(max-width:480px){.wordmark span{display:none}.topbar{gap:6px}.controls{gap:4px}button,select{padding-inline:7px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@page{size:landscape;margin:12mm}
@media print{
  html,html[data-theme="system"],html[data-theme="light"],html[data-theme="dark"]{--canvas:#fff;--surface:#fff;--ink:#111;--muted:#555;--rule:#bbb;--accent:#174ec2;--good:#146c43;--bad:#a51d13;--warn:#765000;color-scheme:light}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{font-size:9pt;background:#fff;color:#111}.topbar,.no-print,.raw{display:none!important}main{width:100%}.masthead{padding:0 0 20px}.section{padding:24px 0}.section,.runner,.case,.run-evidence{break-inside:auto}.runner{margin-top:24px;border:0;padding:0}.table-wrap{overflow:visible!important}table{font-size:8.5pt}th,td{padding:5px 6px}
  .case:not([open])>.case-body,.run-evidence:not([open])>div{display:block!important}.case summary,.run-evidence summary,h2,h3,h4,h5,thead{break-after:avoid}.metric-block,.stamp,.notice,.judgment{break-inside:avoid}a{text-decoration:none}
}
`;
}

function clientScript() {
  return String.raw`
(() => {
  const root = document.documentElement;
  const theme = document.getElementById("theme");
  const themes = new Set(["system", "light", "dark"]);
  try {
    const saved = localStorage.getItem("skillproof-theme");
    if (themes.has(saved)) { root.dataset.theme = saved; theme.value = saved; }
  } catch {}
  theme.addEventListener("change", () => {
    root.dataset.theme = theme.value;
    try { localStorage.setItem("skillproof-theme", theme.value); } catch {}
  });
  document.getElementById("print").addEventListener("click", () => window.print());
  const raw = document.getElementById("skillproof-data").textContent;
  document.getElementById("download").addEventListener("click", () => {
    const blob = new Blob([raw], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "skillproof-results.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  for (const input of document.querySelectorAll(".case-search")) {
    input.addEventListener("input", () => {
      const runner = document.getElementById("runner-" + input.dataset.runner);
      const query = input.value.trim().toLowerCase();
      let visible = 0;
      for (const item of runner.querySelectorAll(".case")) {
        item.hidden = !item.dataset.search.includes(query);
        if (!item.hidden) visible += 1;
      }
      runner.querySelector(".case-count").textContent = visible + (visible === 1 ? " case" : " cases");
    });
  }
})();
`;
}

function buildWarnings(report) {
  const warnings = [];
  if (!report.benchmark.mode) {
    warnings.push("Benchmark mode is not recorded. Interpret the evidence only within the stated limitations.");
  } else if (String(report.benchmark.mode).toLowerCase() === "synthetic") {
    warnings.push("This benchmark is marked synthetic and does not support claims about real model performance.");
  }
  if (report.summary.run_counts.completed < report.summary.run_counts.planned) {
    warnings.push("Some planned runs did not complete. Failed generations were retained and the affected comparisons may be inconclusive.");
  }
  if (report.runs.some((run) => !run.activation?.instrumented && run.condition === "skill_available_auto")) {
    warnings.push("Activation telemetry is incomplete. Availability alone is not counted as activation.");
  }
  if (report.runs.some((run) => run.score?.evidence === "deterministic_only")) {
    warnings.push("At least one quality score uses deterministic checks only; dimensions requiring judgment remain unmeasured.");
  }
  if (report.runs.some((run) => run.costs?.warning)) {
    warnings.push("Some costs could not be estimated from the pinned price catalog. Missing costs are shown as not recorded.");
  }
  const runners = Object.values(report.summary.runners);
  if (!VERDICT_STATUSES.has(String(report.summary.verdict.status))
    || runners.some((runner) => !VERDICT_STATUSES.has(String(runner.verdict?.status)))
    || runners.some((runner) => runner.verdict?.gates?.some((gate) => !VERDICT_STATUSES.has(String(gate.status))))) {
    warnings.push("At least one unrecognized result status was normalized to inconclusive.");
  }
  for (const runner of runners) {
    const contrast = runner.contrasts?.auto_vs_without;
    const ci = contrast?.quality_confidence_interval;
    if (Number.isFinite(contrast?.quality_delta_points)
      && (!Number.isFinite(ci?.lower) || !Number.isFinite(ci?.upper))) {
      warnings.push(`Quality confidence bounds are unavailable for ${runner.runner_id}; the configured gate uses the recorded point estimate.`);
    }
  }
  return warnings;
}

function cardMetric(x, label, value) {
  return `<text x="${x}" y="111" fill="#87958E" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="10" font-weight="700" letter-spacing="0.8">${escapeHtml(label)}</text>
  <text x="${x}" y="139" fill="#F2F5F3" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="22" font-weight="700">${escapeHtml(value)}</text>`;
}

function metricRange(values, suffix) {
  const measured = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!measured.length) return "not recorded";
  const minimum = signed(measured[0]);
  const maximum = signed(measured.at(-1));
  return `${minimum}${minimum === maximum ? "" : `–${maximum}`}${suffix}`;
}

function truncateCardText(value, limit) {
  const text = String(value ?? "Untitled benchmark").replaceAll(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function metricBlock(label, value, suffix, note, showSign = false) {
  return `<div class="metric-block"><span>${escapeHtml(label)}</span><strong>${Number.isFinite(value) ? `${showSign ? signed(value) : compact(value)}${suffix}` : "Not recorded"}</strong><small>${escapeHtml(note)}</small></div>`;
}

function metric(value, suffix, positiveGood) {
  if (!Number.isFinite(value)) return `<span class="muted">Not recorded</span>`;
  const tone = Math.abs(value) < 0.05
    ? "neutral"
    : positiveGood ? value > 0 ? "good" : "bad" : value > 0 ? "bad" : "good";
  return `<strong class="${tone}">${signed(value)}${suffix}</strong>`;
}

function metricPair(absolute, formatter, percent, positiveGood) {
  if (!Number.isFinite(absolute) && !Number.isFinite(percent)) return `<span class="muted">Not recorded</span>`;
  const directionalValue = Number.isFinite(percent) ? percent : absolute;
  const tone = Math.abs(directionalValue) < 0.05
    ? "neutral"
    : positiveGood ? directionalValue > 0 ? "good" : "bad" : directionalValue > 0 ? "bad" : "good";
  const absoluteText = Number.isFinite(absolute) ? formatter(absolute) : "Absolute not recorded";
  const percentText = Number.isFinite(percent) ? `${signed(percent)}%` : "Relative not recorded";
  return `<strong class="${tone}">${escapeHtml(absoluteText)}</strong><small>${escapeHtml(percentText)}</small>`;
}

function direction(value, positiveGood) {
  if (!Number.isFinite(value)) return "Not measured";
  if (Math.abs(value) < 0.05) return "No material change";
  return positiveGood === value > 0 ? "Better" : "Worse";
}

function fractionLabel(metricValue) {
  return metricValue?.total ? `${metricValue.successes} of ${metricValue.total} instrumented runs` : "Not instrumented";
}

function confidenceInterval(ci = {}) {
  const confidence = Number.isFinite(ci.confidence) ? `${percent(ci.confidence * 100)}% CI` : "CI";
  const bounds = Number.isFinite(ci.lower) && Number.isFinite(ci.upper)
    ? `${signed(ci.lower)} to ${signed(ci.upper)} pts`
    : "Bounds not available";
  return `<span>${escapeHtml(confidence)}<strong>${escapeHtml(bounds)}</strong><small>${escapeHtml(ci.method ?? "Method not recorded")}</small></span>`;
}

function gateValue(value, unit) {
  if (!Number.isFinite(value)) return "Not recorded";
  if (unit === "ratio") return `${(value * 100).toFixed(1)}%`;
  if (unit === "percent") return `${signed(value)}%`;
  if (unit === "points") return `${signed(value)} pts`;
  return String(value);
}

function definition(term, value) {
  return `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(String(value))}</dd></div>`;
}

function format(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "Not recorded";
}

function integer(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "Not recorded";
}

function money(value) {
  return Number.isFinite(value) ? `$${value.toFixed(5)}` : "Not recorded";
}

function signedMoney(value) {
  if (!Number.isFinite(value)) return "Not recorded";
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}$${Math.abs(value).toFixed(5)}`;
}

function duration(value) {
  return Number.isFinite(value) ? value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms` : "Not recorded";
}

function signedDuration(value) {
  if (!Number.isFinite(value)) return "Not recorded";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  return absolute >= 1000 ? `${sign}${(absolute / 1000).toFixed(2)} s` : `${sign}${absolute.toFixed(1)} ms`;
}

function signed(value) {
  if (!Number.isFinite(value)) return "Not recorded";
  return `${value > 0 ? "+" : ""}${Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1)}`;
}

function compact(value) {
  if (!Number.isFinite(value)) return "Not recorded";
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
}

function percent(value) {
  if (!Number.isFinite(value)) return "Not recorded";
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function shortHash(value) {
  return value ? value.slice(0, 12) : "Not recorded";
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return String(value ?? "Not recorded");
  }
}

function safeId(value) {
  const text = String(value ?? "");
  const slug = text.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 64) || "item";
  return `${slug}-${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;
}

function normalizeVerdict(value) {
  const status = String(value ?? "").toLowerCase();
  return VERDICT_STATUSES.has(status) ? status : "inconclusive";
}

function statusBadge(value) {
  const status = normalizeVerdict(value);
  return `<span class="status status-${status}">${escapeHtml(status)}</span>`;
}

function humanize(value) {
  return String(value ?? "Not recorded").replaceAll("_", " ");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value)
    .replaceAll("`", "&#096;")
    .replaceAll("=", "&#061;");
}
