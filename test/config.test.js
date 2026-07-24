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
  assert.deepEqual(config.claims, {
    quality: true,
    activation: false,
    efficiency: true
  });
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

test("config validates claims and explicit environment passthrough", () => {
  const config = createStarterConfig("./skills/example");
  config.claims.activation = "yes";
  config.runners[0].env_passthrough = ["OPENAI_API_KEY", "not-valid!"];
  const errors = validateConfig(config);
  assert.ok(errors.some((error) => error.includes("claims.activation")));
  assert.ok(errors.some((error) => error.includes("env_passthrough")));
});

test("release activation gates are required only when activation is claimed", () => {
  const config = createStarterConfig("./skills/example");
  config.benchmark.mode = "release";
  config.repeats = 3;
  config.cases = [
    ...Array.from({ length: 20 }, (_, index) => ({
      ...config.cases[0],
      id: `positive-${index}`,
      assertions: config.cases[0].assertions.map((item) => ({ ...item, trusted: true }))
    })),
    ...Array.from({ length: 20 }, (_, index) => ({
      ...config.cases[1],
      id: `negative-${index}`,
      assertions: config.cases[1].assertions.map((item) => ({ ...item, trusted: true }))
    }))
  ];
  delete config.gates.minimum_activation_recall;
  delete config.gates.minimum_activation_precision;
  assert.equal(
    validateConfig(config).some((error) => error.includes("minimum_activation")),
    false,
  );
  config.claims.activation = true;
  assert.equal(
    validateConfig(config).some((error) => error.includes("minimum_activation")),
    true,
  );
});
