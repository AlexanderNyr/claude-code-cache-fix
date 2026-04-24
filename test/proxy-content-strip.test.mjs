import { test } from "node:test";
import assert from "node:assert/strict";
import ext, {
  isContinueTrailerBlock,
  isBookkeepingReminder,
  stripContentBlocks,
} from "../proxy/extensions/content-strip.mjs";

// --- isContinueTrailerBlock ---

test("isContinueTrailerBlock: exact match", () => {
  assert.ok(isContinueTrailerBlock({ type: "text", text: "Continue from where you left off." }));
});

test("isContinueTrailerBlock: rejects longer text", () => {
  assert.ok(!isContinueTrailerBlock({ type: "text", text: "Continue from where you left off. Also do X." }));
});

test("isContinueTrailerBlock: rejects non-text type", () => {
  assert.ok(!isContinueTrailerBlock({ type: "image", text: "Continue from where you left off." }));
});

test("isContinueTrailerBlock: rejects null/undefined", () => {
  assert.ok(!isContinueTrailerBlock(null));
  assert.ok(!isContinueTrailerBlock(undefined));
});

// --- isBookkeepingReminder ---

test("isBookkeepingReminder: token usage", () => {
  assert.ok(isBookkeepingReminder("<system-reminder>\nToken usage: 50000/200000; 150000 remaining\n</system-reminder>"));
});

test("isBookkeepingReminder: output tokens", () => {
  assert.ok(isBookkeepingReminder("<system-reminder>\nOutput tokens — turn: 500 · session: 3000\n</system-reminder>"));
});

test("isBookkeepingReminder: USD budget", () => {
  assert.ok(isBookkeepingReminder("<system-reminder>\nUSD budget: $5.00/$10.00; $5.00 remaining\n</system-reminder>"));
});

test("isBookkeepingReminder: task tools reminder", () => {
  assert.ok(isBookkeepingReminder("<system-reminder>\nThe task tools haven't been used recently.\n</system-reminder>"));
});

test("isBookkeepingReminder: TodoWrite reminder", () => {
  assert.ok(isBookkeepingReminder("<system-reminder>\nThe TodoWrite tool hasn't been used recently.\n</system-reminder>"));
});

test("isBookkeepingReminder: remaining turns", () => {
  assert.ok(isBookkeepingReminder("<system-reminder>\nRemaining conversation turns: 42\n</system-reminder>"));
});

test("isBookkeepingReminder: messages until auto-compact", () => {
  assert.ok(isBookkeepingReminder("<system-reminder>\nMessages until auto-compact: 5\n</system-reminder>"));
});

test("isBookkeepingReminder: rejects non-bookkeeping", () => {
  assert.ok(!isBookkeepingReminder("<system-reminder>\nImportant project context.\n</system-reminder>"));
});

test("isBookkeepingReminder: rejects non-reminder text", () => {
  assert.ok(!isBookkeepingReminder("plain text"));
});

// --- stripContentBlocks ---

test("stripContentBlocks: strips trailers", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "real prompt" },
        { type: "text", text: "Continue from where you left off." },
      ],
    },
  ];
  const { messages: result, stats } = stripContentBlocks(messages);
  assert.equal(stats.trailerCount, 1);
  assert.equal(result[0].content.length, 1);
  assert.equal(result[0].content[0].text, "real prompt");
});

test("stripContentBlocks: strips reminders", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "real prompt" },
        { type: "text", text: "<system-reminder>\nToken usage: 100/200; 100 remaining\n</system-reminder>" },
      ],
    },
  ];
  const { messages: result, stats } = stripContentBlocks(messages);
  assert.equal(stats.reminderCount, 1);
  assert.equal(result[0].content.length, 1);
});

test("stripContentBlocks: does not empty message content and does not count", () => {
  const messages = [
    {
      role: "user",
      content: [{ type: "text", text: "Continue from where you left off." }],
    },
  ];
  const { messages: result, stats } = stripContentBlocks(messages);
  assert.equal(result[0].content.length, 1, "should preserve when stripping would empty");
  assert.equal(stats, null, "should not report stats when nothing was actually stripped");
});

test("stripContentBlocks: no-op on assistant messages", () => {
  const messages = [
    {
      role: "assistant",
      content: [{ type: "text", text: "Continue from where you left off." }],
    },
  ];
  const { stats } = stripContentBlocks(messages);
  assert.equal(stats, null);
});

test("stripContentBlocks: strips both trailers and reminders in same message", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "real content" },
        { type: "text", text: "Continue from where you left off." },
        { type: "text", text: "<system-reminder>\nUSD budget: $1.00/$10.00; $9.00 remaining\n</system-reminder>" },
      ],
    },
  ];
  const { messages: result, stats } = stripContentBlocks(messages);
  assert.equal(stats.trailerCount, 1);
  assert.equal(stats.reminderCount, 1);
  assert.equal(result[0].content.length, 1);
});

test("stripContentBlocks: no-op when nothing to strip", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "normal message" }] },
  ];
  const { stats } = stripContentBlocks(messages);
  assert.equal(stats, null);
});

test("stripContentBlocks: handles null input", () => {
  const { stats } = stripContentBlocks(null);
  assert.equal(stats, null);
});

// --- onRequest ---

test("onRequest: strips content and sets stats", async () => {
  const ctx = {
    body: {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "prompt" },
            { type: "text", text: "Continue from where you left off." },
          ],
        },
      ],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.ok(ctx.meta.contentStripStats);
  assert.equal(ctx.meta.contentStripStats.trailerCount, 1);
  assert.equal(ctx.body.messages[0].content.length, 1);
});

test("onRequest: no-op when nothing to strip", async () => {
  const ctx = {
    body: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.equal(ctx.meta.contentStripStats, undefined);
});
