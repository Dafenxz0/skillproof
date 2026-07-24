import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, finiteNumber } from "./utils.js";

const bundledCatalogPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../pricing/catalog.json",
);

export async function loadPricingCatalog(value, configDir) {
  const catalog = await readJson(
    !value || value === "bundled" ? bundledCatalogPath : resolve(configDir, value),
  );
  if (catalog.currency !== "USD") {
    throw new Error(`Unsupported pricing currency: ${catalog.currency ?? "missing"}. SkillProof currently supports USD only.`);
  }
  return catalog;
}

export function normalizeUsage(usage = {}, inputTokenSemantics = null) {
  const cacheDetails = usage.cache_creation ?? usage.cacheCreation ?? {};
  const cacheWrite5m = finiteNumber(
    usage.cache_write_5m_tokens
    ?? cacheDetails.ephemeral_5m_input_tokens,
  );
  const cacheWrite1h = finiteNumber(
    usage.cache_write_1h_tokens
    ?? cacheDetails.ephemeral_1h_input_tokens,
  );
  const reportedCacheWrite = finiteNumber(
    usage.cache_write_tokens
    ?? usage.cacheWriteTokens
    ?? usage.cache_creation_input_tokens
    ?? usage.cacheCreationInputTokens,
  );
  return {
    input_tokens: finiteNumber(usage.input_tokens ?? usage.inputTokens),
    cached_input_tokens: finiteNumber(
      usage.cached_input_tokens
      ?? usage.cachedInputTokens
      ?? usage.cache_read_input_tokens
      ?? usage.cacheReadInputTokens,
    ),
    cache_write_tokens: reportedCacheWrite
      ?? (cacheWrite5m !== null || cacheWrite1h !== null
        ? (cacheWrite5m ?? 0) + (cacheWrite1h ?? 0)
        : null),
    cache_write_5m_tokens: cacheWrite5m,
    cache_write_1h_tokens: cacheWrite1h,
    output_tokens: finiteNumber(usage.output_tokens ?? usage.outputTokens),
    reasoning_tokens: finiteNumber(
      usage.reasoning_tokens
      ?? usage.reasoningTokens
      ?? usage.reasoning_output_tokens,
    ),
    total_tokens: finiteNumber(usage.total_tokens ?? usage.totalTokens),
    input_token_semantics: inputTokenSemantics
  };
}

export function estimateCost({
  provider,
  model,
  usage,
  observedCost,
  billingRoute = "unknown",
  pricingRoute = defaultPricingRoute(provider),
  asOf = null
}, catalog) {
  const key = `${provider}/${model}`;
  const selection = selectRate(catalog, key, { pricingRoute, asOf });
  const rate = selection.rate;
  const normalized = normalizeUsage(usage, rate?.input_token_semantics ?? "inclusive");
  const observed = finiteNumber(observedCost);
  if (!rate) {
    return {
      observed_usd: observed,
      estimated_api_equivalent_usd: null,
      pricing_key: key,
      pricing_source: null,
      billing_route: billingRoute,
      pricing_route: pricingRoute,
      pricing_as_of: asOf,
      pricing_valid_from: null,
      pricing_valid_to_exclusive: null,
      known_subtotal_usd: null,
      completeness: "unavailable",
      warning: selection.warning ?? `No price entry for ${key}`
    };
  }
  const input = normalized.input_tokens;
  const output = normalized.output_tokens;
  if (!Number.isFinite(input) || !Number.isFinite(output)) {
    return {
      observed_usd: observed,
      estimated_api_equivalent_usd: null,
      pricing_key: key,
      pricing_source: rate.source,
      billing_route: billingRoute,
      pricing_route: pricingRoute,
      pricing_as_of: asOf,
      pricing_valid_from: rate.valid_from ?? null,
      pricing_valid_to_exclusive: rate.valid_to_exclusive ?? null,
      known_subtotal_usd: null,
      completeness: "unavailable",
      warning: "Runner did not report enough token data for an API-equivalent estimate"
    };
  }
  const cachedMeterRelevant = Number.isFinite(rate.cached_input_per_million)
    && rate.cached_input_per_million !== rate.input_per_million;
  const writeMeterRelevant = Number.isFinite(rate.cache_write_per_million)
    || Number.isFinite(rate.cache_write_1h_per_million);
  const hasCachedMeter = normalized.cached_input_tokens !== null;
  const hasWriteMeter = normalized.cache_write_tokens !== null
    || normalized.cache_write_5m_tokens !== null
    || normalized.cache_write_1h_tokens !== null;
  const missingMeters = [
    cachedMeterRelevant && !hasCachedMeter ? "cached_input_tokens" : null,
    writeMeterRelevant && !hasWriteMeter ? "cache_write_tokens" : null
  ].filter(Boolean);
  const cached = normalized.cached_input_tokens ?? 0;
  const detailedWrite = (normalized.cache_write_5m_tokens ?? 0)
    + (normalized.cache_write_1h_tokens ?? 0);
  const genericWrite = detailedWrite
    ? Math.max(0, (normalized.cache_write_tokens ?? detailedWrite) - detailedWrite)
    : normalized.cache_write_tokens ?? 0;
  const allWrites = detailedWrite + genericWrite;
  const inconsistentInput = rate.input_token_semantics !== "exclusive"
    && cached + allWrites > input;
  const allocationKnown = !missingMeters.length && !inconsistentInput;
  const uncached = rate.input_token_semantics === "exclusive"
    ? input
    : allocationKnown ? input - cached - allWrites : null;
  const longContext = rate.long_context_threshold
    && input > rate.long_context_threshold;
  const inputMultiplier = longContext ? rate.long_context_input_multiplier ?? 1 : 1;
  const outputMultiplier = longContext ? rate.long_context_output_multiplier ?? 1 : 1;
  const hasAmbiguousWrite = genericWrite > 0 && Number.isFinite(rate.cache_write_1h_per_million);
  const pricedGenericWrite = hasAmbiguousWrite ? 0 : genericWrite;
  const knownInputDollars = rate.input_token_semantics === "exclusive"
    ? input * rate.input_per_million * inputMultiplier
    : Number.isFinite(uncached)
      ? uncached * rate.input_per_million * inputMultiplier
      : 0;
  const knownCachedDollars = hasCachedMeter && !inconsistentInput
    ? cached * (rate.cached_input_per_million ?? rate.input_per_million) * inputMultiplier
    : 0;
  const knownWriteDollars = hasWriteMeter && !inconsistentInput
    ? (
      (normalized.cache_write_5m_tokens ?? 0)
        * (rate.cache_write_per_million ?? rate.input_per_million)
      + (normalized.cache_write_1h_tokens ?? 0)
        * (rate.cache_write_1h_per_million ?? rate.input_per_million)
      + pricedGenericWrite
        * (rate.cache_write_per_million ?? rate.input_per_million)
    ) * inputMultiplier
    : 0;
  const knownDollars = (
    knownInputDollars
    + knownCachedDollars
    + knownWriteDollars
    + output * rate.output_per_million * outputMultiplier
  ) / 1_000_000;
  const warnings = [
    missingMeters.length
      ? `Runner did not report relevant meter(s): ${missingMeters.join(", ")}`
      : null,
    hasAmbiguousWrite ? "Cache-write TTL was not reported, so that meter is omitted from the estimate" : null,
    inconsistentInput ? "Reported cache meters exceed inclusive input tokens" : null,
    longContext ? `Long-context multipliers applied above ${rate.long_context_threshold} input tokens` : null
  ].filter(Boolean);
  const complete = !missingMeters.length && !hasAmbiguousWrite && !inconsistentInput;
  return {
    observed_usd: observed,
    estimated_api_equivalent_usd: complete ? knownDollars : null,
    known_subtotal_usd: knownDollars,
    completeness: complete ? "complete" : "partial",
    pricing_key: key,
    pricing_source: rate.source,
    billing_route: billingRoute,
    pricing_route: pricingRoute,
    pricing_as_of: asOf,
    pricing_valid_from: rate.valid_from ?? null,
    pricing_valid_to_exclusive: rate.valid_to_exclusive ?? null,
    warning: warnings.length ? warnings.join("; ") : null
  };
}

function defaultPricingRoute(provider) {
  if (provider === "openai") return "openai-api";
  if (provider === "anthropic") return "anthropic-api";
  return null;
}

function selectRate(catalog, key, { pricingRoute, asOf }) {
  const primary = catalog.models?.[key];
  const scheduled = catalog.scheduled_rates?.[key] ?? [];
  const candidates = [
    ...(Array.isArray(primary) ? primary : primary ? [primary] : []),
    ...(Array.isArray(scheduled) ? scheduled : [scheduled])
  ].filter(Boolean);
  if (!candidates.length) {
    return { rate: null, warning: `No price entry for ${key}` };
  }
  const routed = candidates.filter((rate) => (
    !rate.billing_route || !pricingRoute || rate.billing_route === pricingRoute
  ));
  if (!routed.length) {
    return {
      rate: null,
      warning: `No price entry for ${key} on pricing route ${pricingRoute}`
    };
  }
  const hasValidityWindow = routed.some((rate) => rate.valid_from || rate.valid_to_exclusive);
  if (hasValidityWindow && !asOf) {
    return {
      rate: null,
      warning: `A pricing date is required for versioned price entry ${key}`
    };
  }
  const instant = asOf ? Date.parse(asOf) : null;
  if (asOf && !Number.isFinite(instant)) {
    return { rate: null, warning: `Invalid pricing date: ${asOf}` };
  }
  const dated = routed.filter((rate) => (
    (!rate.valid_from || instant >= Date.parse(rate.valid_from))
    && (!rate.valid_to_exclusive || instant < Date.parse(rate.valid_to_exclusive))
  ));
  if (!dated.length) {
    return {
      rate: null,
      warning: `No price entry for ${key} on ${asOf}${pricingRoute ? ` via ${pricingRoute}` : ""}`
    };
  }
  dated.sort((left, right) => (
    Date.parse(right.valid_from ?? "1970-01-01")
    - Date.parse(left.valid_from ?? "1970-01-01")
  ));
  return { rate: dated[0], warning: null };
}
