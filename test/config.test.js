import test from "node:test";
import assert from "node:assert/strict";
import { createStarterConfig, validateConfig } from "../src/config.js";

test("starter config defines the three causal conditions", () => {
  const config = createStarterConfig("./skills/example");
  assert.deepEqual(config.conditions, [
    "without_skill",
    "skill_available_auto",
    "skill_forced"
  ]);
  assert.deepEqual(validateConfig(config), []);
});

test("config rejects duplicate identities and unknown applicability", () => {
  const config = createStarterConfig("./skills/example");
  config.runners.push({ ...config.runners[0] });
  config.cases[0].applicability = "maybe";
  const errors = validateConfig(config);
  assert.ok(errors.some((error) => error.includes("duplicate runner id")));
  assert.ok(errors.some((error) => error.includes("applicability")));
});
