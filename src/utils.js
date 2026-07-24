import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const CONDITIONS = ["without_skill", "skill_available_auto", "skill_forced"];

export function sha256(value) {
  const bytes = typeof value === "string" || Buffer.isBuffer(value)
    ? value
    : stableStringify(value);
  return createHash("sha256").update(bytes).digest("hex");
}

export function stableStringify(value, space = 0) {
  return JSON.stringify(sortObject(value), null, space);
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortObject(value[key])]),
  );
}

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read JSON at ${path}: ${error.message}`);
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${stableStringify(value, 2)}\n`, "utf8");
}

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function fromConfig(configDir, path) {
  return resolve(configDir, path);
}

export function finiteNumber(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

export function median(values) {
  return quantile(values, 0.5);
}

export function quantile(values, percentile) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return null;
  const position = (valid.length - 1) * percentile;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return valid[lower + 1] === undefined
    ? valid[lower]
    : valid[lower] + fraction * (valid[lower + 1] - valid[lower]);
}

export function sum(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((total, value) => total + value, 0) : null;
}

export function percentDelta(current, baseline) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) return null;
  return ((current - baseline) / baseline) * 100;
}

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function createPrng(seed) {
  let state = Number.parseInt(sha256(String(seed)).slice(0, 8), 16) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

export function shuffle(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

export function id(prefix = "run") {
  return `${prefix}-${randomUUID()}`;
}

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function relativePathLabel(path) {
  return String(path).replaceAll("\\", "/");
}
