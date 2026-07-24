export function mean(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("values must be a non-empty array");
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
