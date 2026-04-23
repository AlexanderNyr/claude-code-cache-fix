import { test } from "node:test";
import assert from "node:assert/strict";
import ext, {
  normalizeSessionStartText,
  isContinueTrailerBlock,
  isBookkeepingReminder,
} from "../proxy/extensions/identity-normalization.mjs";

// --- Unit tests: normalizeSessionStartText ---

test("normalizeSessionStartText: returns tuple [text, count]", () => {
  const [text, count] = normalizeSessionStartText("normal text");
  assert.equal(text, "normal text");
  assert.equal(count, 0);
});

test("normalizeSessionStartText: no-op on text without SessionStart marker", () => {
  const input = "Normal startup text with no session markers.";
  const [text, count] = normalizeSessionStartText(input);
  assert.equal(text, input);
  assert.equal(count, 0);
});

test("normalizeSessionStartText: no-op when text lacks SessionStart marker", () => {
  const input = "SessionStart:resume hook success: something";
  const [text, count] = normalizeSessionStartText(input);
  // This text doesn't match the SESSION_START_RESUME_MARKER regex
  // (which looks for "startup hook success", not "resume")
  assert.equal(count, 0);
});

// --- Unit tests: isContinueTrailerBlock ---

test("isContinueTrailerBlock: detects continue trailer", () => {
  const block = { type: "text", text: "Continue from where you left off." };
  assert.ok(isContinueTrailerBlock(block));
});

test("isContinueTrailerBlock: does not match longer text containing the phrase", () => {
  const block = { type: "text", text: "Please continue from where you left off and also do this." };
  assert.ok(!isContinueTrailerBlock(block));
});

test("isContinueTrailerBlock: does not match non-text blocks", () => {
  assert.ok(!isContinueTrailerBlock({ type: "image" }));
  assert.ok(!isContinueTrailerBlock(null));
  assert.ok(!isContinueTrailerBlock(undefined));
});

// --- Unit tests: isBookkeepingReminder ---

test("isBookkeepingReminder: detects token usage format", () => {
  assert.ok(isBookkeepingReminder("<system-reminder>\nToken usage: 50000/200000; 150000 remaining\n</system-reminder>"));
});

test("isBookkeepingReminder: detects output tokens format", () => {
  assert.ok(isBookkeepingReminder("<system-reminder>\nOutput tokens — turn: 500 · session: 3000\n</system-reminder>"));
});

test("isBookkeepingReminder: detects USD budget format", () => {
  assert.ok(isBookkeepingReminder("<system-reminder>\nUSD budget: $5.00/$10.00; $5.00 remaining\n</system-reminder>"));
});

test("isBookkeepingReminder: does not match non-bookkeeping reminders", () => {
  assert.ok(!isBookkeepingReminder("<system-reminder>\nImportant project context.\n</system-reminder>"));
});

test("isBookkeepingReminder: does not match non-reminder text", () => {
  assert.ok(!isBookkeepingReminder("Just normal text."));
});

test("isBookkeepingReminder: handles non-string input", () => {
  assert.ok(!isBookkeepingReminder(null));
  assert.ok(!isBookkeepingReminder(42));
});

// --- Integration test: onRequest ---

test("onRequest: preserves continue trailers (extension skips, does not strip)", async () => {
  const ctx = {
    body: {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Real user content here." },
            { type: "text", text: "Continue from where you left off." },
          ],
        },
      ],
      system: [],
    },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);

  const userContent = ctx.body.messages[0].content;
  assert.equal(userContent.length, 2, "Extension does not remove blocks, only normalizes text");
});

test("onRequest: handles empty messages array", async () => {
  const ctx = { body: { messages: [], system: [] }, headers: {}, meta: {} };
  await ext.onRequest(ctx);
  assert.deepEqual(ctx.body.messages, []);
});
