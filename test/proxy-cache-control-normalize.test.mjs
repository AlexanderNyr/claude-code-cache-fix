import { test } from "node:test";
import assert from "node:assert/strict";
import ext, {
  stripCacheControlMarkers,
  countUserCacheControlMarkers,
} from "../proxy/extensions/cache-control-normalize.mjs";

// --- Unit tests ---

test("stripCacheControlMarkers: removes cache_control from content blocks", () => {
  const msg = {
    role: "user",
    content: [
      { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
      { type: "text", text: "world" },
    ],
  };
  const removed = stripCacheControlMarkers(msg);
  assert.equal(removed, 1);
  assert.equal(msg.content[0].cache_control, undefined);
});

test("stripCacheControlMarkers: returns 0 for non-user messages", () => {
  const msg = {
    role: "assistant",
    content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
  };
  assert.equal(stripCacheControlMarkers(msg), 0);
});

test("stripCacheControlMarkers: returns 0 for null/undefined", () => {
  assert.equal(stripCacheControlMarkers(null), 0);
  assert.equal(stripCacheControlMarkers(undefined), 0);
});

test("stripCacheControlMarkers: handles non-array content", () => {
  const msg = { role: "user", content: "plain string" };
  assert.equal(stripCacheControlMarkers(msg), 0);
});

test("countUserCacheControlMarkers: counts markers across all user messages", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "a", cache_control: { type: "ephemeral" } },
          { type: "text", text: "b", cache_control: { type: "ephemeral" } },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      {
        role: "user",
        content: [{ type: "text", text: "c", cache_control: { type: "ephemeral" } }],
      },
    ],
  };
  assert.equal(countUserCacheControlMarkers(body), 3);
});

test("countUserCacheControlMarkers: returns 0 when no markers", () => {
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: "no markers" }] },
    ],
  };
  assert.equal(countUserCacheControlMarkers(body), 0);
});

// --- Integration test: onRequest ---

test("onRequest: pins cache_control to last block of last user message", async () => {
  const ctx = {
    body: {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "first", cache_control: { type: "ephemeral" } },
            { type: "text", text: "second" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "third" },
            { type: "text", text: "fourth" },
          ],
        },
      ],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);

  // First user message should have markers stripped
  assert.equal(ctx.body.messages[0].content[0].cache_control, undefined);

  // Last block of last user message should have the marker
  const lastMsg = ctx.body.messages[2];
  const lastBlock = lastMsg.content[lastMsg.content.length - 1];
  assert.deepEqual(lastBlock.cache_control, { type: "ephemeral" });
});

test("onRequest: no-op when already canonical", async () => {
  const ctx = {
    body: {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "only block", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.deepEqual(ctx.body.messages[0].content[0].cache_control, { type: "ephemeral" });
});
