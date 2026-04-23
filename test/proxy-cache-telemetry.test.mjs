import { test } from "node:test";
import assert from "node:assert/strict";
import ext from "../proxy/extensions/cache-telemetry.mjs";

// --- Integration tests: onResponseStart ---

test("onResponseStart: parses quota headers into meta", async () => {
  const ctx = {
    headers: {
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-5h-reset": "1776960600",
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-7d-utilization": "0.15",
      "anthropic-ratelimit-unified-7d-reset": "1776970800",
      "anthropic-ratelimit-unified-7d-status": "allowed",
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-overage-status": "allowed",
      "anthropic-ratelimit-unified-overage-utilization": "0.0",
    },
    meta: {},
  };

  await ext.onResponseStart(ctx);

  assert.ok(ctx.meta._quotaData, "should set _quotaData in meta");
  assert.equal(ctx.meta._quotaData.five_hour.pct, 42);
  assert.equal(ctx.meta._quotaData.seven_day.pct, 15);
  assert.equal(ctx.meta._quotaData.status, "allowed");
});

test("onResponseStart: handles missing headers gracefully", async () => {
  const ctx = { headers: {}, meta: {} };
  await ext.onResponseStart(ctx);
  assert.equal(ctx.meta._quotaData, undefined);
});

test("onResponseStart: handles null headers", async () => {
  const ctx = { headers: null, meta: {} };
  await ext.onResponseStart(ctx);
  assert.equal(ctx.meta._quotaData, undefined);
});

test("onResponseStart: detects peak hours", async () => {
  const ctx = {
    headers: {
      "anthropic-ratelimit-unified-5h-utilization": "0.1",
      "anthropic-ratelimit-unified-5h-reset": "1776960600",
      "anthropic-ratelimit-unified-7d-utilization": "0.05",
      "anthropic-ratelimit-unified-7d-reset": "1776970800",
    },
    meta: {},
  };

  await ext.onResponseStart(ctx);
  assert.equal(typeof ctx.meta._quotaData.peak_hour, "boolean");
});

// --- Integration tests: onStreamEvent ---

test("onStreamEvent: captures cache stats from message_start", async () => {
  const ctx = {
    event: {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 5,
          cache_read_input_tokens: 300000,
          cache_creation_input_tokens: 500,
        },
      },
    },
    telemetry: {},
    meta: {},
  };

  await ext.onStreamEvent(ctx);

  assert.equal(ctx.meta.cacheStats.cacheRead, 300000);
  assert.equal(ctx.meta.cacheStats.cacheCreation, 500);
  assert.equal(ctx.meta.cacheStats.inputTokens, 5);
});

test("onStreamEvent: captures output tokens from message_delta", async () => {
  const ctx = {
    event: {
      type: "message_delta",
      usage: { output_tokens: 150 },
    },
    telemetry: {},
    meta: {
      cacheStats: { cacheRead: 300000, cacheCreation: 500, inputTokens: 5 },
    },
  };

  await ext.onStreamEvent(ctx);
  assert.equal(ctx.meta.cacheStats.outputTokens, 150);
});

test("onStreamEvent: skips when no event", async () => {
  const ctx = { event: null, telemetry: {}, meta: {} };
  await ext.onStreamEvent(ctx);
  assert.equal(ctx.meta.cacheStats, undefined);
});
