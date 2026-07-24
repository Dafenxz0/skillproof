import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStarterConfig, loadConfig, resolveConfigPaths, validateConfig } from "./config.js";
import { judgeRuns } from "./judge.js";
import { loadPricingCatalog } from "./pricing.js";
import { writeHtmlReport } from "./report.js";
import { executeCommand, executeRun, hashTree } from "./runner.js";
import { summarizeBenchmark } from "./stats.js";
import {
  CONDITIONS,
  createPrng,
  id,
  pathExists,
  readJson,
  sha256,
  shuffle,
  stableStringify,
  writeJson
} from "./utils.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function main(argv) {
  const [command = "help", ...rest] = argv;
  if (["help", "--help", "-h"].includes(command)) return printHelp();
  if (["version", "--version", "-v"].includes(command)) return printVersion();
  const { options, positionals } = parseArguments(rest);
  if (command === "init") return initCommand(positionals, options);
  if (command === "validate") return validateCommand(positionals, options);
  if (command === "test") return testCommand(positionals, options);
  if (command === "report") return reportCommand(positionals, options);
  if (command === "doctor") return doctorCommand();
  if (command === "prices") return pricesCommand(options);
  throw new Error(`Unknown command: ${command}. Run skillproof help.`);
}

async function initCommand(positionals, options) {
  const skillPath = positionals[0] ?? "./skills/my-skill";
  const destination = resolve(options.config ?? "skillproof.config.json");
  if (await pathExists(destination) && !options.force) {
    throw new Error(`${destination} already exists. Use --force to replace it.`);
  }
  await writeJson(destination, createStarterConfig(skillPath));
  console.log(`Created ${destination}`);
  console.log("Edit the positive and hard-negative cases before running a benchmark.");
}

async function validateCommand(positionals, options) {
  const configPath = resolve(options.config ?? positionals[0] ?? "skillproof.config.json");
  const loaded = await loadConfig(configPath);
  const paths = resolveConfigPaths(loaded, options.skill);
  if (!await pathExists(join(paths.skillPath, "SKILL.md"))) {
    throw new Error(`No SKILL.md found at ${paths.skillPath}`);
  }
  for (const testCase of loaded.config.cases) {
    const fixture = resolve(loaded.configDir, testCase.fixture);
    if (!await pathExists(fixture)) throw new Error(`Case ${testCase.id} fixture not found: ${fixture}`);
  }
  console.log(`Valid SkillProof config: ${configPath}`);
  console.log(`${loaded.config.runners.length} runner(s), ${loaded.config.cases.length} case(s), ${loaded.config.repeats} repeat(s).`);
}

async function testCommand(positionals, options) {
  const configPath = resolve(options.config ?? "skillproof.config.json");
  const loaded = await loadConfig(configPath);
  const paths = resolveConfigPaths(loaded, positionals[0] ?? options.skill);
  if (!await pathExists(join(paths.skillPath, "SKILL.md"))) {
    throw new Error(`No SKILL.md found at ${paths.skillPath}`);
  }
  const catalogPath = options["price-catalog"] ?? loaded.config.pricing?.catalog ?? "bundled";
  const pricingCatalog = await loadPricingCatalog(catalogPath, loaded.configDir);
  const skillSha256 = await hashTree(paths.skillPath);
  const fixtureHashes = new Map();
  for (const testCase of loaded.config.cases) {
    fixtureHashes.set(
      testCase.id,
      await hashTree(resolve(loaded.configDir, testCase.fixture)),
    );
  }
  const runId = id("proof");
  const runDir = resolve(options.output ?? join(paths.outputDir, runId));
  await mkdir(runDir, { recursive: true });
  const plan = buildPlan(loaded.config);
  console.log(`SkillProof ${runId}`);
  console.log(`Running ${plan.length} generation(s) across ${loaded.config.runners.length} model configuration(s).`);
  if (!options["allow-exec"] && plan.some((item) => item.runner.adapter === "command")) {
    throw new Error("This benchmark contains command runners. Re-run with --allow-exec after reviewing the config.");
  }
  const rawRuns = await mapConcurrent(
    plan,
    loaded.config.concurrency ?? 1,
    async (item, index) => {
      console.log(`[${index + 1}/${plan.length}] ${item.runner.id} · ${item.testCase.id} · ${item.condition} · repeat ${item.repeat}`);
      return executeRun({
        ...item,
        configDir: loaded.configDir,
        skillPath: paths.skillPath,
        outputDir: runDir,
        pricingCatalog,
        allowExec: Boolean(options["allow-exec"])
      });
    },
  );
  const judgedRuns = await judgeRuns({
    runs: rawRuns,
    judges: loaded.config.judges ?? [],
    cases: loaded.config.cases,
    outputDir: runDir,
    allowExec: Boolean(options["allow-exec"]),
    profile: loaded.profile
  });
  const summary = summarizeBenchmark(judgedRuns, loaded.config);
  const skillFile = await readFile(join(paths.skillPath, "SKILL.md"), "utf8");
  const report = {
    schema_version: 1,
    generator: {
      name: "SkillProof",
      version: await packageVersion()
    },
    run_id: runId,
    generated_at: new Date().toISOString(),
    benchmark: loaded.config.benchmark,
    skill: {
      name: skillName(skillFile),
      path: relative(runDir, paths.skillPath).replaceAll("\\", "/"),
      sha256: skillSha256
    },
    profile: loaded.profile,
    conditions: loaded.config.conditions ?? CONDITIONS,
    repeats: loaded.config.repeats,
    runners: sanitizeRunners(loaded.config.runners),
    cases: await Promise.all(loaded.config.cases.map(async (testCase) => ({
      ...sanitizeCase(testCase),
      fixture_sha256: fixtureHashes.get(testCase.id)
    }))),
    pricing: {
      currency: pricingCatalog.currency,
      updated_at: pricingCatalog.updated_at,
      disclaimer: pricingCatalog.disclaimer
    },
    provenance: {
      config_sha256: sha256(loaded.config),
      pricing_sha256: sha256(pricingCatalog),
      seed: loaded.config.seed ?? 1,
      concurrency: loaded.config.concurrency ?? 1,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      runner_versions: await runnerVersionProvenance(loaded.config.runners),
      git: await gitProvenance(loaded.configDir)
    },
    summary,
    runs: judgedRuns.map((run) => ({
      ...run,
      artifact: {
        ...run.artifact,
        path: relative(runDir, run.artifact.path).replaceAll("\\", "/")
      }
    })),
    limitations: buildLimitations(loaded.config, judgedRuns)
  };
  const jsonPath = join(runDir, "results.json");
  const htmlPath = join(runDir, "report.html");
  await writeJson(jsonPath, report);
  await writeHtmlReport(report, htmlPath);
  await writeJson(join(runDir, "badge.json"), buildBadge(report));
  await writeJson(join(paths.outputDir, "latest.json"), {
    run_id: runId,
    report: relative(paths.outputDir, htmlPath).replaceAll("\\", "/"),
    results: relative(paths.outputDir, jsonPath).replaceAll("\\", "/"),
    verdict: summary.verdict.status,
    generated_at: report.generated_at
  });
  console.log(`Verdict: ${summary.verdict.status.toUpperCase()}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`HTML: ${htmlPath}`);
}

async function reportCommand(positionals, options) {
  const source = resolve(positionals[0] ?? "results.json");
  const report = await readJson(source);
  if (report.schema_version !== 1 || !report.summary || !Array.isArray(report.runs)) {
    throw new Error("Input is not a SkillProof results file");
  }
  const destination = resolve(options.output ?? join(dirname(source), "report.html"));
  await writeHtmlReport(report, destination);
  console.log(`HTML: ${destination}`);
}

async function doctorCommand() {
  console.log(`Node ${process.version} · ${process.platform}/${process.arch}`);
  for (const command of ["codex", "claude"]) {
    try {
      const result = await executeCommand(command, ["--version"], {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 10000
      });
      const detail = (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
      console.log(`${command}: ${result.exitCode === 0 ? detail : `unavailable (${detail || `exit ${result.exitCode}`})`}`);
    } catch (error) {
      console.log(`${command}: unavailable (${error.message})`);
    }
  }
  console.log("Process isolation is not a security sandbox. Use a container or VM for hostile fixtures.");
}

async function pricesCommand(options) {
  const catalog = await loadPricingCatalog(options["price-catalog"] ?? "bundled", process.cwd());
  console.log(`Price catalog ${catalog.updated_at} · ${catalog.currency}`);
  for (const [model, rate] of Object.entries(catalog.models)) {
    console.log(`${model.padEnd(30)} input $${rate.input_per_million}/M · cached $${rate.cached_input_per_million ?? "n/a"}/M · output $${rate.output_per_million}/M`);
  }
  console.log(catalog.disclaimer);
}

export function buildPlan(config) {
  const random = createPrng(config.seed ?? 1);
  const blocks = [];
  for (const runner of config.runners) {
    for (const testCase of config.cases) {
      for (let repeat = 1; repeat <= config.repeats; repeat += 1) {
        blocks.push(shuffle(config.conditions ?? CONDITIONS, random).map(
          (condition) => ({ runner, testCase, condition, repeat }),
        ));
      }
    }
  }
  return shuffle(blocks, random).flat();
}

async function mapConcurrent(items, concurrency, worker) {
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, items.length));
  const results = new Array(items.length);
  let next = 0;
  async function consume() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: limit }, consume));
  return results;
}

function sanitizeRunners(runners) {
  return runners.map((runner) => ({
    id: runner.id,
    adapter: runner.adapter,
    preset: runner.preset ?? null,
    provider: runner.provider,
    requested_model: runner.model,
    model: runner.model,
    reasoning_effort: runner.reasoning_effort ?? null,
    parser: runner.parser ?? null,
    skill_install: runner.skill_install ?? null,
    inherit_auth: runner.inherit_auth ?? false,
    sandbox: runner.sandbox ?? null,
    allow_unsandboxed: runner.allow_unsandboxed ?? false,
    max_turns: runner.max_turns ?? null,
    max_budget_usd: runner.max_budget_usd ?? null,
    timeout_ms: runner.timeout_ms ?? null,
    billing_route: runner.billing_route ?? "unknown",
    command: runner.command ? basename(runner.command) : null,
    custom_arguments_count: runner.args?.length ?? 0,
    custom_arguments_sha256: runner.args?.length ? sha256(runner.args) : null,
    environment_variable_names: Object.keys(runner.env ?? {}).sort()
  }));
}

function sanitizeCase(testCase) {
  return {
    id: testCase.id,
    title: testCase.title ?? testCase.id,
    applicability: testCase.applicability,
    prompt: testCase.prompt,
    fixture_sha256: null,
    rubric: testCase.rubric ?? [],
    assertions: (testCase.assertions ?? []).map((assertion) => ({
      id: assertion.id,
      points: assertion.points,
      critical: Boolean(assertion.critical)
    }))
  };
}

function buildLimitations(config, runs) {
  const limitations = [...(config.benchmark.limitations ?? [])];
  const positives = config.cases.filter((testCase) => testCase.applicability === "positive").length;
  const negatives = config.cases.filter((testCase) => testCase.applicability === "negative").length;
  if (config.repeats < 3) limitations.push("Fewer than three repeats were run per condition, so stochastic variance is weakly estimated.");
  if (positives < 20 || negatives < 20) {
    limitations.push(`The corpus contains ${positives} positive and ${negatives} negative case(s); broad release claims should use a larger frozen holdout.`);
  }
  if (!config.judges?.length) limitations.push("No independent judge was configured; quality dimensions outside deterministic assertions remain unmeasured.");
  if (config.runners.some((runner) => runner.adapter === "fixture")) {
    limitations.push("Fixture runners are synthetic test doubles and cannot support claims about a real agent or model.");
  }
  if (runs.some((run) => !run.activation.instrumented && run.condition === "skill_available_auto")) {
    limitations.push("Automatic activation was not instrumented for every run, so activation precision and recall may be inconclusive.");
  }
  if (runs.some((run) => run.costs.observed_usd === null && run.costs.estimated_api_equivalent_usd !== null)) {
    limitations.push("API-equivalent costs are estimates from a pinned catalog, not subscription charges or provider invoices.");
  }
  limitations.push("SkillProof supervises processes but is not itself a security sandbox; hostile code requires an outer container or virtual machine.");
  limitations.push("Results apply only to the recorded skill, corpus, runners, models, settings, and environment.");
  return [...new Set(limitations)];
}

function buildBadge(report) {
  const color = report.summary.verdict.status === "passed"
    ? "1f7a4d"
    : report.summary.verdict.status === "failed" ? "b42318" : "8a5d00";
  const modelCount = Object.keys(report.summary.runners).length;
  return {
    schemaVersion: 1,
    label: "SkillProof",
    message: `${report.benchmark.mode} / ${report.summary.verdict.status} / ${modelCount} model${modelCount === 1 ? "" : "s"}`,
    color,
    cacheSeconds: 300,
    namedLogo: "checkmarx"
  };
}

async function runnerVersionProvenance(runners) {
  const versions = {};
  for (const runner of runners) {
    if (runner.adapter !== "command" || !runner.preset || !runner.command) {
      versions[runner.id] = runner.adapter === "fixture" ? "fixture adapter" : null;
      continue;
    }
    try {
      const result = await executeCommand(runner.command, ["--version"], {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 10000
      });
      versions[runner.id] = result.exitCode === 0
        ? (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || null
        : null;
    } catch {
      versions[runner.id] = null;
    }
  }
  return versions;
}

async function gitProvenance(directory) {
  try {
    const commit = await executeCommand("git", ["rev-parse", "HEAD"], {
      cwd: directory,
      env: process.env,
      timeoutMs: 10000
    });
    const status = await executeCommand("git", ["status", "--porcelain"], {
      cwd: directory,
      env: process.env,
      timeoutMs: 10000
    });
    return {
      commit: commit.exitCode === 0 ? commit.stdout.trim() : null,
      dirty: status.exitCode === 0 ? Boolean(status.stdout.trim()) : null
    };
  } catch {
    return { commit: null, dirty: null };
  }
}

function skillName(file) {
  return file.match(/^---[\s\S]*?^name:\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]?.trim() ?? "unknown-skill";
}

async function packageVersion() {
  return JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version;
}

function parseArguments(args) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [rawKey, inlineValue] = value.slice(2).split("=", 2);
    if (["allow-exec", "force"].includes(rawKey)) {
      options[rawKey] = true;
    } else {
      const next = inlineValue ?? args[index + 1];
      if (next === undefined || (inlineValue === undefined && next.startsWith("--"))) {
        throw new Error(`--${rawKey} requires a value`);
      }
      options[rawKey] = next;
      if (inlineValue === undefined) index += 1;
    }
  }
  return { options, positionals };
}

function printHelp() {
  console.log(`SkillProof — prove an Agent Skill works before you publish it.

Usage:
  skillproof init [skill-path] [--config skillproof.config.json]
  skillproof validate [config]
  skillproof test [skill-path] [--config file] [--output dir] [--allow-exec]
  skillproof report results.json [--output report.html]
  skillproof doctor
  skillproof prices [--price-catalog file]

The test command isolates baseline, automatic availability, and forced-use runs.
Command runners and assertions require --allow-exec after you review the config.`);
}

async function printVersion() {
  console.log(await packageVersion());
}
