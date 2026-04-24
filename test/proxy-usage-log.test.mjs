import { test } from "node:test";
import assert from "node:assert/strict";
import ext, { buildRecord } from "../proxy/extensions/usage-log.mjs";

// --- Unit tests ---

test("buildRecord: produces complete record with all fields", () => {
  const meta = {
    cacheStats: { inputTokens: 5, outputTokens: 100, cacheRead: 300000, cacheCreation: 500 },
    _quotaData: {
      five_hour: { pct: 25 },
      seven_day: { pct: 5 },
    },
  };
  const telemetry = { model: "claude-opus-4-7" };

  const record = buildRecord(meta, telemetry, {});

  assert.equal(record.model, "claude-opus-4-7");
  assert.equal(record.input_tokens, 5);
  assert.equal(record.output_tokens, 100);
  assert.equal(record.cache_read_input_tokens, 300000);
  assert.equal(record.cache_creation_input_tokens, 500);
  assert.equal(record.q5h_pct, 25);
  assert.equal(record.q7d_pct, 5);
  assert.equal(typeof record.timestamp, "string");
  assert.equal(typeof record.peak_hour, "boolean");
});

test("buildRecord: handles missing cache stats", () => {
  const record = buildRecord({}, {}, {});
  assert.equal(record.input_tokens, 0);
  assert.equal(record.output_tokens, 0);
  assert.equal(record.cache_read_input_tokens, 0);
  assert.equal(record.model, "unknown");
  assert.equal(record.q5h_pct, null);
});

test("buildRecord: handles missing quota data", () => {
  const meta = {
    cacheStats: { cacheRead: 100 },
  };
  const record = buildRecord(meta, { model: "test" }, {});
  assert.equal(record.q5h_pct, null);
  assert.equal(record.q7d_pct, null);
});

// --- onStreamEvent ---

test("onStreamEvent: triggers on message_delta with usage", async () => {
  const ctx = {
    event: { type: "message_delta", usage: { output_tokens: 50 } },
    telemetry: { model: "claude-opus-4-7" },
    meta: {
      cacheStats: { inputTokens: 1, outputTokens: 50, cacheRead: 200000, cacheCreation: 300 },
      _quotaData: { five_hour: { pct: 10 }, seven_day: { pct: 3 } },
    },
    responseHeaders: {},
  };

  // Extension writes to file — just verify it doesn't throw
  await ext.onStreamEvent(ctx);
});

test("onStreamEvent: skips non-message_delta events", async () => {
  const ctx = {
    event: { type: "message_start", message: {} },
    telemetry: {},
    meta: {},
  };

  await ext.onStreamEvent(ctx);
  // No error = pass
});

test("onStreamEvent: skips message_delta without usage", async () => {
  const ctx = {
    event: { type: "message_delta" },
    telemetry: {},
    meta: {},
  };

  await ext.onStreamEvent(ctx);
});

test("onStreamEvent: skips null event", async () => {
  const ctx = { event: null, telemetry: {}, meta: {} };
  await ext.onStreamEvent(ctx);
});
