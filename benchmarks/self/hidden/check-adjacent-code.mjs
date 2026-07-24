import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const workspace = process.env.SKILLPROOF_WORKSPACE;
const moduleUrl = `${pathToFileURL(join(workspace, "src", "math.js")).href}?run=${Date.now()}`;
const { clamp, sum } = await import(moduleUrl);

assert.equal(sum(2, 3), 5);
assert.equal(clamp(5, 0, 10), 5);
assert.equal(clamp(-2, 0, 10), 0);
assert.equal(clamp(12, 0, 10), 10);
assert.throws(() => clamp(1, 5, 2), RangeError);
