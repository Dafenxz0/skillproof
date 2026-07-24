import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const workspace = process.env.SKILLPROOF_WORKSPACE;
const criterion = process.argv[2];
const text = await readFile(join(workspace, "draft.md"), "utf8");
const normalized = text.toLowerCase();
const words = text.trim().split(/\s+/).filter(Boolean);

if (criterion === "scope") {
  assert.match(normalized, /development/);
  assert.match(normalized, /gpt[- ]?5\.6[- ]?terra/);
  assert.match(normalized, /(this|the|small|public).{0,40}(corpus|benchmark|run)|limited/);
} else if (criterion === "quality") {
  assert.match(normalized, /18/);
  assert.match(normalized, /(quality|calidad).{0,30}(point|punto)|18.{0,30}(point|punto)/);
} else if (criterion === "activation") {
  assert.match(normalized, /(activation|activaci[oó]n)/);
  assert.match(normalized, /(inconclusive|not instrumented|uninstrumented|no (native )?telemetry|sin telemetr[ií]a|no se puede)/);
} else if (criterion === "efficiency") {
  assert.match(normalized, /72/);
  assert.match(normalized, /(token|tokens)/);
  assert.match(normalized, /(fail|exceed|breach|over|supera|incumple|rebasa)/);
} else if (criterion === "decision") {
  assert.ok(words.length <= 180, `expected at most 180 words, received ${words.length}`);
  assert.match(normalized, /(do not|don't|should not|cannot|no |not ready|no publicar|no debe|no est[aá] listo).{0,45}(publish|badge|publicar|insignia)|failed|fallido/);
  assert.doesNotMatch(normalized, /proven to improve every|demostrado que mejora (todas|cualquier)/);
} else {
  throw new Error(`Unknown criterion: ${criterion}`);
}
