import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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
  const badge = JSON.parse(await readFile(join(output, "badge.json"), "utf8"));
  assert.equal(Object.keys(results.summary.runners).length, 2);
  assert.equal(results.summary.run_counts.planned, 36);
  assert.equal(results.summary.run_counts.completed, 36);
  assert.equal(results.summary.runners["fixture-terra"].activation.recall.value, 1);
  assert.equal(results.summary.runners["fixture-sonnet"].activation.false_activation_rate.value, 0);
  assert.match(html, /This benchmark was generated with SkillProof\./);
  assert.equal(badge.schemaVersion, 1);
});
