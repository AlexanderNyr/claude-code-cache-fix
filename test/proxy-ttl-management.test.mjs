import { test } from "node:test";
import assert from "node:assert/strict";
import ext, { detectRequestType, injectTtl } from "../proxy/extensions/ttl-management.mjs";

// --- Unit tests ---

test("detectRequestType: detects subagent by Agent SDK prefix", () => {
  const system = [{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK. More text here." }];
  assert.equal(detectRequestType(system), "subagent");
});

test("detectRequestType: detects main thread", () => {
  const system = [{ type: "text", text: "You are Claude Code, Anthropic's CLI" }];
  assert.equal(detectRequestType(system), "main");
});

test("detectRequestType: returns main for empty system", () => {
  assert.equal(detectRequestType([]), "main");
  assert.equal(detectRequestType(null), "main");
});

test("injectTtl: adds ttl to existing ephemeral cache_control", () => {
  const block = { type: "text", text: "content", cache_control: { type: "ephemeral" } };
  const result = injectTtl(block, "1h");
  assert.deepEqual(result.cache_control, { type: "ephemeral", ttl: "1h" });
});

test("injectTtl: does not modify block without cache_control", () => {
  const block = { type: "text", text: "content" };
  const result = injectTtl(block, "1h");
  assert.equal(result, block);
});

test("injectTtl: does not overwrite existing ttl", () => {
  const block = { type: "text", text: "content", cache_control: { type: "ephemeral", ttl: "5m" } };
  const result = injectTtl(block, "1h");
  assert.equal(result, block);
});

// --- Integration test: onRequest ---

test("onRequest: injects TTL on system blocks with existing cache_control", async () => {
  const ctx = {
    body: {
      system: [
        { type: "text", text: "System prompt", cache_control: { type: "ephemeral" } },
      ],
      messages: [],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.deepEqual(ctx.body.system[0].cache_control, { type: "ephemeral", ttl: "1h" });
});

test("onRequest: no-op on system blocks without cache_control", async () => {
  const ctx = {
    body: {
      system: [{ type: "text", text: "No markers here" }],
      messages: [],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.equal(ctx.body.system[0].cache_control, undefined);
});
