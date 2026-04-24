import { test } from "node:test";
import assert from "node:assert/strict";
import ext, { stripOldToolResultImages, PLACEHOLDER } from "../proxy/extensions/image-strip.mjs";

function userMsg(content) {
  return { role: "user", content };
}

function assistantMsg(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolResultWithImage(toolUseId, base64Data) {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: base64Data } },
      { type: "text", text: "File read successfully" },
    ],
  };
}

function toolResultTextOnly(toolUseId, text) {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [{ type: "text", text }],
  };
}

// --- Unit tests: stripOldToolResultImages ---

test("stripOldToolResultImages: strips images from old user messages", () => {
  const fakeBase64 = "A".repeat(1000);
  const messages = [
    userMsg([toolResultWithImage("t1", fakeBase64), { type: "text", text: "prompt 1" }]),
    assistantMsg("reply 1"),
    userMsg([toolResultWithImage("t2", fakeBase64), { type: "text", text: "prompt 2" }]),
    assistantMsg("reply 2"),
    userMsg([toolResultWithImage("t3", fakeBase64), { type: "text", text: "prompt 3" }]),
  ];

  const { messages: result, stats } = stripOldToolResultImages(messages, 1);

  assert.ok(stats, "should have stripping stats");
  assert.equal(stats.strippedCount, 2, "should strip 2 images from old messages");
  assert.equal(stats.strippedBytes, 2000);

  // First two user messages should have images stripped
  assert.equal(result[0].content[0].content[0].type, "text");
  assert.equal(result[0].content[0].content[0].text, PLACEHOLDER);
  assert.equal(result[2].content[0].content[0].type, "text");
  assert.equal(result[2].content[0].content[0].text, PLACEHOLDER);

  // Last user message should keep its image
  assert.equal(result[4].content[0].content[0].type, "image");
});

test("stripOldToolResultImages: keeps images in recent N messages", () => {
  const fakeBase64 = "B".repeat(500);
  const messages = [
    userMsg([toolResultWithImage("t1", fakeBase64)]),
    assistantMsg("r1"),
    userMsg([toolResultWithImage("t2", fakeBase64)]),
    assistantMsg("r2"),
    userMsg([toolResultWithImage("t3", fakeBase64)]),
    assistantMsg("r3"),
    userMsg([toolResultWithImage("t4", fakeBase64)]),
  ];

  const { messages: result, stats } = stripOldToolResultImages(messages, 3);

  assert.ok(stats);
  assert.equal(stats.strippedCount, 1, "should only strip the oldest");
  assert.equal(result[0].content[0].content[0].text, PLACEHOLDER);
  // Messages 2, 4, 6 (last 3 user messages) should keep images
  assert.equal(result[2].content[0].content[0].type, "image");
  assert.equal(result[4].content[0].content[0].type, "image");
  assert.equal(result[6].content[0].content[0].type, "image");
});

test("stripOldToolResultImages: no-op when keepLast is 0", () => {
  const messages = [userMsg([toolResultWithImage("t1", "data")])];
  const { stats } = stripOldToolResultImages(messages, 0);
  assert.equal(stats, null);
});

test("stripOldToolResultImages: no-op when not enough messages", () => {
  const messages = [
    userMsg([toolResultWithImage("t1", "data")]),
    assistantMsg("reply"),
    userMsg([{ type: "text", text: "hi" }]),
  ];
  const { stats } = stripOldToolResultImages(messages, 3);
  assert.equal(stats, null);
});

test("stripOldToolResultImages: does not strip user-pasted images", () => {
  const messages = [
    userMsg([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "userPasted" } },
      { type: "text", text: "what is this image?" },
    ]),
    assistantMsg("reply"),
    userMsg([{ type: "text", text: "follow up" }]),
    assistantMsg("reply2"),
    userMsg([{ type: "text", text: "another" }]),
  ];

  const { messages: result, stats } = stripOldToolResultImages(messages, 1);
  assert.equal(stats, null, "user-pasted images should not be stripped");
  assert.equal(result[0].content[0].type, "image");
});

test("stripOldToolResultImages: preserves non-image tool_result content", () => {
  const messages = [
    userMsg([
      toolResultWithImage("t1", "imgdata"),
      toolResultTextOnly("t2", "text result"),
    ]),
    assistantMsg("reply"),
    userMsg([{ type: "text", text: "recent" }]),
    assistantMsg("reply2"),
    userMsg([{ type: "text", text: "current" }]),
  ];

  const { messages: result, stats } = stripOldToolResultImages(messages, 1);
  assert.equal(stats.strippedCount, 1);
  // Text-only tool result should be untouched
  assert.equal(result[0].content[1].content[0].text, "text result");
});

test("stripOldToolResultImages: handles null/undefined input", () => {
  assert.deepEqual(stripOldToolResultImages(null, 3), { messages: null, stats: null });
  assert.deepEqual(stripOldToolResultImages(undefined, 3), { messages: undefined, stats: null });
});

// --- Integration tests: onRequest ---

test("onRequest: strips images when CACHE_FIX_IMAGE_KEEP_LAST is set via meta", async () => {
  const fakeBase64 = "C".repeat(800);
  const ctx = {
    body: {
      messages: [
        userMsg([toolResultWithImage("t1", fakeBase64)]),
        assistantMsg("r1"),
        userMsg([toolResultWithImage("t2", fakeBase64)]),
        assistantMsg("r2"),
        userMsg([{ type: "text", text: "current prompt" }]),
      ],
    },
    headers: {},
    meta: { imageKeepLast: 1 },
  };

  await ext.onRequest(ctx);

  assert.ok(ctx.meta.imageStripStats, "should have stats");
  assert.equal(ctx.meta.imageStripStats.strippedCount, 2);
  assert.equal(ctx.body.messages[0].content[0].content[0].text, PLACEHOLDER);
});

test("onRequest: no-op when keepLast is 0 or unset", async () => {
  const ctx = {
    body: {
      messages: [
        userMsg([toolResultWithImage("t1", "data")]),
        assistantMsg("r1"),
        userMsg([{ type: "text", text: "prompt" }]),
      ],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.equal(ctx.meta.imageStripStats, undefined);
});
