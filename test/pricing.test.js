import test from "node:test";
import assert from "node:assert/strict";
import { estimateCost, loadPricingCatalog, normalizeUsage } from "../src/pricing.js";

const catalog = {
  models: {
    "example/model": {
      input_per_million: 2,
      cached_input_per_million: 0.2,
      cache_write_per_million: 2.5,
      output_per_million: 10,
      source: "https://example.test/pricing"
    }
  }
};

test("cost separates uncached, cache read, cache write, and output meters", () => {
  const result = estimateCost({
    provider: "example",
    model: "model",
    usage: {
      input_tokens: 1_000_000,
      cached_input_tokens: 200_000,
      cache_write_tokens: 100_000,
      output_tokens: 100_000
    },
    observedCost: null
  }, catalog);
  assert.equal(result.estimated_api_equivalent_usd, 2.69);
  assert.equal(result.observed_usd, null);
});

test("missing token telemetry remains unknown rather than zero", () => {
  const result = estimateCost({
    provider: "example",
    model: "model",
    usage: {},
    observedCost: null
  }, catalog);
  assert.equal(result.estimated_api_equivalent_usd, null);
  assert.match(result.warning, /did not report/);
  assert.deepEqual(normalizeUsage({}), {
    input_tokens: null,
    cached_input_tokens: null,
    cache_write_tokens: null,
    cache_write_5m_tokens: null,
    cache_write_1h_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    total_tokens: null,
    input_token_semantics: null
  });
});

test("reasoning output is recorded without being added to billed output", () => {
  const usage = normalizeUsage({
    input_tokens: 50,
    output_tokens: 20,
    reasoning_output_tokens: 10
  });
  assert.equal(usage.output_tokens, 20);
  assert.equal(usage.reasoning_tokens, 10);
});

test("exclusive Anthropic-style meters are not subtracted from base input", () => {
  const exclusiveCatalog = {
    models: {
      "anthropic/test": {
        input_token_semantics: "exclusive",
        input_per_million: 2,
        cached_input_per_million: 0.2,
        cache_write_per_million: 2.5,
        cache_write_1h_per_million: 4,
        output_per_million: 10,
        source: "https://example.test"
      }
    }
  };
  const result = estimateCost({
    provider: "anthropic",
    model: "test",
    usage: {
      input_tokens: 1_000_000,
      cache_read_input_tokens: 200_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 100_000,
        ephemeral_1h_input_tokens: 50_000
      },
      output_tokens: 100_000
    }
  }, exclusiveCatalog);
  assert.equal(result.estimated_api_equivalent_usd, 3.49);
  assert.equal(result.completeness, "complete");
});

test("unknown cache-write TTL produces a partial subtotal instead of a guessed total", () => {
  const exclusiveCatalog = {
    models: {
      "anthropic/test": {
        input_token_semantics: "exclusive",
        input_per_million: 2,
        cached_input_per_million: 0.2,
        cache_write_per_million: 2.5,
        cache_write_1h_per_million: 4,
        output_per_million: 10,
        source: "https://example.test"
      }
    }
  };
  const result = estimateCost({
    provider: "anthropic",
    model: "test",
    usage: {
      input_tokens: 1000,
      cache_creation_input_tokens: 500,
      output_tokens: 100
    }
  }, exclusiveCatalog);
  assert.equal(result.estimated_api_equivalent_usd, null);
  assert.ok(result.known_subtotal_usd > 0);
  assert.equal(result.completeness, "partial");
});

test("missing relevant cache meters produces only a known subtotal", () => {
  const result = estimateCost({
    provider: "example",
    model: "model",
    usage: {
      input_tokens: 1_000_000,
      output_tokens: 100_000
    }
  }, catalog);
  assert.equal(result.estimated_api_equivalent_usd, null);
  assert.equal(result.known_subtotal_usd, 1);
  assert.equal(result.completeness, "partial");
  assert.match(result.warning, /cached_input_tokens/);
  assert.match(result.warning, /cache_write_tokens/);
});

test("versioned rates select an explicit route and pricing date", () => {
  const versioned = {
    models: {
      "anthropic/test": {
        billing_route: "anthropic-api",
        valid_to_exclusive: "2026-09-01",
        input_token_semantics: "exclusive",
        input_per_million: 2,
        cached_input_per_million: 0.2,
        cache_write_per_million: 2.5,
        cache_write_1h_per_million: 4,
        output_per_million: 10,
        source: "https://example.test/promo"
      }
    },
    scheduled_rates: {
      "anthropic/test": [{
        billing_route: "anthropic-api",
        valid_from: "2026-09-01",
        input_token_semantics: "exclusive",
        input_per_million: 3,
        cached_input_per_million: 0.3,
        cache_write_per_million: 3.75,
        cache_write_1h_per_million: 6,
        output_per_million: 15,
        source: "https://example.test/standard"
      }]
    }
  };
  const usage = {
    input_tokens: 1_000_000,
    cached_input_tokens: 0,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    output_tokens: 1_000_000
  };
  const promo = estimateCost({
    provider: "anthropic",
    model: "test",
    usage,
    pricingRoute: "anthropic-api",
    billingRoute: "claude-subscription",
    asOf: "2026-08-31T23:59:59Z"
  }, versioned);
  const standard = estimateCost({
    provider: "anthropic",
    model: "test",
    usage,
    pricingRoute: "anthropic-api",
    billingRoute: "claude-subscription",
    asOf: "2026-09-01T00:00:00Z"
  }, versioned);
  assert.equal(promo.estimated_api_equivalent_usd, 12);
  assert.equal(standard.estimated_api_equivalent_usd, 18);
  assert.equal(standard.pricing_valid_from, "2026-09-01");
  assert.equal(standard.billing_route, "claude-subscription");
  assert.equal(standard.pricing_route, "anthropic-api");

  const unavailable = estimateCost({
    provider: "anthropic",
    model: "test",
    usage,
    pricingRoute: "bedrock",
    asOf: "2026-09-01T00:00:00Z"
  }, versioned);
  assert.equal(unavailable.estimated_api_equivalent_usd, null);
  assert.equal(unavailable.completeness, "unavailable");
  assert.match(unavailable.warning, /pricing route bedrock/);
});

test("bundled GPT-5.4 applies the documented long-context multipliers", async () => {
  const bundled = await loadPricingCatalog("bundled", process.cwd());
  const result = estimateCost({
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input_tokens: 300_000,
      cached_input_tokens: 0,
      output_tokens: 100_000
    },
    pricingRoute: "openai-api",
    asOf: "2026-07-24T00:00:00Z"
  }, bundled);
  assert.equal(result.estimated_api_equivalent_usd, 3.75);
  assert.match(result.warning, /Long-context multipliers/);
});

test("bundled Sonnet 5 switches to standard pricing on September 1", async () => {
  const bundled = await loadPricingCatalog("bundled", process.cwd());
  const result = estimateCost({
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage: {
      input_tokens: 1_000_000,
      cached_input_tokens: 0,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: 0,
      output_tokens: 1_000_000
    },
    pricingRoute: "anthropic-api",
    asOf: "2026-09-01T00:00:00Z"
  }, bundled);
  assert.equal(result.estimated_api_equivalent_usd, 18);
  assert.equal(result.pricing_valid_from, "2026-09-01");
});
