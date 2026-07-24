import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  buildSafeEnvironment,
  buildRunnerEnvironment,
  buildInvocation,
  executeRun,
  installSkill,
  isInfrastructureError,
  parseTelemetry
} from "../src/runner.js";

const pricingCatalog = {
  models: {
    "example/model": {
      input_token_semantics: "inclusive",
      input_per_million: 1,
      output_per_million: 1,
      source: "https://example.test"
    }
  }
};

test("Codex telemetry uses the terminal event and preserves terminal failures", () => {
  const completed = parseTelemetry([
    { type: "item.completed", item: { usage: { input_tokens: 1, output_tokens: 1 } } },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 10,
        reasoning_output_tokens: 3
      }
    }
  ].map(JSON.stringify).join("\n"), "jsonl", "codex");
  assert.deepEqual(completed.usage, {
    input_tokens: 100,
    cached_input_tokens: 20,
    output_tokens: 10,
    reasoning_output_tokens: 3
  });
  assert.equal(completed.protocol_complete, true);
  assert.equal(completed.terminal_error, null);

  const failed = parseTelemetry(JSON.stringify({
    type: "turn.failed",
    error: { message: "model refused the task" }
  }), "jsonl", "codex");
  assert.equal(failed.protocol_complete, true);
  assert.equal(failed.terminal_error, "model refused the task");
});

test("Codex telemetry records an observed model only when the runtime emits one", () => {
  const observed = parseTelemetry(JSON.stringify({
    type: "turn.completed",
    model: "gpt-5.6-terra-2026-07-01",
    usage: { input_tokens: 10, output_tokens: 2 }
  }), "jsonl", "codex");
  assert.deepEqual(observed.observed_models, ["gpt-5.6-terra-2026-07-01"]);

  const requestedOnly = parseTelemetry(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 10, output_tokens: 2 }
  }), "jsonl", "codex");
  assert.deepEqual(requestedOnly.observed_models, []);
});

test("Claude telemetry aggregates terminal modelUsage instead of assistant-step usage", () => {
  const parsed = parseTelemetry([
    {
      type: "assistant",
      message: { usage: { input_tokens: 10, output_tokens: 1 } }
    },
    {
      type: "result",
      usage: { input_tokens: 50, output_tokens: 5 },
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 5
        },
        "claude-haiku-4-5": {
          inputTokens: 30,
          outputTokens: 3,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1
        }
      },
      total_cost_usd: 0.12
    }
  ].map(JSON.stringify).join("\n"), "jsonl", "claude");
  assert.deepEqual(parsed.usage, {
    input_tokens: 130,
    output_tokens: 13,
    cache_read_input_tokens: 22,
    cache_creation_input_tokens: 6
  });
  assert.deepEqual(parsed.observed_models, ["claude-sonnet-5", "claude-haiku-4-5"]);
  assert.equal(parsed.observed_cost_usd, 0.12);
  assert.equal(parsed.protocol_complete, true);
  assert.equal(parsed.terminal_error, null);
});

test("Claude error result remains a completed protocol with a terminal error", () => {
  const parsed = parseTelemetry(JSON.stringify({
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    result: "Maximum turns reached",
    usage: { input_tokens: 10, output_tokens: 1 }
  }), "jsonl", "claude");
  assert.equal(parsed.protocol_complete, true);
  assert.equal(parsed.terminal_error, "Maximum turns reached");
});

test("provider usage limits are classified as infrastructure failures", () => {
  assert.equal(isInfrastructureError("You've hit your usage limit."), true);
  assert.equal(isInfrastructureError("insufficient credits for this request"), true);
  assert.equal(isInfrastructureError("model refused the task"), false);
});

test("untrusted processes receive only allowlisted or explicitly passed environment variables", () => {
  const secretName = "SKILLPROOF_TEST_SECRET";
  const previous = process.env[secretName];
  process.env[secretName] = "do-not-leak";
  try {
    const isolated = buildSafeEnvironment();
    assert.equal(isolated[secretName], undefined);
    const explicit = buildSafeEnvironment({
      passthrough: [secretName],
      overrides: { SKILLPROOF_MARKER: "safe" }
    });
    assert.equal(explicit[secretName], "do-not-leak");
    assert.equal(explicit.SKILLPROOF_MARKER, "safe");
  } finally {
    if (previous === undefined) delete process.env[secretName];
    else process.env[secretName] = previous;
  }
});

test("Claude runs use an isolated home instead of the user profile", () => {
  const agentHome = join("isolated", "agent-home");
  const environment = buildRunnerEnvironment(
    { preset: "claude" },
    agentHome,
  );
  assert.equal(environment.HOME, agentHome);
  assert.equal(environment.USERPROFILE, agentHome);
  assert.equal(environment.CLAUDE_CONFIG_DIR, join(agentHome, ".claude"));
});

test("provider control files stay outside the candidate workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillproof-control-files-"));
  const workspace = join(root, "workspace");
  const agentHome = join(root, "agent-home");
  await mkdir(workspace);
  await mkdir(agentHome);
  try {
    const codex = await buildInvocation({
      runner: { preset: "codex", model: "example" },
      workspace,
      agentHome
    }, {});
    const finalPath = codex.args[codex.args.indexOf("-o") + 1];
    assert.equal(isInside(workspace, finalPath), false);
    assert.equal(isInside(agentHome, finalPath), true);

    const claudeOptions = {
      runner: { preset: "claude", model: "example" },
      workspace,
      agentHome
    };
    if (process.platform === "win32") {
      await assert.rejects(buildInvocation(claudeOptions, {}), /not supported on native Windows/);
    } else {
      const claude = await buildInvocation(claudeOptions, {});
      const settingsPath = claude.args[claude.args.indexOf("--settings") + 1];
      assert.equal(isInside(workspace, settingsPath), false);
      assert.equal(isInside(agentHome, settingsPath), true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex skill installation provides the advertised system alias", async () => {
  const root = await createFixtureRoot();
  const agentHome = join(root.path, "agent-home");
  await mkdir(agentHome);
  try {
    const installation = await installSkill({
      runner: { skill_install: "codex-home" },
      condition: "skill_available_auto",
      skillPath: root.skill,
      skillName: "tested-skill",
      workspace: root.fixture,
      agentHome
    });
    await access(join(agentHome, "skills", "tested-skill", "SKILL.md"));
    await access(join(agentHome, "skills", ".system", "tested-skill", "SKILL.md"));
    assert.deepEqual(installation.alias_paths, [
      join(agentHome, "skills", ".system", "tested-skill")
    ]);
  } finally {
    await rm(root.path, { recursive: true, force: true });
  }
});

test("workspace skill installation restores the fixture directory topology", async (t) => {
  await t.test("preserves a pre-existing .claude directory", async () => {
    const root = await createFixtureRoot();
    try {
      await mkdir(join(root.fixture, ".claude"), { recursive: true });
      await writeFile(join(root.fixture, ".claude", "keep.txt"), "fixture\n");
      const result = await runFixture(root, {});
      await access(join(result.artifact.path, ".claude", "keep.txt"));
      await assert.rejects(access(join(result.artifact.path, ".claude", "skills")), {
        code: "ENOENT"
      });
    } finally {
      await rm(root.path, { recursive: true, force: true });
    }
  });
  await t.test("removes harness-created .claude parents", async () => {
    const root = await createFixtureRoot();
    try {
      const result = await runFixture(root, {});
      await assert.rejects(access(join(result.artifact.path, ".claude")), {
        code: "ENOENT"
      });
    } finally {
      await rm(root.path, { recursive: true, force: true });
    }
  });
});

test("artifact byte and file caps fail closed", async (t) => {
  await t.test("byte cap", async () => {
    const root = await createFixtureRoot();
    try {
      await writeFile(join(root.fixture, "large.txt"), "12345");
      await assert.rejects(runFixture(root, { artifact_max_bytes: 4 }), /byte limit/);
    } finally {
      await rm(root.path, { recursive: true, force: true });
    }
  });
  await t.test("file cap", async () => {
    const root = await createFixtureRoot();
    try {
      await writeFile(join(root.fixture, "one.txt"), "1");
      await writeFile(join(root.fixture, "two.txt"), "2");
      await assert.rejects(runFixture(root, { artifact_max_files: 1 }), /file limit/);
    } finally {
      await rm(root.path, { recursive: true, force: true });
    }
  });
});

async function createFixtureRoot() {
  const path = await mkdtemp(join(tmpdir(), "skillproof-runner-test-"));
  const skill = join(path, "skill");
  const fixture = join(path, "fixture");
  const output = join(path, "output");
  await mkdir(skill);
  await mkdir(fixture);
  await mkdir(output);
  await writeFile(join(skill, "SKILL.md"), "---\nname: tested-skill\n---\n");
  return { path, skill, fixture, output };
}

function runFixture(root, runnerOverrides) {
  return executeRun({
    runner: {
      id: "fixture",
      adapter: "fixture",
      provider: "example",
      model: "model",
      skill_install: "claude-workspace",
      ...runnerOverrides
    },
    testCase: {
      id: "case",
      title: "Case",
      applicability: "positive",
      prompt: "Do the task.",
      fixture: "fixture",
      assertions: [],
      fixture_outcomes: {
        skill_available_auto: {
          files: { "answer.txt": "done\n" },
          usage: { input_tokens: 10, output_tokens: 2 }
        }
      }
    },
    condition: "skill_available_auto",
    repeat: 1,
    configDir: root.path,
    skillPath: root.skill,
    outputDir: root.output,
    pricingCatalog,
    allowExec: false
  });
}

function isInside(root, path) {
  const value = relative(root, path);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}
