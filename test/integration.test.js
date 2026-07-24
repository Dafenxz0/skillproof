import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const executeFile = promisify(execFile);
const repository = resolve(import.meta.dirname, "..");

test("demo executes a multimodel matrix and writes JSON, HTML, and badge", { timeout: 30000 }, async () => {
  const output = await mkdtemp(join(tmpdir(), "skillproof-integration-"));
  await executeFile(process.execPath, [
    "bin/skillproof.js",
    "test",
    "examples/demo-skill",
    "--config",
    "examples/demo/skillproof.config.json",
    "--output",
    output,
    "--allow-exec"
  ], { cwd: repository });
  const results = JSON.parse(await readFile(join(output, "results.json"), "utf8"));
  const html = await readFile(join(output, "report.html"), "utf8");
  const card = await readFile(join(output, "card.svg"), "utf8");
  const badge = JSON.parse(await readFile(join(output, "badge.json"), "utf8"));
  assert.equal(Object.keys(results.summary.runners).length, 2);
  assert.equal(results.summary.run_counts.planned, 36);
  assert.equal(results.summary.run_counts.completed, 36);
  assert.equal(results.summary.runners["fixture-terra"].activation.recall.value, 1);
  assert.equal(results.summary.runners["fixture-sonnet"].activation.false_activation_rate.value, 0);
  assert.match(html, /This benchmark was generated with SkillProof\./);
  assert.match(html, /Repository evidence card/);
  assert.match(card, /SKILLPROOF \/ EVIDENCE/);
  assert.match(card, /generated from results\.json/);
  assert.equal(badge.schemaVersion, 1);
});

test("init creates a valid runnable fixture and assertion layout", async () => {
  const output = await mkdtemp(join(tmpdir(), "skillproof-init-"));
  const config = join(output, "skillproof.config.json");
  await executeFile(process.execPath, [
    "bin/skillproof.js",
    "init",
    "./skills/example",
    "--config",
    config
  ], { cwd: repository });
  await access(join(output, "fixtures", "positive", "task.txt"));
  await access(join(output, "fixtures", "negative", "task.txt"));
  await access(join(output, "assertions", "positive.mjs"));
  await access(join(output, "assertions", "negative.mjs"));
  const value = JSON.parse(await readFile(config, "utf8"));
  assert.deepEqual(value.claims, {
    quality: true,
    activation: false,
    efficiency: true
  });
});
