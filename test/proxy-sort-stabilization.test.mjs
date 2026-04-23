import { test } from "node:test";
import assert from "node:assert/strict";
import ext, {
  sortSkillsBlock,
  sortDeferredToolsBlock,
  isSkillsBlock,
  isDeferredToolsBlock,
} from "../proxy/extensions/sort-stabilization.mjs";

// --- Unit tests: detection ---

test("isSkillsBlock: detects skills listing", () => {
  assert.ok(isSkillsBlock("User-invocable skills:\n- foo\n- bar"));
  assert.ok(!isSkillsBlock("some other text"));
  assert.ok(!isSkillsBlock(null));
  assert.ok(!isSkillsBlock(42));
});

test("isDeferredToolsBlock: detects deferred tools", () => {
  assert.ok(isDeferredToolsBlock("The following deferred tools are now available"));
  assert.ok(!isDeferredToolsBlock("some other text"));
});

// --- Unit tests: sorting ---

test("sortSkillsBlock: sorts skill entries alphabetically", () => {
  const input = "Header text\n\n- zephyr: does z\n- alpha: does a\n- mid: does m\n</system-reminder>";
  const result = sortSkillsBlock(input);
  const entries = result.match(/- \w+/g);
  assert.deepEqual(entries, ["- alpha", "- mid", "- zephyr"]);
});

test("sortSkillsBlock: idempotent on already-sorted input", () => {
  const input = "Header text\n\n- alpha: does a\n- beta: does b\n- gamma: does g\n</system-reminder>";
  assert.equal(sortSkillsBlock(input), input);
});

test("sortSkillsBlock: returns unchanged if no match", () => {
  const input = "no skills here";
  assert.equal(sortSkillsBlock(input), input);
});

test("sortDeferredToolsBlock: sorts tool names alphabetically", () => {
  const input = "<system-reminder>\nThe following deferred tools are now available:\nzebra\napple\nmango\n</system-reminder>";
  const result = sortDeferredToolsBlock(input);
  const tools = result.split("\n").filter((l) => l && !l.includes("system-reminder") && !l.includes("deferred tools"));
  assert.deepEqual(tools, ["apple", "mango", "zebra"]);
});

test("sortDeferredToolsBlock: idempotent on sorted input", () => {
  const input = "<system-reminder>\nThe following deferred tools are now available:\nalpha\nbeta\ngamma\n</system-reminder>";
  assert.equal(sortDeferredToolsBlock(input), input);
});

test("sortDeferredToolsBlock: returns unchanged if no match", () => {
  const input = "not a deferred tools block";
  assert.equal(sortDeferredToolsBlock(input), input);
});

// --- Integration test: onRequest sorts tools array ---

test("onRequest: sorts tools array alphabetically by name", async () => {
  const ctx = {
    body: {
      system: [],
      tools: [
        { name: "zebra", description: "z" },
        { name: "alpha", description: "a" },
        { name: "middle", description: "m" },
      ],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.deepEqual(
    ctx.body.tools.map((t) => t.name),
    ["alpha", "middle", "zebra"]
  );
});

test("onRequest: idempotent on already-sorted tools", async () => {
  const tools = [
    { name: "alpha", description: "a" },
    { name: "beta", description: "b" },
  ];
  const ctx = { body: { system: [], tools: [...tools] }, headers: {}, meta: {} };

  await ext.onRequest(ctx);
  assert.deepEqual(ctx.body.tools, tools);
});

test("onRequest: handles empty tools array", async () => {
  const ctx = { body: { system: [], tools: [] }, headers: {}, meta: {} };
  await ext.onRequest(ctx);
  assert.deepEqual(ctx.body.tools, []);
});

test("onRequest: sorts skills block in system prompt", async () => {
  const skillsText = "User-invocable skills:\n\n- zephyr: z\n- alpha: a\n</system-reminder>";
  const ctx = {
    body: {
      system: [{ type: "text", text: skillsText }],
      tools: [],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.ok(ctx.body.system[0].text.indexOf("alpha") < ctx.body.system[0].text.indexOf("zephyr"));
});
