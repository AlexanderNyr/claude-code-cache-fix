import { test } from "node:test";
import assert from "node:assert/strict";
import ext, { MODEL_REGEX, resolveMode, shouldInject } from "../proxy/extensions/thinking-display.mjs";

// ─── resolveMode ───────────────────────────────────────────────────────────

test("resolveMode: returns env value when set to summarized", () => {
  const saved = process.env.CACHE_FIX_THINKING_DISPLAY;
  process.env.CACHE_FIX_THINKING_DISPLAY = "summarized";
  try {
    assert.equal(resolveMode(), "summarized");
  } finally {
    if (saved === undefined) delete process.env.CACHE_FIX_THINKING_DISPLAY;
    else process.env.CACHE_FIX_THINKING_DISPLAY = saved;
  }
});

test("resolveMode: returns env value when set to omitted", () => {
  const saved = process.env.CACHE_FIX_THINKING_DISPLAY;
  process.env.CACHE_FIX_THINKING_DISPLAY = "omitted";
  try {
    assert.equal(resolveMode(), "omitted");
  } finally {
    if (saved === undefined) delete process.env.CACHE_FIX_THINKING_DISPLAY;
    else process.env.CACHE_FIX_THINKING_DISPLAY = saved;
  }
});

test("resolveMode: returns disabled built-in default when env unset", () => {
  const saved = process.env.CACHE_FIX_THINKING_DISPLAY;
  delete process.env.CACHE_FIX_THINKING_DISPLAY;
  try {
    assert.equal(resolveMode(), "disabled");
  } finally {
    if (saved !== undefined) process.env.CACHE_FIX_THINKING_DISPLAY = saved;
  }
});

test("resolveMode: rejects unrecognized env values, falls back to disabled", () => {
  const saved = process.env.CACHE_FIX_THINKING_DISPLAY;
  process.env.CACHE_FIX_THINKING_DISPLAY = "garbage";
  try {
    assert.equal(resolveMode(), "disabled");
  } finally {
    if (saved === undefined) delete process.env.CACHE_FIX_THINKING_DISPLAY;
    else process.env.CACHE_FIX_THINKING_DISPLAY = saved;
  }
});

// ─── MODEL_REGEX ───────────────────────────────────────────────────────────

test("MODEL_REGEX: matches base Opus 4.7", () => {
  assert.ok(MODEL_REGEX.test("claude-opus-4-7"));
});

test("MODEL_REGEX: matches Opus 4.7 1M-context variant", () => {
  assert.ok(MODEL_REGEX.test("claude-opus-4-7-1m"));
});

test("MODEL_REGEX: does NOT match Opus 4.6", () => {
  assert.ok(!MODEL_REGEX.test("claude-opus-4-6"));
});

test("MODEL_REGEX: does NOT match Sonnet 4.7 (unverified — opt-in via future bump)", () => {
  // Until Sonnet 4.7's `display` default behavior is verified separately, the
  // regex stays Opus-only. Broadening to Sonnet requires a deliberate change
  // to MODEL_REGEX backed by a verification session.
  assert.ok(!MODEL_REGEX.test("claude-sonnet-4-7"));
});

test("MODEL_REGEX: does NOT match future Opus 4.8 (forces a cache-fix bump per principle)", () => {
  // Future versions require an explicit cache-fix bump to add — preferring
  // "miss the fix on a new model and require a bump" over "auto-apply
  // unverified behavior."
  assert.ok(!MODEL_REGEX.test("claude-opus-4-8"));
});

// ─── shouldInject ─────────────────────────────────────────────────────────

test("shouldInject: true for Opus 4.7 with thinking enabled and display unset", () => {
  const body = {
    model: "claude-opus-4-7",
    thinking: { type: "enabled", budget_tokens: 10000 },
  };
  assert.equal(shouldInject(body), true);
});

test("shouldInject: false when display is already set to summarized", () => {
  const body = {
    model: "claude-opus-4-7",
    thinking: { type: "enabled", budget_tokens: 10000, display: "summarized" },
  };
  assert.equal(shouldInject(body), false);
});

test("shouldInject: false when display is explicitly omitted by user (preserves opt-out)", () => {
  // Pinned regression: silent overwrite of an explicit user opt-out would be
  // compliance-affecting. Extension must NEVER overwrite display="omitted".
  const body = {
    model: "claude-opus-4-7",
    thinking: { type: "enabled", budget_tokens: 10000, display: "omitted" },
  };
  assert.equal(shouldInject(body), false);
});

test("shouldInject: false when thinking is not enabled", () => {
  const body = {
    model: "claude-opus-4-7",
    thinking: { type: "disabled" },
  };
  assert.equal(shouldInject(body), false);
});

test("shouldInject: false when thinking block is absent", () => {
  const body = { model: "claude-opus-4-7" };
  assert.equal(shouldInject(body), false);
});

test("shouldInject: false on non-Opus-4.7 models", () => {
  const body = {
    model: "claude-opus-4-6",
    thinking: { type: "enabled", budget_tokens: 10000 },
  };
  assert.equal(shouldInject(body), false);
});

test("shouldInject: false on Sonnet 4.7 (out of scope until verified)", () => {
  const body = {
    model: "claude-sonnet-4-7",
    thinking: { type: "enabled", budget_tokens: 10000 },
  };
  assert.equal(shouldInject(body), false);
});

test("shouldInject: handles missing model field gracefully", () => {
  const body = { thinking: { type: "enabled" } };
  assert.equal(shouldInject(body), false);
});

test("shouldInject: handles null/undefined body gracefully", () => {
  assert.equal(shouldInject(null), false);
  assert.equal(shouldInject(undefined), false);
});

// ─── onRequest (integration with mode + body together) ────────────────────

async function runOnRequest(mode, body) {
  const saved = process.env.CACHE_FIX_THINKING_DISPLAY;
  process.env.CACHE_FIX_THINKING_DISPLAY = mode;
  const ctx = { body, meta: {}, headers: {} };
  try {
    await ext.onRequest(ctx);
  } finally {
    if (saved === undefined) delete process.env.CACHE_FIX_THINKING_DISPLAY;
    else process.env.CACHE_FIX_THINKING_DISPLAY = saved;
  }
  return ctx;
}

test("onRequest: summarized mode injects display=summarized on Opus 4.7 unset", async () => {
  const body = {
    model: "claude-opus-4-7",
    thinking: { type: "enabled", budget_tokens: 10000 },
  };
  const ctx = await runOnRequest("summarized", body);
  assert.equal(ctx.body.thinking.display, "summarized");
  assert.equal(ctx.meta.thinkingDisplayInjected, "summarized");
});

test("onRequest: omitted mode injects display=omitted on Opus 4.7 unset", async () => {
  // Force-suppress override use case — agent runtimes that don't want thinking
  // blocks at all, regardless of CLI behavior.
  const body = {
    model: "claude-opus-4-7",
    thinking: { type: "enabled", budget_tokens: 10000 },
  };
  const ctx = await runOnRequest("omitted", body);
  assert.equal(ctx.body.thinking.display, "omitted");
  assert.equal(ctx.meta.thinkingDisplayInjected, "omitted");
});

test("onRequest: disabled mode is a no-op", async () => {
  const body = {
    model: "claude-opus-4-7",
    thinking: { type: "enabled", budget_tokens: 10000 },
  };
  const ctx = await runOnRequest("disabled", body);
  assert.equal(ctx.body.thinking.display, undefined);
  assert.equal(ctx.meta.thinkingDisplayInjected, undefined);
});

test("onRequest: does not overwrite user-explicit display=omitted (pinned)", async () => {
  // Same property as the shouldInject test above, but at the extension entry
  // point: even with mode=summarized, an explicit user opt-out is preserved.
  const body = {
    model: "claude-opus-4-7",
    thinking: { type: "enabled", budget_tokens: 10000, display: "omitted" },
  };
  const ctx = await runOnRequest("summarized", body);
  assert.equal(ctx.body.thinking.display, "omitted");
  assert.equal(ctx.meta.thinkingDisplayInjected, undefined);
});

test("onRequest: does not overwrite user-explicit display=summarized", async () => {
  const body = {
    model: "claude-opus-4-7",
    thinking: { type: "enabled", budget_tokens: 10000, display: "summarized" },
  };
  const ctx = await runOnRequest("omitted", body);
  // Even with omitted-mode active, the user's explicit summarized is preserved.
  assert.equal(ctx.body.thinking.display, "summarized");
  assert.equal(ctx.meta.thinkingDisplayInjected, undefined);
});

test("onRequest: skips wrong-model requests (no injection)", async () => {
  const body = {
    model: "claude-opus-4-6",
    thinking: { type: "enabled", budget_tokens: 10000 },
  };
  const ctx = await runOnRequest("summarized", body);
  assert.equal(ctx.body.thinking.display, undefined);
  assert.equal(ctx.meta.thinkingDisplayInjected, undefined);
});

test("onRequest: skips thinking-disabled requests", async () => {
  const body = {
    model: "claude-opus-4-7",
    thinking: { type: "disabled" },
  };
  const ctx = await runOnRequest("summarized", body);
  assert.equal(ctx.body.thinking.display, undefined);
  assert.equal(ctx.meta.thinkingDisplayInjected, undefined);
});

test("onRequest: skips requests with no thinking block", async () => {
  const body = { model: "claude-opus-4-7" };
  const ctx = await runOnRequest("summarized", body);
  // body.thinking is absent, so we can't read body.thinking.display here.
  assert.equal(body.thinking, undefined);
  assert.equal(ctx.meta.thinkingDisplayInjected, undefined);
});

test("onRequest: built-in default (env unset) is no-op", async () => {
  const saved = process.env.CACHE_FIX_THINKING_DISPLAY;
  delete process.env.CACHE_FIX_THINKING_DISPLAY;
  const body = {
    model: "claude-opus-4-7",
    thinking: { type: "enabled", budget_tokens: 10000 },
  };
  const ctx = { body, meta: {}, headers: {} };
  try {
    await ext.onRequest(ctx);
  } finally {
    if (saved !== undefined) process.env.CACHE_FIX_THINKING_DISPLAY = saved;
  }
  assert.equal(ctx.body.thinking.display, undefined);
  assert.equal(ctx.meta.thinkingDisplayInjected, undefined);
});
