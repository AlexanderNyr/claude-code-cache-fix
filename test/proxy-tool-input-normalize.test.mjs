import { test } from "node:test";
import assert from "node:assert/strict";
import ext, { normalizeToolUseInputs } from "../proxy/extensions/tool-input-normalize.mjs";

function makeBody(tools, messages) {
  return { tools, messages };
}

const TOOLS = [
  { name: "Read", input_schema: { properties: { file_path: {}, offset: {}, limit: {} } } },
  { name: "Write", input_schema: { properties: { file_path: {}, content: {} } } },
];

// --- Unit tests ---

test("normalizeToolUseInputs: reorders keys to match schema", () => {
  const body = makeBody(TOOLS, [
    {
      role: "assistant",
      content: [
        { type: "tool_use", name: "Read", input: { limit: 10, file_path: "/tmp/x", offset: 0 } },
      ],
    },
  ]);

  const count = normalizeToolUseInputs(body);
  assert.equal(count, 1);
  const keys = Object.keys(body.messages[0].content[0].input);
  assert.deepEqual(keys, ["file_path", "offset", "limit"]);
});

test("normalizeToolUseInputs: strips extra keys not in schema", () => {
  const body = makeBody(TOOLS, [
    {
      role: "assistant",
      content: [
        { type: "tool_use", name: "Write", input: { content: "hi", file_path: "/tmp/x", _extra: true } },
      ],
    },
  ]);

  const count = normalizeToolUseInputs(body);
  assert.equal(count, 1);
  const input = body.messages[0].content[0].input;
  assert.ok(!("_extra" in input), "extra key should be stripped");
  assert.deepEqual(Object.keys(input), ["file_path", "content"]);
});

test("normalizeToolUseInputs: no-op when already canonical", () => {
  const body = makeBody(TOOLS, [
    {
      role: "assistant",
      content: [
        { type: "tool_use", name: "Read", input: { file_path: "/tmp/x", offset: 0, limit: 10 } },
      ],
    },
  ]);

  assert.equal(normalizeToolUseInputs(body), 0);
});

test("normalizeToolUseInputs: skips unknown tools", () => {
  const body = makeBody(TOOLS, [
    {
      role: "assistant",
      content: [
        { type: "tool_use", name: "UnknownTool", input: { z: 1, a: 2 } },
      ],
    },
  ]);

  assert.equal(normalizeToolUseInputs(body), 0);
});

test("normalizeToolUseInputs: skips user messages", () => {
  const body = makeBody(TOOLS, [
    {
      role: "user",
      content: [
        { type: "tool_use", name: "Read", input: { limit: 1, file_path: "/x" } },
      ],
    },
  ]);

  assert.equal(normalizeToolUseInputs(body), 0);
});

test("normalizeToolUseInputs: handles missing/null body", () => {
  assert.equal(normalizeToolUseInputs(null), 0);
  assert.equal(normalizeToolUseInputs({}), 0);
  assert.equal(normalizeToolUseInputs({ messages: [], tools: [] }), 0);
});

test("normalizeToolUseInputs: handles partial schema keys", () => {
  const body = makeBody(TOOLS, [
    {
      role: "assistant",
      content: [
        { type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } },
      ],
    },
  ]);

  assert.equal(normalizeToolUseInputs(body), 0, "subset in correct order = no-op");
});

// --- onRequest ---

test("onRequest: normalizes and sets count in meta", async () => {
  const ctx = {
    body: makeBody(TOOLS, [
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Read", input: { limit: 5, offset: 0, file_path: "/x" } },
        ],
      },
    ]),
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.equal(ctx.meta.toolInputNormalizeCount, 1);
});

test("onRequest: no-op when no tools or messages", async () => {
  const ctx = { body: {}, headers: {}, meta: {} };
  await ext.onRequest(ctx);
  assert.equal(ctx.meta.toolInputNormalizeCount, undefined);
});
