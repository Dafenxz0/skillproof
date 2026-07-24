import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeRun, isInfrastructureError, parseTelemetry } from "../src/runner.js";

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
