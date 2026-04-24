import { test } from "node:test";
import assert from "node:assert/strict";
import ext, { splitSmooshedReminders } from "../proxy/extensions/smoosh-split.mjs";

function toolResult(id, content) {
  return { type: "tool_result", tool_use_id: id, content };
}

const REMINDER = "<system-reminder>\nToken usage: 50000/200000; 150000 remaining\n</system-reminder>";
const HOOK_REMINDER = "<system-reminder>\nHook output: custom data here\n</system-reminder>";

// --- Unit tests ---

test("splitSmooshedReminders: peels single trailing reminder", () => {
  const messages = [
    {
      role: "user",
      content: [
        toolResult("t1", "tool output text\n\n" + REMINDER),
      ],
    },
  ];
  const { messages: result, stats } = splitSmooshedReminders(messages);
  assert.ok(stats);
  assert.equal(stats.peeled, 1);
  assert.equal(result[0].content[0].content, "tool output text");
  assert.equal(result[0].content[1].type, "text");
  assert.ok(result[0].content[1].text.includes("Token usage"));
});

test("splitSmooshedReminders: peels multiple trailing reminders", () => {
  const messages = [
    {
      role: "user",
      content: [
        toolResult("t1", "output\n\n" + REMINDER + "\n\n" + HOOK_REMINDER),
      ],
    },
  ];
  const { messages: result, stats } = splitSmooshedReminders(messages);
  assert.equal(stats.peeled, 2);
  assert.equal(result[0].content[0].content, "output");
  assert.equal(result[0].content.length, 3); // original + 2 peeled
});

test("splitSmooshedReminders: preserves peeled reminder order", () => {
  const messages = [
    {
      role: "user",
      content: [
        toolResult("t1", "output\n\n" + REMINDER + "\n\n" + HOOK_REMINDER),
      ],
    },
  ];
  const { messages: result } = splitSmooshedReminders(messages);
  assert.ok(result[0].content[1].text.includes("Token usage"), "first peeled should be token usage");
  assert.ok(result[0].content[2].text.includes("Hook output"), "second peeled should be hook");
});

test("splitSmooshedReminders: no-op when no smooshed content", () => {
  const messages = [
    {
      role: "user",
      content: [
        toolResult("t1", "clean tool output with no reminders"),
      ],
    },
  ];
  const { stats } = splitSmooshedReminders(messages);
  assert.equal(stats, null);
});

test("splitSmooshedReminders: no-op for array tool_result content", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "array content" }] },
      ],
    },
  ];
  const { stats } = splitSmooshedReminders(messages);
  assert.equal(stats, null);
});

test("splitSmooshedReminders: skips assistant messages", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        toolResult("t1", "output\n\n" + REMINDER),
      ],
    },
  ];
  const { stats } = splitSmooshedReminders(messages);
  assert.equal(stats, null);
});

test("splitSmooshedReminders: peeled reminders go after all tool_results", () => {
  const messages = [
    {
      role: "user",
      content: [
        toolResult("t1", "output1\n\n" + REMINDER),
        toolResult("t2", "output2"),
        { type: "text", text: "user prompt" },
      ],
    },
  ];
  const { messages: result } = splitSmooshedReminders(messages);
  // Order: t1 (cleaned), t2, user prompt, peeled reminder
  assert.equal(result[0].content[0].type, "tool_result");
  assert.equal(result[0].content[0].content, "output1");
  assert.equal(result[0].content[1].type, "tool_result");
  assert.equal(result[0].content[2].type, "text");
  assert.equal(result[0].content[2].text, "user prompt");
  assert.equal(result[0].content[3].type, "text");
  assert.ok(result[0].content[3].text.includes("Token usage"));
});

test("splitSmooshedReminders: does not match mid-content reminders", () => {
  const content = REMINDER + "\n\nsome text after reminder";
  const messages = [
    { role: "user", content: [toolResult("t1", content)] },
  ];
  const { stats } = splitSmooshedReminders(messages);
  assert.equal(stats, null, "should only match trailing reminders");
});

test("splitSmooshedReminders: handles null input", () => {
  const { stats } = splitSmooshedReminders(null);
  assert.equal(stats, null);
});

test("splitSmooshedReminders: handles empty messages", () => {
  const { stats } = splitSmooshedReminders([]);
  assert.equal(stats, null);
});

// --- onRequest ---

test("onRequest: splits and sets stats", async () => {
  const ctx = {
    body: {
      messages: [
        {
          role: "user",
          content: [
            toolResult("t1", "output\n\n" + REMINDER),
          ],
        },
      ],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.ok(ctx.meta.smooshSplitStats);
  assert.equal(ctx.meta.smooshSplitStats.peeled, 1);
  assert.equal(ctx.body.messages[0].content.length, 2);
});

test("onRequest: no-op when nothing to split", async () => {
  const ctx = {
    body: {
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.equal(ctx.meta.smooshSplitStats, undefined);
});
