import { dirname, resolve } from "node:path";
import { readJson, invariant, CONDITIONS } from "./utils.js";
import { resolveProfile } from "./profiles.js";

export function resolveClaims(config) {
  return {
    quality: config.claims?.quality ?? true,
    activation: config.claims?.activation ?? config.benchmark?.mode === "release",
    efficiency: config.claims?.efficiency ?? true
  };
}

export async function loadConfig(configPath) {
  const absolutePath = resolve(configPath);
  const config = await readJson(absolutePath);
  const errors = validateConfig(config);
  if (errors.length) {
    throw new Error(`Invalid config:\n- ${errors.join("\n- ")}`);
  }
  return {
    config,
    configPath: absolutePath,
    configDir: dirname(absolutePath),
    profile: resolveProfile(config.profile)
  };
}

export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object") return ["root must be an object"];
  if (config.version !== 1) errors.push("version must be 1");
  if (!config.benchmark?.id) errors.push("benchmark.id is required");
  if (!["development", "release"].includes(config.benchmark?.mode)) {
    errors.push("benchmark.mode must be development or release");
  }
  const claims = resolveClaims(config);
  if (config.claims !== undefined
    && (!config.claims || typeof config.claims !== "object" || Array.isArray(config.claims))) {
    errors.push("claims must be an object");
  }
  for (const key of Object.keys(config.claims ?? {})) {
    if (!["quality", "activation", "efficiency"].includes(key)) {
      errors.push(`unknown claim: ${key}`);
    } else if (typeof config.claims[key] !== "boolean") {
      errors.push(`claims.${key} must be boolean`);
    }
  }
  if (!Object.values(claims).some(Boolean)) errors.push("at least one claim must be enabled");
  const profile = resolveProfile(config.profile);
  if (!profile) errors.push("profile must be a built-in id or extend a built-in profile");
  if (!Array.isArray(config.runners) || !config.runners.length) errors.push("runners must contain at least one runner");
  if (!Array.isArray(config.cases) || !config.cases.length) errors.push("cases must contain at least one case");
  if (!Number.isInteger(config.repeats) || config.repeats < 1) errors.push("repeats must be a positive integer");
  const runnerIds = new Set();
  for (const runner of config.runners ?? []) {
    if (!runner.id) errors.push("every runner needs an id");
    if (runnerIds.has(runner.id)) errors.push(`duplicate runner id: ${runner.id}`);
    runnerIds.add(runner.id);
    if (!["command", "fixture"].includes(runner.adapter)) {
      errors.push(`runner ${runner.id ?? "?"} adapter must be command or fixture`);
    }
    if (runner.adapter === "command" && !runner.command) errors.push(`runner ${runner.id} needs command`);
    if (runner.preset && !["codex", "claude"].includes(runner.preset)) {
      errors.push(`runner ${runner.id} preset must be codex or claude`);
    }
    if (runner.adapter === "command" && !runner.skill_install) {
      errors.push(`runner ${runner.id} needs an explicit skill_install strategy`);
    }
    if (runner.skill_install
      && !["codex-home", "claude-workspace"].includes(runner.skill_install)
      && !runner.skill_install.startsWith("workspace:")) {
      errors.push(`runner ${runner.id} has an unsupported skill_install strategy`);
    }
    if (!runner.provider) errors.push(`runner ${runner.id ?? "?"} needs provider`);
    if (!runner.model) errors.push(`runner ${runner.id ?? "?"} needs model`);
    if (runner.reasoning_effort !== undefined
      && !["none", "low", "medium", "high", "xhigh", "max", "ultra"].includes(runner.reasoning_effort)) {
      errors.push(`runner ${runner.id ?? "?"} has an unsupported reasoning_effort`);
    }
    if (runner.inherit_auth !== undefined && typeof runner.inherit_auth !== "boolean") {
      errors.push(`runner ${runner.id ?? "?"} inherit_auth must be boolean`);
    }
    if (runner.sandbox !== undefined
      && !["read-only", "workspace-write", "danger-full-access"].includes(runner.sandbox)) {
      errors.push(`runner ${runner.id ?? "?"} has an unsupported sandbox`);
    }
    if (runner.sandbox === "danger-full-access" && runner.allow_unsandboxed !== true) {
      errors.push(`runner ${runner.id ?? "?"} danger-full-access requires allow_unsandboxed=true`);
    }
    validateEnvironmentOptions(runner, `runner ${runner.id ?? "?"}`, errors);
  }
  const caseIds = new Set();
  for (const testCase of config.cases ?? []) {
    if (!testCase.id) errors.push("every case needs an id");
    if (caseIds.has(testCase.id)) errors.push(`duplicate case id: ${testCase.id}`);
    caseIds.add(testCase.id);
    if (!testCase.prompt) errors.push(`case ${testCase.id ?? "?"} needs prompt`);
    if (!["positive", "negative", "ambiguous"].includes(testCase.applicability)) {
      errors.push(`case ${testCase.id ?? "?"} applicability must be positive, negative, or ambiguous`);
    }
    if (!testCase.fixture) errors.push(`case ${testCase.id ?? "?"} needs fixture`);
    for (const assertion of testCase.assertions ?? []) {
      if (!assertion.id || !assertion.command) {
        errors.push(`case ${testCase.id ?? "?"} assertions need id and command`);
      }
      if (!(Number(assertion.points) > 0)) {
        errors.push(`case ${testCase.id ?? "?"} assertion ${assertion.id ?? "?"} points must be positive`);
      }
      validateEnvironmentOptions(
        assertion,
        `assertion ${testCase.id ?? "?"}/${assertion.id ?? "?"}`,
        errors,
      );
    }
  }
  const conditions = config.conditions ?? CONDITIONS;
  for (const condition of conditions) {
    if (!CONDITIONS.includes(condition)) errors.push(`unknown condition: ${condition}`);
  }
  if (conditions.length !== CONDITIONS.length
    || new Set(conditions).size !== CONDITIONS.length
    || CONDITIONS.some((condition) => !conditions.includes(condition))) {
    errors.push(`conditions must contain each required arm exactly once: ${CONDITIONS.join(", ")}`);
  }
  if (config.judges && !Array.isArray(config.judges)) errors.push("judges must be an array");
  const judgeIds = new Set();
  for (const judge of config.judges ?? []) {
    if (!judge.id) errors.push("every judge needs an id");
    if (judgeIds.has(judge.id)) errors.push(`duplicate judge id: ${judge.id}`);
    judgeIds.add(judge.id);
    if (!["command", "fixture"].includes(judge.adapter)) {
      errors.push(`judge ${judge.id ?? "?"} adapter must be command or fixture`);
    }
    if (judge.adapter === "command" && !judge.command) errors.push(`judge ${judge.id} needs command`);
    validateEnvironmentOptions(judge, `judge ${judge.id ?? "?"}`, errors);
  }
  if (config.benchmark?.mode === "release") {
    const positives = (config.cases ?? []).filter((item) => item.applicability === "positive").length;
    const negatives = (config.cases ?? []).filter((item) => item.applicability === "negative").length;
    if (config.repeats < 3) errors.push("release benchmarks require at least three repeats");
    if (positives < 20 || negatives < 20) {
      errors.push("release benchmarks require at least 20 positive and 20 negative cases");
    }
    if ((config.runners ?? []).some((runner) => runner.adapter === "fixture")) {
      errors.push("release benchmarks cannot use fixture runners");
    }
    if (claims.quality && profile?.require_judgment && (config.judges ?? []).length < 2) {
      errors.push(`release profile ${profile.id} requires at least two independent judges`);
    }
    if (claims.quality && profile?.require_deterministic) {
      for (const testCase of config.cases ?? []) {
        if (!(testCase.assertions?.length > 0)) {
          errors.push(`release case ${testCase.id} needs deterministic assertions`);
        }
        for (const assertion of testCase.assertions ?? []) {
          if (assertion.trusted !== true) {
            errors.push(`release assertion ${testCase.id}/${assertion.id} must set trusted=true`);
          }
          if (String(assertion.cwd ?? "").includes("{workspace}")) {
            errors.push(`release assertion ${testCase.id}/${assertion.id} cannot execute from the candidate workspace`);
          }
        }
      }
    }
    if (claims.quality && !Number.isFinite(config.gates?.minimum_quality_ci_lower)) {
      errors.push("release quality claims need a minimum_quality_ci_lower gate");
    }
    if (claims.activation && (
      !Number.isFinite(config.gates?.minimum_activation_recall)
      || !Number.isFinite(config.gates?.minimum_activation_precision)
    )) {
      errors.push("release benchmarks need minimum_activation_recall and minimum_activation_precision gates");
    }
  }
  return errors;
}

export function resolveConfigPaths(loaded, skillArgument) {
  const { config, configDir } = loaded;
  invariant(skillArgument || config.skill?.path, "A skill path is required");
  return {
    skillPath: skillArgument ? resolve(skillArgument) : resolve(configDir, config.skill.path),
    outputDir: resolve(configDir, config.output ?? ".skillproof/results"),
    configDir
  };
}

export function createStarterConfig(skillPath) {
  return {
    version: 1,
    benchmark: {
      id: "my-skill-evaluation",
      title: "My skill evaluation",
      description: "A paired benchmark of baseline, automatic activation, and forced use.",
      mode: "development"
    },
    skill: {
      path: skillPath.replaceAll("\\", "/")
    },
    claims: {
      quality: true,
      activation: false,
      efficiency: true
    },
    profile: "technical",
    conditions: ["without_skill", "skill_available_auto", "skill_forced"],
    repeats: 3,
    seed: 20260724,
    runners: [
      {
        id: "codex-terra",
        adapter: "command",
        preset: "codex",
        provider: "openai",
        model: "gpt-5.6-terra",
        command: "codex",
        parser: "jsonl",
        skill_install: "codex-home",
        reasoning_effort: "medium",
        inherit_auth: false,
        sandbox: "workspace-write",
        billing_route: "chatgpt-subscription",
        timeout_ms: 900000
      }
    ],
    cases: [
      {
        id: "positive-example",
        title: "A task that should use the skill",
        applicability: "positive",
        prompt: "Create answer.txt containing exactly: skillproof-positive",
        fixture: "./fixtures/positive",
        assertions: [
          {
            id: "behavior",
            command: "node",
            args: ["./assertions/positive.mjs"],
            points: 100,
            critical: true
          }
        ]
      },
      {
        id: "hard-negative-example",
        title: "An adjacent task that should not use the skill",
        applicability: "negative",
        prompt: "Create answer.txt containing exactly: skillproof-negative",
        fixture: "./fixtures/negative",
        assertions: [
          {
            id: "scope",
            command: "node",
            args: ["./assertions/negative.mjs"],
            points: 100,
            critical: true
          }
        ]
      }
    ],
    judges: [],
    pricing: {
      catalog: "bundled"
    },
    gates: {
      minimum_quality_delta: 0,
      minimum_quality_ci_lower: 0,
      maximum_regressions: 0,
      minimum_activation_recall: 0.8,
      minimum_activation_precision: 0.8,
      maximum_false_activation_rate: 0.1,
      maximum_token_increase_percent: 25,
      maximum_latency_increase_percent: 30
    },
    statistics: {
      bootstrap_samples: 2000,
      confidence: 0.95,
      tie_margin_points: 1
    },
    output: ".skillproof/results"
  };
}

function validateEnvironmentOptions(value, label, errors) {
  if (value.env !== undefined
    && (!value.env || typeof value.env !== "object" || Array.isArray(value.env))) {
    errors.push(`${label} env must be an object`);
  }
  for (const [key, item] of Object.entries(value.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string") {
      errors.push(`${label} env must contain valid names with string values`);
      break;
    }
  }
  if (value.env_passthrough !== undefined && !Array.isArray(value.env_passthrough)) {
    errors.push(`${label} env_passthrough must be an array`);
    return;
  }
  for (const key of value.env_passthrough ?? []) {
    if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push(`${label} env_passthrough must contain valid environment variable names`);
      break;
    }
  }
}
