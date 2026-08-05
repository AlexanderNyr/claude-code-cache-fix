// insertion-merge-suppression — the merged-standalone shape (587k window,
// capture s-4b6a435234bf, msg864). Sibling to insertion-suppression.test.mjs's
// single-block case, but here CC migrates ALL of a message's volatile
// blocks out TOGETHER, joined into one standalone message, rather than one
// standalone per block. The single-block pinnedHashes set can never match
// that shape (it hashes one block at a time); this file exercises the
// join-hash set added alongside it (pinnedJoinHashes / findSuppressibleDuplicate's
// third argument).
//
// Design settled by the dispatcher after the 587k premise was corrected
// (BACKLOG.md, "merged-reminder standalone, join-hash design settled"): for
// each pinned entry with >=2 volatile blocks, also hash the concatenation of
// ALL its volatile blocks' wrapper-stripped texts, in WIRE order, joined
// with "\n\n" — the exact separator measured on the real merged standalone.
// No subset-merges, no other separators — this is the one observed shape,
// not a general N-ary merge grammar.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyPinned,
  pinnedBlockHashes,
  pinnedJoinHashes,
  findSuppressibleDuplicate,
} from "../proxy/extensions/insertion-normalization.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "harvested", "oscillation-s-4b6a435234bf-863.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));

// The real msg863 form (1243B-shaped: tool_result + two <system-reminder>
// blocks, PreToolUse and PostToolUse) and the real msg864 merged standalone
// (627 chars, both reminders wrapper-stripped and joined with "\n\n") —
// pulled from the fixture rather than retyped, so the bite is the actual
// measured bytes, not a paraphrase of them.
const REAL_MSG863 = fixture.requests[0].msg863;
const REAL_MERGED_STANDALONE = fixture.requests_864.find((r) => r.msg864.role === "system").msg864;

// --- Helpers (mirrors test/insertion-suppression.test.mjs's idiom) ---

function assistantToolUse(id) {
  return { role: "assistant", content: [{ type: "tool_use", id, name: "Agent", input: {} }] };
}

function userMsg(text) {
  return { role: "user", content: [{ type: "text", text }] };
}

const REMINDER_PRE = "<system-reminder>\nPreToolUse: first reminder\n</system-reminder>";
const REMINDER_POST = "<system-reminder>\nPostToolUse: second reminder\n</system-reminder>";

function withTwoReminders(text) {
  return {
    role: "user",
    content: [
      { type: "text", text },
      { type: "text", text: REMINDER_PRE },
      { type: "text", text: REMINDER_POST },
    ],
  };
}

function pinCanon(messages) {
  return classifyPinned(messages, null).canonicalEntries;
}

// =====================================================================
// (a) Bite from the REAL fixture bytes
// =====================================================================

test("RED against the old (2-arg) call: the real merged standalone does not match single-block hashes alone", () => {
  // The tool_use id in the real fixture's msg863 pairs it with an
  // assistant Agent-spawn — reproduced here only so classifyPinned's
  // adjacency check accepts the array; the message content itself is the
  // fixture's own, unmodified.
  const toolUseId = REAL_MSG863.content[0].tool_use_id;
  const canon = pinCanon([assistantToolUse(toolUseId), REAL_MSG863]);
  const pinnedHashes = pinnedBlockHashes(canon);

  // Old call shape (no third argument) — this is exactly what production
  // ran before the join-hash set existed, and it is what left
  // suppressed:0 across all 560 events of the real session.
  const h = findSuppressibleDuplicate(REAL_MERGED_STANDALONE, pinnedHashes);
  assert.equal(h, null, "single-block hashes alone must not match a merged standalone — this IS the observed gap");
});

test("GREEN: the real merged standalone matches the join-hash of its pinned entry", () => {
  const toolUseId = REAL_MSG863.content[0].tool_use_id;
  const canon = pinCanon([assistantToolUse(toolUseId), REAL_MSG863]);
  const pinnedHashes = pinnedBlockHashes(canon);
  const joinHashes = pinnedJoinHashes(canon);

  assert.equal(joinHashes.size, 1, "msg863's entry has exactly 2 volatile blocks -> exactly one join hash");

  const h = findSuppressibleDuplicate(REAL_MERGED_STANDALONE, pinnedHashes, joinHashes);
  assert.notEqual(h, null, "the real merged standalone must be recognized as a suppressible duplicate");
});

test("classifyPinned end-to-end: the real merged standalone is suppressed as a new entry, not forwarded twice (MID-HISTORY — matches the real capture, which had dozens of messages after msg864)", () => {
  const toolUseId = REAL_MSG863.content[0].tool_use_id;
  const canon = pinCanon([assistantToolUse(toolUseId), REAL_MSG863]);

  // A trailing turn after the standalone, so it sits at a genuine
  // mid-history position (index 2 of 4) rather than the array's final
  // index — the real capture had ~57 more messages after msg864. The
  // tail-guard test below covers the DIFFERENT real incident where the
  // duplicate IS the final message.
  const messages = [
    assistantToolUse(toolUseId),
    REAL_MSG863,
    { ...REAL_MERGED_STANDALONE },
    { role: "assistant", content: [{ type: "text", text: "a-after" }] },
  ];
  const result = classifyPinned(messages, canon);

  assert.equal(result.suppressed, 1, "the merged standalone must be counted as a suppression");
  assert.equal(result.suppressions.length, 1);
  assert.equal(result.suppressions[0].index, 2);
  // The pinned inline form (index 1) already carries both reminders; the
  // standalone must not also appear in the forwarded array.
  assert.equal(result.messages.length, 3, "the standalone must not be forwarded alongside the pinned inline form");
});

// =====================================================================
// TAIL GUARD (BACKLOG.md, "suppression can strip a request's FINAL
// message", 2026-07-30) — the join-hash-specific case. Three real 400s
// traced to suppression removing a resume request's ONLY/new final
// message, leaving the forwarded array ending on the prior assistant
// turn -> upstream "must end with a user message". A tail-position
// duplicate is the request's live payload, not a stray migration copy.
// =====================================================================

test("TAIL GUARD: the real merged standalone as the FINAL message is never suppressed", () => {
  const toolUseId = REAL_MSG863.content[0].tool_use_id;
  const canon = pinCanon([assistantToolUse(toolUseId), REAL_MSG863]);

  const messages = [assistantToolUse(toolUseId), REAL_MSG863, { ...REAL_MERGED_STANDALONE }];
  const result = classifyPinned(messages, canon);

  assert.equal(result.suppressed, 0, "a final-position merged duplicate must be forwarded, not suppressed");
  assert.equal(result.messages.length, 3, "the standalone must remain on the wire as the live final message");
  assert.equal(
    result.messages[result.messages.length - 1].content,
    REAL_MERGED_STANDALONE.content,
    "the final message content is unchanged",
  );
});

// =====================================================================
// (b) Regression: single-reminder standalone still matches (unchanged path)
// =====================================================================

test("REGRESSION: a single-reminder standalone still matches via pinnedHashes even though joinHashes is now also passed", () => {
  const REMINDER_INNER = "PreToolUse:Edit hook additional context: file changed";
  const REMINDER = `<system-reminder>\n${REMINDER_INNER}\n</system-reminder>`;
  const singleReminderMsg = {
    role: "user",
    content: [
      { type: "text", text: "tool result" },
      { type: "text", text: REMINDER },
    ],
  };
  const canon = pinCanon([singleReminderMsg, { role: "assistant", content: [{ type: "text", text: "a1" }] }]);
  const pinnedHashes = pinnedBlockHashes(canon);
  const joinHashes = pinnedJoinHashes(canon);

  assert.equal(joinHashes.size, 0, "a single volatile block never produces a join hash");

  const standalone = { role: "system", content: [{ type: "text", text: REMINDER_INNER }] };
  const h = findSuppressibleDuplicate(standalone, pinnedHashes, joinHashes);
  assert.notEqual(h, null, "the existing single-block suppression path must be unaffected");
});

// =====================================================================
// (c) Guard: a join of blocks from TWO DIFFERENT entries is NOT suppressed
// =====================================================================

test("GUARD: concatenating volatile blocks from two DIFFERENT pinned entries does not suppress — identity is per-entry", () => {
  // Two separate messages, each carrying exactly ONE of the two reminders
  // (as opposed to withTwoReminders, which puts both on the SAME entry).
  const entryA = {
    role: "user",
    content: [{ type: "text", text: "result A" }, { type: "text", text: REMINDER_PRE }],
  };
  const entryB = {
    role: "user",
    content: [{ type: "text", text: "result B" }, { type: "text", text: REMINDER_POST }],
  };
  const canon = pinCanon([
    entryA,
    { role: "assistant", content: [{ type: "text", text: "a1" }] },
    entryB,
    { role: "assistant", content: [{ type: "text", text: "a2" }] },
  ]);
  const pinnedHashes = pinnedBlockHashes(canon);
  const joinHashes = pinnedJoinHashes(canon);

  assert.equal(joinHashes.size, 0, "neither entry has >=2 volatile blocks of its own -> no join hash from either");

  // A candidate that tries to forge the join by pasting bytes from BOTH
  // entries together.
  const forged = {
    role: "system",
    content: "PreToolUse: first reminder\n\nPostToolUse: second reminder",
  };
  const h = findSuppressibleDuplicate(forged, pinnedHashes, joinHashes);
  assert.equal(h, null, "a cross-entry concatenation must never be treated as a suppressible duplicate");
});

// =====================================================================
// (d) Guard: a genuinely different concatenation is NOT suppressed
// =====================================================================

test("GUARD: wrong order, wrong separator, or extra content — none of them suppress", () => {
  const canon = pinCanon([withTwoReminders("tool result"), { role: "assistant", content: [{ type: "text", text: "a1" }] }]);
  const pinnedHashes = pinnedBlockHashes(canon);
  const joinHashes = pinnedJoinHashes(canon);
  assert.equal(joinHashes.size, 1);

  const reversedOrder = {
    role: "system",
    content: "PostToolUse: second reminder\n\nPreToolUse: first reminder",
  };
  assert.equal(findSuppressibleDuplicate(reversedOrder, pinnedHashes, joinHashes), null, "reversed order must not match");

  const wrongSeparator = {
    role: "system",
    content: "PreToolUse: first reminder\nPostToolUse: second reminder",
  };
  assert.equal(
    findSuppressibleDuplicate(wrongSeparator, pinnedHashes, joinHashes),
    null,
    "a single-newline join (unobserved separator) must not match",
  );

  const extraContent = {
    role: "system",
    content: "PreToolUse: first reminder\n\nPostToolUse: second reminder\n\nextra",
  };
  assert.equal(findSuppressibleDuplicate(extraContent, pinnedHashes, joinHashes), null, "extra trailing content must not match");
});

// =====================================================================
// pinnedJoinHashes unit bites (mirrors pinnedBlockHashes's own tests)
// =====================================================================

test("pinnedJoinHashes: a dropped entry's join is excluded — its content is not being served anywhere", () => {
  const canon1 = pinCanon([
    withTwoReminders("tool result"),
    { role: "assistant", content: [{ type: "text", text: "a1" }] },
    userMsg("u2"),
    { role: "assistant", content: [{ type: "text", text: "a3" }] },
  ]);
  const pruned = classifyPinned(
    [{ role: "assistant", content: [{ type: "text", text: "a1" }] }, userMsg("u2"), { role: "assistant", content: [{ type: "text", text: "a3" }] }, userMsg("tail")],
    canon1,
  );
  assert.equal(pruned.dropped, 1);
  const joinHashes = pinnedJoinHashes(pruned.canonicalEntries);
  assert.equal(joinHashes.size, 0, "a dropped pin's join must not be treated as currently live");
});
