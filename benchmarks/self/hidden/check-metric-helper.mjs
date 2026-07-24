import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const workspace = process.env.SKILLPROOF_WORKSPACE;
const moduleUrl = `${pathToFileURL(join(workspace, "src", "stats.js")).href}?t=${Date.now()}`;
const { median } = await import(moduleUrl);

assert.equal(median([9]), 9);
assert.equal(median([9, 1, 5]), 5);
assert.equal(median([8, 2, 4, 6]), 5);

const values = [3, 1, 2];
assert.equal(median(values), 2);
assert.deepEqual(values, [3, 1, 2]);

for (const invalid of [null, [], [1, Number.NaN], [1, Number.POSITIVE_INFINITY]]) {
  assert.throws(() => median(invalid));
}
