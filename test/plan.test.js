import test from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "../src/cli.js";

test("buildPlan randomizes complete case-repeat blocks without globally interleaving arms", () => {
  const config = {
    seed: 42,
    conditions: ["without_skill", "skill_available_auto", "skill_forced"],
    runners: [{ id: "runner-a" }, { id: "runner-b" }],
    cases: [{ id: "case-a" }, { id: "case-b" }],
    repeats: 2
  };
  const first = buildPlan(config);
  const second = buildPlan(config);
  assert.deepEqual(
    first.map(({ runner, testCase, condition, repeat }) => [runner.id, testCase.id, condition, repeat]),
    second.map(({ runner, testCase, condition, repeat }) => [runner.id, testCase.id, condition, repeat]),
  );
  for (let index = 0; index < first.length; index += config.conditions.length) {
    const block = first.slice(index, index + config.conditions.length);
    assert.equal(new Set(block.map((item) => item.runner.id)).size, 1);
    assert.equal(new Set(block.map((item) => item.testCase.id)).size, 1);
    assert.equal(new Set(block.map((item) => item.repeat)).size, 1);
    assert.deepEqual(
      block.map((item) => item.condition).sort(),
      [...config.conditions].sort(),
    );
  }
});
