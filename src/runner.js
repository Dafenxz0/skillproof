import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { estimateCost, normalizeUsage } from "./pricing.js";
import { finiteNumber, id, pathExists, sha256, writeJson } from "./utils.js";

const OUTPUT_LIMIT = 16 * 1024 * 1024;
const DEFAULT_ARTIFACT_MAX_FILES = 10_000;
const DEFAULT_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;

export async function executeRun(context) {
  const tempRoot = await mkdtemp(join(tmpdir(), "skillproof-"));
  try {
    return await executeRunInTemp(context, tempRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function executeRunInTemp(context, tempRoot) {
  const {
    runner,
    testCase,
    condition,
    repeat,
    configDir,
    skillPath,
    outputDir,
    pricingCatalog,
    allowExec
  } = context;
  const runId = id("artifact");
  const workspace = join(tempRoot, "workspace");
  const agentHome = join(tempRoot, "agent-home");
  const fixturePath = resolve(configDir, testCase.fixture);
  await mkdir(workspace, { recursive: true });
  await mkdir(agentHome, { recursive: true });
  await cp(fixturePath, workspace, { recursive: true, force: true });
  await prepareRunnerCredentials(runner, agentHome);
  const skillName = await readSkillName(skillPath);
  const installation = await installSkill({
    runner,
    condition,
    skillPath,
    skillName,
    workspace,
    agentHome
  });
  const prompt = condition === "skill_forced"
    ? `${testCase.prompt}\n\nHarness instruction: use $${skillName}.`
    : testCase.prompt;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let generation;
  try {
    generation = runner.adapter === "fixture"
      ? await runFixtureAdapter({ runner, testCase, condition, workspace })
      : await runCommandAdapter({
        runner,
        prompt,
        workspace,
        agentHome,
        skillPath,
        skillName,
        condition,
        runId,
        allowExec
      });
  } catch (error) {
    generation = {
      status: "infrastructure_error",
      exit_code: null,
      stdout: "",
      stderr: error.message,
      telemetry: {}
    };
  }
  const durationMs = performance.now() - started;
  await removeWorkspaceSkillInstallation(installation, workspace);
  const artifactDir = join(outputDir, "artifacts", runId);
  const artifactMetrics = await copyArtifact(workspace, artifactDir, {
    maxFiles: runner.artifact_max_files ?? DEFAULT_ARTIFACT_MAX_FILES,
    maxBytes: runner.artifact_max_bytes ?? DEFAULT_ARTIFACT_MAX_BYTES
  });
  const artifactHash = await hashTree(artifactDir);
  const verificationWorkspace = join(tempRoot, "verification");
  await cp(artifactDir, verificationWorkspace, { recursive: true, force: true });
  const assertions = generation.status !== "infrastructure_error"
    ? await runAssertions(testCase.assertions ?? [], {
      workspace: verificationWorkspace,
      testCase,
      condition,
      runId,
      configDir,
      allowExec
    })
    : [];
  const evidenceDir = join(outputDir, "runs", runId);
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, "provider.raw.log"), generation.stdout ?? "", "utf8");
  await writeFile(join(evidenceDir, "provider.stderr.log"), generation.stderr ?? "", "utf8");
  const pricingKey = `${runner.provider}/${runner.model}`;
  const usage = normalizeUsage(
    generation.telemetry?.usage,
    pricingCatalog.models[pricingKey]?.input_token_semantics ?? null,
  );
  let costs = estimateCost({
    provider: runner.provider,
    model: runner.model,
    usage,
    observedCost: generation.telemetry?.observed_cost_usd,
    billingRoute: runner.billing_route ?? "unknown",
    pricingRoute: runner.pricing_route,
    asOf: startedAt
  }, pricingCatalog);
  const observedModels = generation.telemetry?.observed_models ?? [];
  const requestedModelObserved = observedModels.length
    ? observedModels.some((model) => modelMatches(runner.model, model))
    : null;
  if (observedModels.length > 1 || requestedModelObserved === false) {
    costs = {
      ...costs,
      estimated_api_equivalent_usd: null,
      known_subtotal_usd: null,
      completeness: costs.completeness === "unavailable" ? "unavailable" : "partial",
      warning: [
        costs.warning,
        observedModels.length > 1
          ? "Run used multiple observed models; a single requested-model rate would be misleading"
          : `Observed model ${observedModels[0]} did not match requested model ${runner.model}`
      ].filter(Boolean).join("; ")
    };
  }
  const assertionScore = scoreAssertions(assertions);
  if (generation.status === "candidate_error" && assertionScore.percent === null) {
    assertionScore.percent = 0;
  }
  const result = {
    id: runId,
    runner_id: runner.id,
    provider: runner.provider,
    model: runner.model,
    case_id: testCase.id,
    case_title: testCase.title ?? testCase.id,
    applicability: testCase.applicability,
    condition,
    repeat,
    status: generation.status,
    started_at: startedAt,
    duration_ms: durationMs,
    generation: {
      exit_code: generation.exit_code,
      stderr: truncate(generation.stderr),
      stdout_sha256: sha256(generation.stdout ?? ""),
      first_output_ms: generation.first_output_ms ?? null,
      stdout_truncated: generation.stdout_truncated ?? false,
      stderr_truncated: generation.stderr_truncated ?? false,
      observed_models: observedModels,
      requested_model_observed: requestedModelObserved,
      protocol_complete: generation.telemetry?.protocol_complete ?? null,
      terminal_error: generation.telemetry?.terminal_error ?? null,
      raw_stdout_path: `runs/${runId}/provider.raw.log`,
      raw_stderr_path: `runs/${runId}/provider.stderr.log`
    },
    activation: normalizeActivation(
      generation.telemetry?.activation,
      generation.telemetry?.activation_source,
      installation,
    ),
    usage,
    costs,
    assertions,
    score: {
      deterministic_earned: assertionScore.earned,
      deterministic_maximum: assertionScore.maximum,
      deterministic_percent: assertionScore.percent,
      judgment_percent: null,
      quality_percent: assertionScore.percent
    },
    artifact: {
      path: artifactDir,
      sha256: artifactHash,
      blinded_label: id("candidate"),
      file_count: artifactMetrics.file_count,
      total_bytes: artifactMetrics.total_bytes,
      limits: artifactMetrics.limits
    }
  };
  await writeJson(join(evidenceDir, "run.json"), result);
  return result;
}

async function prepareRunnerCredentials(runner, agentHome) {
  if (runner.preset !== "codex" || runner.inherit_auth !== true) return;
  const sourceHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const source = join(sourceHome, "auth.json");
  if (!await pathExists(source)) return;
  await cp(source, join(agentHome, "auth.json"), { force: true });
}

async function removeWorkspaceSkillInstallation(installation, workspace) {
  if (!installation.installed_path) return;
  const location = resolve(installation.installed_path);
  const workspaceRoot = resolve(workspace);
  const inside = relative(workspaceRoot, location);
  if (inside.startsWith("..") || isAbsolute(inside)) return;
  await rm(location, { recursive: true, force: true });
  for (const directory of [...(installation.created_parent_dirs ?? [])].reverse()) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error;
    }
  }
}

async function readSkillName(skillPath) {
  const file = await readFile(join(skillPath, "SKILL.md"), "utf8");
  const match = file.match(/^---[\s\S]*?^name:\s*["']?([^"'\r\n]+)["']?\s*$/m);
  if (!match) throw new Error(`SKILL.md at ${skillPath} has no frontmatter name`);
  const name = match[1].trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Unsafe or invalid skill name: ${name}`);
  }
  return name;
}

export async function installSkill({
  runner,
  condition,
  skillPath,
  skillName,
  workspace,
  agentHome
}) {
  if (condition === "without_skill") {
    return { catalog_exposed: false, install_kind: "none" };
  }
  const kind = runner.skill_install ?? "environment";
  let destination = null;
  const aliases = [];
  if (kind === "codex-home") {
    destination = safeJoin(agentHome, "skills", skillName);
    aliases.push(safeJoin(agentHome, "skills", ".system", skillName));
  } else if (kind === "claude-workspace") {
    destination = safeJoin(workspace, ".claude", "skills", skillName);
  } else if (kind.startsWith("workspace:")) {
    destination = safeJoin(workspace, kind.slice("workspace:".length), skillName);
  }
  const createdParentDirs = destination && isInside(workspace, destination)
    ? await missingParentDirectories(workspace, dirname(destination))
    : [];
  if (destination) {
    await mkdir(dirname(destination), { recursive: true });
    await cp(skillPath, destination, { recursive: true, force: true });
  }
  for (const alias of aliases) {
    await mkdir(dirname(alias), { recursive: true });
    await cp(skillPath, alias, { recursive: true, force: true });
  }
  return {
    catalog_exposed: true,
    install_kind: kind,
    installed_path: destination,
    created_parent_dirs: createdParentDirs,
    alias_paths: aliases
  };
}

function safeJoin(root, ...parts) {
  const base = resolve(root);
  const destination = resolve(base, ...parts);
  const inside = relative(base, destination);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`Path escapes isolated root: ${destination}`);
  }
  return destination;
}

function isInside(root, path) {
  const inside = relative(resolve(root), resolve(path));
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

async function missingParentDirectories(root, parent) {
  const base = resolve(root);
  const path = resolve(parent);
  if (!isInside(base, path)) throw new Error(`Path escapes isolated root: ${path}`);
  const missing = [];
  let cursor = base;
  for (const part of relative(base, path).split(/[\\/]+/).filter(Boolean)) {
    cursor = join(cursor, part);
    if (!await pathExists(cursor)) missing.push(cursor);
  }
  return missing;
}

async function runFixtureAdapter({ runner, testCase, condition, workspace }) {
  const outcome = testCase.fixture_outcomes?.[runner.id]?.[condition]
    ?? testCase.fixture_outcomes?.[condition];
  if (!outcome) {
    throw new Error(`Fixture case ${testCase.id} has no outcome for ${runner.id}/${condition}`);
  }
  for (const [relativePath, content] of Object.entries(outcome.files ?? {})) {
    const destination = resolve(workspace, relativePath);
    const relativeDestination = relative(resolve(workspace), destination);
    if (relativeDestination.startsWith("..") || isAbsolute(relativeDestination)) {
      throw new Error(`Fixture output escapes workspace: ${relativePath}`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, String(content), "utf8");
  }
  return {
    status: outcome.status ?? "completed",
    exit_code: outcome.exit_code ?? 0,
    stdout: JSON.stringify(outcome),
    stderr: "",
    telemetry: {
      usage: outcome.usage,
      observed_cost_usd: outcome.observed_cost_usd,
      activation: outcome.activation,
      activation_source: "fixture"
    }
  };
}

async function runCommandAdapter(options) {
  if (!options.allowExec) {
    throw new Error("Command runners require --allow-exec because generated code is untrusted");
  }
  const replacements = {
    prompt: options.prompt,
    workspace: options.workspace,
    agent_home: options.agentHome
  };
  const invocation = await buildInvocation(options, replacements);
  const args = invocation.args.map((value) => replacePlaceholders(value, replacements));
  const command = replacePlaceholders(options.runner.command, replacements);
  const environment = {
    ...process.env,
    ...(options.runner.env ?? {}),
    ...(options.runner.preset === "codex" ? { CODEX_HOME: options.agentHome } : {}),
    ...(options.runner.preset === "claude"
      ? { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" }
      : {})
  };
  const processResult = await executeCommand(command, args, {
    cwd: options.workspace,
    env: environment,
    timeoutMs: options.runner.timeout_ms ?? 900000,
    stdin: invocation.stdin
  });
  const parsed = parseTelemetry(
    processResult.stdout,
    invocation.parser,
    options.runner.preset ?? "generic",
  );
  const processStatus = classifyProcessStatus(processResult);
  const status = processStatus === "completed"
    && ["codex", "claude"].includes(options.runner.preset)
    && !parsed.protocol_complete
    ? "infrastructure_error"
    : processStatus === "completed" && parsed.terminal_error
      ? isInfrastructureError(parsed.terminal_error)
        ? "infrastructure_error"
        : "candidate_error"
      : processStatus;
  return {
    status,
    exit_code: processResult.exitCode,
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    first_output_ms: processResult.firstStdoutByteMs,
    stdout_truncated: processResult.stdoutTruncated,
    stderr_truncated: processResult.stderrTruncated,
    telemetry: parsed
  };
}

function classifyProcessStatus(result) {
  if (result.timedOut) return "infrastructure_error";
  if (result.exitCode === 0) return "completed";
  return isInfrastructureError(`${result.stderr}\n${result.stdout}`)
    ? "infrastructure_error"
    : "candidate_error";
}

export function isInfrastructureError(value) {
  return /(authentication|unauthorized|not logged in|please log in|usage limit|quota exceeded|insufficient credits|rate limit|command not found|enoent|unknown option|unknown argument|invalid config)/i
    .test(String(value));
}

export async function buildInvocation(options, replacements) {
  if (options.runner.preset === "codex") {
    const sandbox = options.runner.sandbox ?? "workspace-write";
    if (sandbox === "danger-full-access" && options.runner.allow_unsandboxed !== true) {
      throw new Error("danger-full-access requires runner.allow_unsandboxed=true");
    }
    const finalPath = join(options.agentHome, "final.txt");
    await mkdir(dirname(finalPath), { recursive: true });
    return {
      args: [
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox", sandbox,
        "-C", options.workspace,
        "--skip-git-repo-check",
        "-c", "approval_policy=never",
        "-o", finalPath,
        "--model", options.runner.model,
        ...(options.runner.reasoning_effort
          ? ["-c", `model_reasoning_effort=${JSON.stringify(String(options.runner.reasoning_effort))}`]
          : []),
        "-"
      ],
      stdin: options.prompt,
      parser: "jsonl"
    };
  }
  if (options.runner.preset === "claude") {
    if (process.platform === "win32") {
      throw new Error("Claude sandboxing is not supported on native Windows; run the Claude preset inside WSL2 or a container");
    }
    const settingsPath = join(options.agentHome, "claude-settings.json");
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        network: { allowedDomains: [] },
        credentials: {
          envVars: [
            { name: "GITHUB_TOKEN", mode: "deny" },
            { name: "NPM_TOKEN", mode: "deny" }
          ]
        }
      }
    }, null, 2)}\n`, "utf8");
    return {
      args: [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--permission-mode", "acceptEdits",
        "--settings", settingsPath,
        "--setting-sources", "project",
        "--strict-mcp-config",
        "--max-turns", String(options.runner.max_turns ?? 12),
        ...(options.runner.max_budget_usd
          ? ["--max-budget-usd", String(options.runner.max_budget_usd)]
          : []),
        "--model", options.runner.model
      ],
      stdin: options.prompt,
      parser: "jsonl"
    };
  }
  return {
    args: options.runner.args ?? [],
    stdin: options.runner.stdin === "prompt" ? options.prompt : null,
    parser: options.runner.parser ?? "jsonl"
  };
}

export async function runAssertions(assertions, context) {
  const results = [];
  for (const assertion of assertions) {
    if (!context.allowExec) {
      results.push({
        id: assertion.id,
        points: Number(assertion.points),
        critical: Boolean(assertion.critical),
        status: "not_run",
        duration_ms: 0,
        exit_code: null,
        stderr: "Assertions require --allow-exec"
      });
      continue;
    }
    const replacements = {
      workspace: context.workspace,
      case_id: context.testCase.id,
      run_id: context.runId,
      config_dir: context.configDir
    };
    const started = performance.now();
    try {
      const output = await executeCommand(
        replacePlaceholders(assertion.command, replacements),
        (assertion.args ?? []).map((value) => replacePlaceholders(value, replacements)),
        {
        cwd: assertion.cwd
          ? resolve(context.configDir, replacePlaceholders(assertion.cwd, replacements))
          : context.configDir,
        env: {
          ...process.env,
          SKILLPROOF_WORKSPACE: context.workspace,
          SKILLPROOF_CONFIG_DIR: context.configDir,
          SKILLPROOF_CASE_ID: context.testCase.id,
          SKILLPROOF_RUN_ID: context.runId
          },
          timeoutMs: assertion.timeout_ms ?? 120000
        },
      );
      results.push({
        id: assertion.id,
        points: Number(assertion.points),
        critical: Boolean(assertion.critical),
        status: output.timedOut ? "error" : output.exitCode === 0 ? "passed" : "failed",
        duration_ms: performance.now() - started,
        exit_code: output.exitCode,
        stdout: truncate(output.stdout, 16000),
        stderr: truncate(output.stderr, 16000)
      });
    } catch (error) {
      results.push({
        id: assertion.id,
        points: Number(assertion.points),
        critical: Boolean(assertion.critical),
        status: "error",
        duration_ms: performance.now() - started,
        exit_code: null,
        stdout: "",
        stderr: error.message
      });
    }
  }
  return results;
}

export async function executeCommand(command, args, options) {
  const executable = await resolveExecutable(command, args);
  return new Promise((resolvePromise, reject) => {
    const processStarted = performance.now();
    const child = spawn(executable.command, executable.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: [options.stdin === undefined || options.stdin === null ? "ignore" : "pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let firstStdoutByteMs = null;
    let settled = false;
    let timer;
    let forceTimer;
    const append = (target, chunk, markTruncated) => {
      const value = target + chunk.toString();
      if (value.length <= OUTPUT_LIMIT) return value;
      markTruncated();
      return value.slice(-OUTPUT_LIMIT);
    };
    child.stdout.on("data", (chunk) => {
      if (firstStdoutByteMs === null) firstStdoutByteMs = performance.now() - processStarted;
      stdout = append(stdout, chunk, () => { stdoutTruncated = true; });
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk, () => { stderrTruncated = true; });
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      reject(error);
    });
    if (child.stdin) {
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE" && !settled) {
          settled = true;
          clearTimeout(timer);
          clearTimeout(forceTimer);
          reject(error);
        }
      });
      child.stdin.end(options.stdin);
    }
    timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid, false);
      forceTimer = setTimeout(
        () => terminateProcessTree(child.pid, true),
        options.killGraceMs ?? 2000,
      );
      forceTimer.unref();
    }, options.timeoutMs);
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolvePromise({
        exitCode,
        stdout,
        stderr,
        timedOut,
        firstStdoutByteMs,
        stdoutTruncated,
        stderrTruncated
      });
    });
  });
}

async function resolveExecutable(command, args) {
  if (process.platform !== "win32") return { command, args };
  const normalized = command.toLowerCase();
  if (["npm", "npm.cmd", "npx", "npx.cmd"].includes(normalized)) {
    const executableName = normalized.startsWith("npx") ? "npx-cli.js" : "npm-cli.js";
    const candidates = [
      process.env.npm_execpath && normalized.startsWith("npm")
        ? process.env.npm_execpath
        : null,
      join(dirname(process.execPath), "node_modules", "npm", "bin", executableName)
    ].filter(Boolean);
    const cli = await firstExisting(candidates);
    if (!cli) {
      throw new Error(`Could not resolve ${command} without a command shell on Windows`);
    }
    return { command: process.execPath, args: [cli, ...args] };
  }
  if (/\.(cmd|bat)$/i.test(command)) {
    throw new Error(`Windows batch commands are not executed directly: ${command}. Use a native executable or Node script.`);
  }
  return { command, args };
}

async function firstExisting(paths) {
  for (const path of paths) {
    if (await pathExists(path)) return path;
  }
  return null;
}

function terminateProcessTree(pid, force) {
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn(
      "taskkill",
      ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
      { windowsHide: true, stdio: "ignore", shell: false },
    );
    killer.on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The process may have exited between the timeout and tree termination.
  }
}

function replacePlaceholders(value, replacements) {
  return String(value).replace(/\{([a-z_]+)\}/g, (match, key) => (
    Object.hasOwn(replacements, key) ? String(replacements[key]) : match
  ));
}

export function parseTelemetry(stdout, parser, preset = "generic") {
  if (!stdout.trim() || parser === "none") {
    return { usage: {}, observed_cost_usd: null, observed_models: [], protocol_complete: false };
  }
  let objects = [];
  if (parser === "json") {
    try {
      objects = [JSON.parse(stdout)];
    } catch {
      return { usage: {}, observed_cost_usd: null, observed_models: [], protocol_complete: false };
    }
  } else {
    objects = stdout.split(/\r?\n/)
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }
  if (preset === "codex") {
    const terminal = objects.findLast((object) => (
      object?.type === "turn.completed" || object?.type === "turn.failed"
    ));
    return {
      usage: terminal?.usage ?? {},
      observed_cost_usd: null,
      observed_models: [],
      protocol_complete: Boolean(terminal),
      terminal_error: terminal?.type === "turn.failed"
        ? describeTerminalError(terminal, "Codex turn failed")
        : null
    };
  }
  if (preset === "claude") {
    const terminal = objects.findLast((object) => object?.type === "result");
    const modelUsage = terminal?.modelUsage ?? terminal?.model_usage;
    return {
      usage: modelUsage && typeof modelUsage === "object"
        ? aggregateModelUsage(modelUsage)
        : terminal?.usage ?? {},
      observed_cost_usd: finiteNumber(
        terminal?.total_cost_usd ?? terminal?.totalCostUsd,
      ),
      observed_models: modelUsage && typeof modelUsage === "object"
        ? Object.keys(modelUsage)
        : [],
      protocol_complete: Boolean(terminal),
      terminal_error: terminal && (
        terminal.is_error === true
        || String(terminal.subtype ?? "").startsWith("error_")
      )
        ? describeTerminalError(terminal, `Claude result ${terminal.subtype ?? "failed"}`)
        : null
    };
  }
  const terminal = objects.findLast((object) => findUsage(object) !== null);
  return {
    usage: findUsage(terminal) ?? {},
    observed_cost_usd: findNumberByKeys(terminal, ["total_cost_usd", "observed_cost_usd"]),
    observed_models: [],
    protocol_complete: Boolean(terminal),
    terminal_error: null
  };
}

function describeTerminalError(terminal, fallback) {
  const value = terminal?.error?.message
    ?? terminal?.error
    ?? terminal?.result
    ?? terminal?.message;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") return JSON.stringify(value);
  return fallback;
}

function aggregateModelUsage(modelUsage) {
  const totals = {};
  for (const usage of Object.values(modelUsage)) {
    if (!usage || typeof usage !== "object") continue;
    addMeter(totals, "input_tokens", usage.input_tokens ?? usage.inputTokens);
    addMeter(totals, "output_tokens", usage.output_tokens ?? usage.outputTokens);
    addMeter(
      totals,
      "cache_read_input_tokens",
      usage.cache_read_input_tokens ?? usage.cacheReadInputTokens,
    );
    addMeter(
      totals,
      "cache_creation_input_tokens",
      usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens,
    );
  }
  return totals;
}

function addMeter(totals, key, value) {
  const number = finiteNumber(value);
  if (number === null) return;
  totals[key] = (totals[key] ?? 0) + number;
}

function findUsage(value) {
  if (!value || typeof value !== "object") return null;
  if (
    "input_tokens" in value
    || "inputTokens" in value
    || "output_tokens" in value
    || "outputTokens" in value
  ) {
    return value;
  }
  for (const nested of Object.values(value)) {
    const match = findUsage(nested);
    if (match) return match;
  }
  return null;
}

function findNumberByKeys(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    const match = finiteNumber(value[key]);
    if (match !== null) return match;
  }
  for (const nested of Object.values(value)) {
    const match = findNumberByKeys(nested, keys);
    if (match !== null) return match;
  }
  return null;
}

function normalizeActivation(activation, activationSource, installation) {
  const event = activation && typeof activation === "object" ? activation : {};
  const trusted = activationSource === "fixture" || activationSource === "native";
  const resourceLoaded = trusted
    ? booleanOrNull(event.skill_resource_loaded ?? event.resource_loaded)
    : null;
  return {
    catalog_exposed: Boolean(installation.catalog_exposed),
    skill_selected: trusted ? booleanOrNull(event.skill_selected ?? event.selected) : null,
    skill_resource_loaded: resourceLoaded,
    skill_asset_used: trusted ? booleanOrNull(event.skill_asset_used ?? event.asset_used) : null,
    activation_timestamp: trusted ? event.activation_timestamp ?? null : null,
    activation_failure: trusted ? event.activation_failure ?? null : null,
    source: trusted ? activationSource : null,
    instrumented: trusted && resourceLoaded !== null
  };
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function scoreAssertions(assertions) {
  const scored = assertions.filter((assertion) => Number.isFinite(assertion.points));
  const maximum = scored.reduce((sum, assertion) => sum + assertion.points, 0);
  const earned = scored
    .filter((assertion) => assertion.status === "passed")
    .reduce((sum, assertion) => sum + assertion.points, 0);
  return {
    earned,
    maximum,
    percent: maximum ? (earned / maximum) * 100 : null
  };
}

async function copyArtifact(workspace, destination, limits) {
  const maxFiles = artifactLimit(limits.maxFiles, "artifact_max_files");
  const maxBytes = artifactLimit(limits.maxBytes, "artifact_max_bytes");
  const metrics = await measureArtifact(workspace, { maxFiles, maxBytes });
  try {
    await mkdir(destination, { recursive: true });
    await cp(workspace, destination, {
      recursive: true,
      force: true,
      filter: (source) => !excludedArtifactName(basename(source))
    });
    return {
      ...metrics,
      limits: { max_files: maxFiles, max_bytes: maxBytes }
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

function artifactLimit(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return number;
}

function excludedArtifactName(name) {
  return ["node_modules", ".git", ".skillproof"].includes(name);
}

async function measureArtifact(root, limits) {
  let fileCount = 0;
  let totalBytes = 0;
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (excludedArtifactName(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed in generated artifacts: ${child}`);
      }
      if (entry.isDirectory()) {
        await visit(child);
        continue;
      }
      if (!entry.isFile()) continue;
      fileCount += 1;
      totalBytes += (await stat(child)).size;
      if (fileCount > limits.maxFiles) {
        throw new Error(`Artifact exceeds file limit (${fileCount} > ${limits.maxFiles})`);
      }
      if (totalBytes > limits.maxBytes) {
        throw new Error(`Artifact exceeds byte limit (${totalBytes} > ${limits.maxBytes})`);
      }
    }
  }
  await visit(root);
  return { file_count: fileCount, total_bytes: totalBytes };
}

export async function hashTree(root) {
  const entries = [];
  async function visit(path, relative = "") {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const childRelative = join(relative, entry.name).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await visit(child, childRelative);
      } else if (entry.isFile()) {
        const info = await stat(child);
        entries.push(`${childRelative}\0${info.size}\0${sha256(await readFile(child))}`);
      } else if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed in benchmark inputs: ${child}`);
      }
    }
  }
  await visit(root);
  return sha256(entries.sort().join("\n"));
}

function truncate(value, limit = 4000) {
  if (!value) return "";
  return value.length <= limit ? value : `${value.slice(0, limit)}\n…truncated`;
}

function modelMatches(requested, observed) {
  const expected = String(requested).toLowerCase();
  const actual = String(observed).toLowerCase();
  return actual === expected
    || actual.startsWith(`${expected}-`)
    || expected.startsWith(`${actual}-`);
}
