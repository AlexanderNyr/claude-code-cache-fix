import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ext, {
  computeIdentities,
  classifyInsertion,
  classifyPinned,
  isVolatileBlock,
  validateToolAdjacency,
  resolveInsertionSessionKey,
} from "../proxy/extensions/insertion-normalization.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Helpers ---

function userMsg(text) {
  return { role: "user", content: [{ type: "text", text }] };
}
function assistantMsg(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}
function toolUseMsg(id, name = "Bash") {
  return { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] };
}
function toolResultMsg(toolUseId, text = "result") {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }] };
}

function conv(n, seed = "c") {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(i % 2 === 0 ? userMsg(`${seed}-u${i}`) : assistantMsg(`${seed}-a${i}`));
  }
  return out;
}

async function newTmp() {
  return mkdtemp(join(tmpdir(), "insertion-norm-test-"));
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function withEnvAsync(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function silenced(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    return await fn();
  } finally {
    process.stderr.write = orig;
  }
}

async function runExt(body, { headers, dir } = {}) {
  const savedHome = process.env.CLAUDE_CONFIG_DIR;
  if (dir) process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const ctx = { body, meta: {}, headers: headers || {} };
    await ext.onRequest(ctx);
    return ctx;
  } finally {
    if (dir) {
      if (savedHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = savedHome;
    }
  }
}

// =====================================================================
// Pure classifier tests
// =====================================================================

test("pure append: canonical is a strict prefix, no splice -> action append-only, messages unchanged", () => {
  const prior = conv(10, "append");
  const priorCanon = computeIdentities(prior).map((e) => ({ h: e.h, r: e.r, o: e.o }));
  const incoming = prior.concat(conv(2, "append-tail"));

  const result = classifyInsertion(incoming, priorCanon);
  assert.equal(result.action, "append-only");
  assert.deepEqual(result.messages, incoming);
  assert.equal(result.inserted, 2);
});

test("single user-role mid-insertion: normalized to tail, cache-relevant prefix byte-identical to canonical", () => {
  const prior = conv(10, "mid");
  const priorCanon = computeIdentities(prior).map((e) => ({ h: e.h, r: e.r, o: e.o }));

  // Splice one new user message between prior[4] and prior[5].
  const incoming = prior.slice(0, 5).concat([userMsg("mid-inserted")], prior.slice(5));

  const result = classifyInsertion(incoming, priorCanon);
  assert.equal(result.action, "normalized");
  assert.equal(result.inserted, 1);
  // Cache-relevant prefix: canonical order first, byte-identical to `prior`.
  assert.deepEqual(result.messages.slice(0, prior.length), prior);
  // New entry appended at the tail.
  assert.deepEqual(result.messages[prior.length], userMsg("mid-inserted"));
});

test("multiple insertions keep relative order", () => {
  const prior = conv(10, "multi");
  const priorCanon = computeIdentities(prior).map((e) => ({ h: e.h, r: e.r, o: e.o }));

  const insertA = userMsg("insert-A");
  const insertB = userMsg("insert-B");
  // Both spliced between prior[3] and prior[4], in order A then B.
  const incoming = prior.slice(0, 4).concat([insertA, insertB], prior.slice(4));

  const result = classifyInsertion(incoming, priorCanon);
  assert.equal(result.action, "normalized");
  assert.equal(result.inserted, 2);
  assert.deepEqual(result.messages.slice(0, prior.length), prior);
  assert.deepEqual(result.messages[prior.length], insertA);
  assert.deepEqual(result.messages[prior.length + 1], insertB);
});

test("assistant-role insertion -> reset (never reorders an assistant message)", () => {
  const prior = conv(10, "asst");
  const priorCanon = computeIdentities(prior).map((e) => ({ h: e.h, r: e.r, o: e.o }));

  const incoming = prior.slice(0, 4).concat([assistantMsg("unexpected-assistant-insert")], prior.slice(4));

  const result = classifyInsertion(incoming, priorCanon);
  assert.equal(result.action, "reset");
  assert.equal(result.resetReason, "assistant-interleaved");
});

test("shrunk history (fewer messages than canonical) -> reset", () => {
  const prior = conv(10, "shrink");
  const priorCanon = computeIdentities(prior).map((e) => ({ h: e.h, r: e.r, o: e.o }));

  const incoming = prior.slice(0, 6); // fewer than canonical's 10 entries
  const result = classifyInsertion(incoming, priorCanon);
  assert.equal(result.action, "reset");
  // A shorter array cannot contain every canonical identity, so it fails
  // the subsequence match.
  assert.equal(result.resetReason, "not-subsequence");
});

test("tool_result adjacency violation -> reset even when insertion would otherwise qualify", () => {
  // Canonical ends on a plain user turn (u3) that is NOT part of the
  // tool_use/tool_result pair — this is what makes the inserted entries
  // count as a genuine mid-canonical splice (index <= lastMatched) rather
  // than ordinary tail growth, so the splice path (and its adjacency
  // check) actually runs.
  const tu = toolUseMsg("tu-1");
  const trOrig = toolResultMsg("tu-1", "orig-result");
  const u3 = userMsg("u3-final-canonical");
  const prior = [userMsg("p0"), tu, trOrig, u3];
  const priorCanon = computeIdentities(prior).map((e) => ({ h: e.h, r: e.r, o: e.o }));

  // Two new user-role entries spliced between trOrig and u3: an unrelated
  // message, then a DIFFERENT tool_result for the same tu-1 id (content
  // differs from trOrig, so it doesn't match that canonical identity and
  // is treated as new). Re-serializing (canonical order + new entries
  // appended) would place the unrelated message directly before this new
  // tool_result, separating it from its tool_use — must reset instead.
  const otherNew = userMsg("unrelated queued message");
  const trDiffering = toolResultMsg("tu-1", "different-late-result");
  const incoming = [userMsg("p0"), tu, trOrig, otherNew, trDiffering, u3];

  const result = classifyInsertion(incoming, priorCanon);
  assert.equal(result.action, "reset");
  assert.equal(result.resetReason, "adjacency-violation");
});

test("validateToolAdjacency: true for well-formed tool_use/tool_result pairing", () => {
  const tu = toolUseMsg("tu-2");
  const tr = toolResultMsg("tu-2");
  assert.equal(validateToolAdjacency([userMsg("a"), tu, tr]), true);
});

test("validateToolAdjacency: false when tool_result's preceding message isn't the matching tool_use", () => {
  const tu = toolUseMsg("tu-3");
  const tr = toolResultMsg("tu-3");
  assert.equal(validateToolAdjacency([userMsg("a"), tu, userMsg("intervening"), tr]), false);
});

test("duplicate identical user messages disambiguated by occurrence counter", () => {
  const dup = userMsg("same text every time");
  const prior = [userMsg("p0"), dup, userMsg("p2"), dup];
  const identities = computeIdentities(prior);
  // Both `dup` entries share the same hash+role but must get distinct
  // occurrence indices (0 and 1).
  const dupEntries = identities.filter((e) => e.h === identities[1].h && e.r === "user");
  assert.deepEqual(
    dupEntries.map((e) => e.o).sort(),
    [0, 1],
  );
});

test("no prior canonical -> reset with reason no-prior-canonical (first request in a session)", () => {
  const incoming = conv(4, "first");
  const result = classifyInsertion(incoming, null);
  assert.equal(result.action, "reset");
  assert.equal(result.resetReason, "no-prior-canonical");
  assert.equal(result.canonicalEntries.length, 4);
});

// =====================================================================
// Extension-level tests (env gate, persistence, telemetry)
// =====================================================================

test("gate off: CACHE_FIX_INSERTION_NORMALIZE unset -> passthrough byte-identical, no telemetry file written", async () => {
  const dir = await newTmp();
  try {
    const messages = conv(6, "gate-off");
    const body = { model: "claude-opus-4-7", messages };
    const before = JSON.stringify(body);

    let ctx;
    await withEnvAsync({ CACHE_FIX_INSERTION_NORMALIZE: undefined }, async () => {
      ctx = await runExt(body, { dir });
    });

    assert.equal(JSON.stringify(body), before, "body must be untouched when gate is off");
    assert.equal(ctx.meta.insertionNormalizeStats, undefined, "no telemetry when gate is off");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonical persistence round-trip: write, reload, continue (append-only across two requests)", async () => {
  const dir = await newTmp();
  try {
    const headers = { "x-claude-code-session-id": "sess-roundtrip" };
    const messages1 = conv(6, "rt");
    const body1 = { model: "claude-opus-4-7", messages: messages1 };

    let ctx1;
    await silenced(() =>
      withEnvAsync({ CACHE_FIX_INSERTION_NORMALIZE: "1" }, async () => {
        ctx1 = await runExt(body1, { headers, dir });
      }),
    );
    assert.equal(ctx1.meta.insertionNormalizeStats.action, "reset");
    assert.equal(ctx1.meta.insertionNormalizeStats.resetReason, "no-prior-canonical");

    // Second request: pure append of 2 more messages. Canonical was
    // persisted by request 1 — this call must reload it from disk (fresh
    // ctx, same extension module) rather than relying on in-memory state.
    const messages2 = messages1.concat(conv(2, "rt-tail"));
    const body2 = { model: "claude-opus-4-7", messages: messages2 };
    let ctx2;
    await silenced(() =>
      withEnvAsync({ CACHE_FIX_INSERTION_NORMALIZE: "1" }, async () => {
        ctx2 = await runExt(body2, { headers, dir });
      }),
    );
    assert.equal(ctx2.meta.insertionNormalizeStats.action, "append-only");
    assert.equal(ctx2.meta.insertionNormalizeStats.inserted, 2);
    assert.equal(JSON.stringify(body2.messages), JSON.stringify(messages2));

    // Third request: a real mid-history splice — must reload request 2's
    // persisted canonical (8 entries) and correctly detect the splice.
    // Insert BEFORE the last two canonical entries (not at the tail) so
    // this is a genuine splice, not ordinary append growth.
    const spliced = messages2
      .slice(0, 6)
      .concat([userMsg("late-splice")], messages2.slice(6));
    const body3 = { model: "claude-opus-4-7", messages: spliced };
    let ctx3;
    await silenced(() =>
      withEnvAsync({ CACHE_FIX_INSERTION_NORMALIZE: "1" }, async () => {
        ctx3 = await runExt(body3, { headers, dir });
      }),
    );
    assert.equal(ctx3.meta.insertionNormalizeStats.action, "normalized");
    assert.equal(ctx3.meta.insertionNormalizeStats.inserted, 1);
    assert.deepEqual(body3.messages.slice(0, messages2.length), messages2);
    assert.deepEqual(body3.messages[messages2.length], userMsg("late-splice"));

    // Telemetry file exists with 3 lines, one per action. No system prompt
    // was set on any of the three bodies and all three share one msgs[0], so
    // all three land in the same bucket. The key is DERIVED rather than
    // spelled out: it carries a conversation sub-key now, and hardcoding the
    // format made this test fail on a keying change that broke nothing.
    const key = resolveInsertionSessionKey(headers, body3.messages, body3.system);
    const telemetryFile = join(dir, "cache-fix-snapshots", `${key}-insertion-events.jsonl`);
    const lines = (await readFile(telemetryFile, "utf-8")).trim().split("\n");
    assert.equal(lines.length, 3);
    const actions = lines.map((l) => JSON.parse(l).action);
    assert.deepEqual(actions, ["reset", "append-only", "normalized"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session key resolution: session-id header takes precedence over content-hash fallback", () => {
  const messages = conv(4, "key");
  const withHeader = resolveInsertionSessionKey({ "x-claude-code-session-id": "abc123" }, messages);
  const withoutHeader = resolveInsertionSessionKey({}, messages);
  assert.notEqual(withHeader, withoutHeader);
  assert.ok(withHeader.startsWith("s-"));
  assert.ok(withoutHeader.startsWith("c-"));
});

// =====================================================================
// Sidecar sub-keying (threat-matrix row 14)
// =====================================================================

test("session key resolution: same session-id, different system prompt -> different sub-key", () => {
  const messages = conv(4, "sidecar-key");
  const headers = { "x-claude-code-session-id": "shared-sid" };
  const mainKey = resolveInsertionSessionKey(headers, messages, [{ type: "text", text: "You are Claude Code" }]);
  const sidecarKey = resolveInsertionSessionKey(headers, messages, [{ type: "text", text: "Generate a short title" }]);
  assert.notEqual(mainKey, sidecarKey);
  assert.ok(mainKey.startsWith("s-shared-sid-"));
  assert.ok(sidecarKey.startsWith("s-shared-sid-"));
});

test("session key resolution: same session-id + same system prompt -> same sub-key (stable across calls)", () => {
  const messages = conv(4, "stable-key");
  const headers = { "x-claude-code-session-id": "shared-sid-2" };
  const system = [{ type: "text", text: "You are Claude Code" }];
  const k1 = resolveInsertionSessionKey(headers, messages, system);
  const k2 = resolveInsertionSessionKey(headers, messages, system);
  assert.equal(k1, k2);
});

test("session key resolution: absent system prompt -> stable bucket, distinct from a present one", () => {
  const messages = conv(4, "nosys-key");
  const headers = { "x-claude-code-session-id": "shared-sid-3" };
  const withSystem = resolveInsertionSessionKey(headers, messages, [{ type: "text", text: "sys" }]);
  const withoutSystem = resolveInsertionSessionKey(headers, messages, undefined);
  assert.notEqual(withSystem, withoutSystem);
  assert.ok(withoutSystem.includes("-nosys-"));
  // Stable across calls — the absent-system bucket is a bucket, not a nonce.
  assert.equal(withoutSystem, resolveInsertionSessionKey(headers, messages, undefined));
});

// Regression guard: the system-prompt sub-key separates sidecar CLASSES, not
// the individual conversations within one class. Every subagent of a session
// runs the same agent system prompt, so keyed on (sid, system) alone they all
// shared one canonical and overwrote each other. Measured on real traffic
// before the conversation sub-key: one system-prompt bucket held 39 distinct
// conversations, and 100% of conversation switches within a bucket reset
// (60/60) versus 1% of same-conversation continuations.
test("session key resolution: same session-id AND same system prompt, different conversations -> different keys", () => {
  const headers = { "x-claude-code-session-id": "shared-sid-4" };
  const system = [{ type: "text", text: "You are a Claude agent." }];
  const a = resolveInsertionSessionKey(headers, conv(4, "agent-one"), system);
  const b = resolveInsertionSessionKey(headers, conv(4, "agent-two"), system);
  assert.notEqual(a, b);
  // Same conversation continuing (more messages appended) keeps its key —
  // otherwise every turn would look like a new conversation.
  const grown = resolveInsertionSessionKey(headers, conv(9, "agent-one"), system);
  assert.equal(a, grown);
});

// msgs[0] with STRING content must still yield a conversation identity:
// hashMessageContent covers block arrays only and returns null for strings,
// which collapsed every string-content conversation into one shared bucket
// (56 of 602 requests in the measured capture).
test("session key resolution: string-content msgs[0] gets a real conversation key, not a shared 'empty' bucket", () => {
  const headers = { "x-claude-code-session-id": "shared-sid-5" };
  const system = [{ type: "text", text: "sys" }];
  const strA = resolveInsertionSessionKey(headers, [{ role: "user", content: "alpha" }], system);
  const strB = resolveInsertionSessionKey(headers, [{ role: "user", content: "beta" }], system);
  assert.notEqual(strA, strB);
  assert.ok(!strA.endsWith("-empty"));
  // A genuinely contentless first message is the only "empty".
  const none = resolveInsertionSessionKey(headers, [{ role: "user" }], system);
  assert.ok(none.endsWith("-empty"));
});

// Compaction. Verified against real traffic 2026-07-28 (session 58c979ce):
// across the boundary the session-id and the system-prompt sub-key are
// unchanged while the conversation sub-key flips 0dc13516 -> 554180f8 —
//
//     n=780  1548 msgs  conv 0dc13516c44f88c7   (summarization call)
//     n=786     4 msgs  conv 554180f85a9a1528   (continuation)
//
// so a compacted thread is a NEW conversation to every stateful extension:
// fresh canonical, no reset, and `dropped-majority` is NEVER the compaction
// path. That is correct — compaction replaces messages[0], so the prefix
// changed at index 0 and no cached bytes survive by construction.
//
// Pinned here because the alternative was believed before it was checked,
// and because the property is load-bearing in the other direction too: if a
// future keying change made the continuation share the pre-compaction key,
// the 1548-message canonical would be applied to a 4-message history.
test("session key resolution: a compacted continuation is a NEW conversation, not a continuation", () => {
  const headers = { "x-claude-code-session-id": "shared-sid-compact" };
  const system = [{ type: "text", text: "You are Claude Code" }];

  const before = resolveInsertionSessionKey(headers, conv(40, "long-thread"), system);
  // What CC actually sends after compacting: a fresh short history whose
  // first message is the summary, NOT the original opening message.
  const compacted = [
    { role: "user", content: [{ type: "text", text: "This session is being continued... Summary: ..." }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ];
  const after = resolveInsertionSessionKey(headers, compacted, system);

  assert.notEqual(before, after, "the compacted thread must not inherit the pre-compaction canonical");
  // Only the conversation sub-key moves: same session, same system prompt.
  assert.ok(before.startsWith("s-shared-sid-compact-"));
  assert.ok(after.startsWith("s-shared-sid-compact-"));
  assert.equal(
    before.split("-").slice(0, -1).join("-"),
    after.split("-").slice(0, -1).join("-"),
    "session-id and system-prompt sub-key are unchanged across a compaction",
  );
  // And the post-compaction thread is itself stable as it grows.
  assert.equal(after, resolveInsertionSessionKey(headers, [...compacted, { role: "user", content: "next" }], system));
});

test("two interleaved streams under one session-id (main thread + sidecar) keep independent canonicals, neither thrashes the other", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "sess-interleave" };
  const mainSystem = [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }];
  const sidecarSystem = [{ type: "text", text: "Generate a concise 5-word title for this conversation." }];
  try {
    await silenced(() =>
      withEnvAsync({ CACHE_FIX_INSERTION_NORMALIZE: "1" }, async () => {
        // Main thread request 1: establishes canonical.
        const mainMessages1 = conv(6, "main");
        const mainBody1 = { model: "claude-opus-4-7", system: mainSystem, messages: mainMessages1 };
        const mainCtx1 = await runExt(mainBody1, { headers, dir });
        assert.equal(mainCtx1.meta.insertionNormalizeStats.action, "reset");
        assert.equal(mainCtx1.meta.insertionNormalizeStats.resetReason, "no-prior-canonical");

        // Sidecar request (title-gen), same session-id header, different
        // system prompt, entirely unrelated single-turn messages. Before
        // the fix this would have been compared against the main thread's
        // canonical and thrashed it to reset.
        const sidecarMessages = [userMsg("please title this conversation")];
        const sidecarBody = { model: "claude-haiku-4-5", system: sidecarSystem, messages: sidecarMessages };
        const sidecarCtx = await runExt(sidecarBody, { headers, dir });
        assert.equal(sidecarCtx.meta.insertionNormalizeStats.action, "reset");
        assert.equal(sidecarCtx.meta.insertionNormalizeStats.resetReason, "no-prior-canonical", "sidecar's own first-seen, not a thrash of the main thread's canonical");

        // Main thread request 2: pure append of 2 more messages. Must
        // reload MAIN'S OWN canonical (6 entries) from request 1 — not
        // reset, and not polluted by the sidecar call in between.
        const mainMessages2 = mainMessages1.concat(conv(2, "main-tail"));
        const mainBody2 = { model: "claude-opus-4-7", system: mainSystem, messages: mainMessages2 };
        const mainCtx2 = await runExt(mainBody2, { headers, dir });
        assert.equal(mainCtx2.meta.insertionNormalizeStats.action, "append-only", "main thread's canonical survived the interleaved sidecar call");
        assert.equal(mainCtx2.meta.insertionNormalizeStats.inserted, 2);

        // A second sidecar call (another title-gen turn, same system
        // prompt) similarly should not disturb, and should build its OWN
        // append-only history rather than resetting every time.
        const sidecarMessages2 = sidecarMessages.concat([assistantMsg("Title: proxy fixes")]);
        const sidecarBody2 = { model: "claude-haiku-4-5", system: sidecarSystem, messages: sidecarMessages2 };
        const sidecarCtx2 = await runExt(sidecarBody2, { headers, dir });
        assert.equal(sidecarCtx2.meta.insertionNormalizeStats.action, "append-only", "sidecar's own canonical persisted across its own turns");
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("old-format (pre-sub-key) state file is ignored gracefully -> treated as no-prior-canonical, not a crash", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "sess-oldformat" };
  const system = [{ type: "text", text: "You are Claude Code" }];
  try {
    // Simulate a leftover pre-sub-key state file at the OLD path (no
    // system sub-key suffix) — the new code never reads this path, so it
    // must be silently abandoned rather than erroring.
    const { mkdir: mkdirP, writeFile: writeFileP } = await import("node:fs/promises");
    const snapshotDir = join(dir, "cache-fix-snapshots");
    await mkdirP(snapshotDir, { recursive: true });
    await writeFileP(
      join(snapshotDir, "s-sess-oldformat-insertion-canon.json"),
      JSON.stringify({ entries: [{ h: "stale-hash", r: "user", o: 0 }] }),
    );

    await silenced(() =>
      withEnvAsync({ CACHE_FIX_INSERTION_NORMALIZE: "1" }, async () => {
        const messages = conv(4, "oldformat");
        const body = { model: "claude-opus-4-7", system, messages };
        const ctx = await runExt(body, { headers, dir });
        // New sub-keyed path has no file yet -> ordinary first-seen reset,
        // not a crash and not accidentally matching the stale entries.
        assert.equal(ctx.meta.insertionNormalizeStats.action, "reset");
        assert.equal(ctx.meta.insertionNormalizeStats.resetReason, "no-prior-canonical");
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// Fixture-driven repro: the 2026-07-27 14:05 shape
// =====================================================================

test("fixture insertion-1405: normalization yields the arrival-order serialization", async () => {
  const fixturePath = join(__dirname, "fixtures", "insertion-1405.json");
  const raw = await readFile(fixturePath, "utf-8");
  const fixture = JSON.parse(raw);

  const priorCanon = computeIdentities(fixture.priorMessages).map((e) => ({ h: e.h, r: e.r, o: e.o }));
  const result = classifyInsertion(fixture.incomingMessages, priorCanon);

  assert.equal(result.action, "normalized");
  assert.equal(result.inserted, 2);
  // Arrival-order serialization: prior canonical order first...
  assert.deepEqual(result.messages.slice(0, fixture.priorMessages.length), fixture.priorMessages);
  // ...then the two new entries in their incoming relative order.
  assert.deepEqual(result.messages[fixture.priorMessages.length].content[0].text, "queued-message: operator says pause before deploy");
  assert.deepEqual(
    result.messages[fixture.priorMessages.length + 1].content[0].text,
    "<system-reminder>\nThe task tools haven't been used recently.\n</system-reminder>",
  );
});

// =====================================================================
// String-content identity (regression, 2026-07-27)
// =====================================================================
//
// hashMessageContent returns null unless `content` is a block ARRAY, and CC
// sends many messages whose content is a plain string. The fallback identity
// used to be `noContent:${i}` — the array INDEX — so such a message's identity
// WAS its position. The first insertion ahead of one shifted it, the canonical
// lookup missed, and the classifier reset with "not-subsequence": the
// extension broke on exactly the event it exists to absorb. Live measurement
// that day: 83 index-keyed entries in one sub-key, 125 resets over 350
// requests.

test("string-content message keeps its identity when an insertion shifts its index", () => {
  const sys = (t) => ({ role: "system", content: t });   // string, not blocks
  const prior = [
    userMsg("q1"),
    { role: "assistant", content: [{ type: "text", text: "a1" }] },
    sys("sys-note"),
    userMsg("q2"),
  ];
  const priorCanon = computeIdentities(prior).map((e) => ({ h: e.h, r: e.r, o: e.o }));

  // Insert a mid-conversation system message BEFORE the string-content one,
  // shifting its index from 2 to 3.
  const incoming = [
    prior[0],
    sys("MID-TURN NOTE"),
    prior[1],
    prior[2],
    prior[3],
    { role: "assistant", content: [{ type: "text", text: "a2" }] },
  ];

  const result = classifyInsertion(incoming, priorCanon);
  assert.notEqual(result.action, "reset", `must not reset: ${result.resetReason ?? ""}`);
  assert.equal(result.action, "normalized");
});

test("string-content identity is content-derived, not positional", () => {
  const sys = (t) => ({ role: "system", content: t });
  const atTwo = computeIdentities([userMsg("a"), userMsg("b"), sys("same text")]);
  const atThree = computeIdentities([userMsg("a"), userMsg("b"), userMsg("c"), sys("same text")]);
  assert.equal(
    atTwo[2].h,
    atThree[3].h,
    "identical string content must hash identically regardless of position",
  );
  // Different content must still differ.
  const other = computeIdentities([sys("different text")]);
  assert.notEqual(atTwo[2].h, other[0].h);
});

test("a genuinely contentless message still falls back to the index", () => {
  const ids = computeIdentities([userMsg("a"), { role: "system" }]);
  assert.match(ids[1].h, /^noContent:1$/);
});

// =====================================================================
// Phase 3: volatile-block pinning + removal tolerance (classifyPinned)
// Directive: docs/directives/proxy-volatile-block-pinning.md
// =====================================================================

const REMINDER =
  "<system-reminder>\nPreToolUse:Agent hook additional context: Dispatch starting\n</system-reminder>";

function userWithReminder(text, reminder = REMINDER) {
  return {
    role: "user",
    content: [
      { type: "text", text },
      { type: "text", text: reminder },
    ],
  };
}

function pinCanon(messages) {
  return classifyPinned(messages, null).canonicalEntries;
}

test("pin: the attributed flip — reminder vanishing deep in history is absorbed, first-seen bytes forwarded", () => {
  // Request N: message 2 carries the hook reminder. Request N+1: same
  // message WITHOUT it (the measured 135k/182k shape).
  const withBlock = [userMsg("u0"), assistantMsg("a1"), userWithReminder("do it"), assistantMsg("a3")];
  const canon = pinCanon(withBlock);
  const flipped = [
    userMsg("u0"),
    assistantMsg("a1"),
    { role: "user", content: [{ type: "text", text: "do it" }, { type: "text", text: "" }] },
    assistantMsg("a3"),
    userMsg("next"),
  ];
  const result = classifyPinned(flipped, canon);
  assert.equal(result.action, "normalized", "flip absorbed, not reset");
  assert.equal(result.pinned, 1);
  assert.deepEqual(
    result.messages[2].content,
    [{ type: "text", text: "do it" }, { type: "text", text: REMINDER }],
    "first-seen bytes forwarded — byte-stable history",
  );
});

test("pin: flip back (reminder REAPPEARING) also forwards first-seen — both directions stable", () => {
  const without = [userMsg("u0"), assistantMsg("a1"),
    { role: "user", content: [{ type: "text", text: "do it" }] }, assistantMsg("a3")];
  const canon = pinCanon(without);
  const reappeared = [userMsg("u0"), assistantMsg("a1"), userWithReminder("do it"), assistantMsg("a3")];
  const result = classifyPinned(reappeared, canon);
  assert.equal(result.action, "normalized");
  assert.equal(result.pinned, 1);
  assert.deepEqual(
    result.messages[2].content,
    [{ type: "text", text: "do it" }],
    "no stored first-seen form (first-seen had no volatile block) -> volatile blocks stripped",
  );
});

test("pin: phase-2 baseline still resets on the same flip (the behavior being fixed)", () => {
  const withBlock = [userMsg("u0"), assistantMsg("a1"), userWithReminder("do it"), assistantMsg("a3")];
  const canon = computeIdentities(withBlock).map((e) => ({ h: e.h, r: e.r, o: e.o }));
  const flipped = [userMsg("u0"), assistantMsg("a1"),
    { role: "user", content: [{ type: "text", text: "do it" }] }, assistantMsg("a3")];
  const result = classifyInsertion(flipped, canon);
  assert.equal(result.action, "reset");
  assert.equal(result.resetReason, "not-subsequence");
});

test("pin: a NON-volatile content change is NOT absorbed — reset, correctness over savings", () => {
  const orig = [userMsg("u0"), assistantMsg("a1"), userMsg("original"), assistantMsg("a3")];
  const canon = pinCanon(orig);
  const edited = [userMsg("u0"), assistantMsg("a1"), userMsg("EDITED"), assistantMsg("a3")];
  const result = classifyPinned(edited, canon);
  assert.equal(result.action, "reset");
  assert.equal(result.resetReason, "edit-shaped");
});

// The edit test above and this one are a pair: both requests contain one drop
// and one splice, and only CO-LOCATION tells them apart. "Any drop + any
// splice = edit" was the shipped rule and it misfired on real traffic — an
// operator interrupt pruned the tail while a hook reminder migrated 24 indices
// away, which is a prune plus an insertion, not an edit. That false positive
// was the last remaining real reset in the measured corpora.
test("pin: an UNRELATED drop and splice in one request is not an edit — no reset", () => {
  const orig = [
    userMsg("u0"),
    assistantMsg("a1"),
    userMsg("u2"),
    assistantMsg("a3"),
    userMsg("u4"),
    assistantMsg("a5"),
    userMsg("tail-to-be-pruned"),
  ];
  const canon = pinCanon(orig);
  // Splice near the FRONT, prune at the TAIL — far apart, so neither can be a
  // replacement for the other.
  const next = [
    userMsg("u0"),
    assistantMsg("a1"),
    userMsg("SPLICED"),
    userMsg("u2"),
    assistantMsg("a3"),
    userMsg("u4"),
    assistantMsg("a5"),
  ];
  const result = classifyPinned(next, canon);
  assert.notEqual(result.action, "reset");
  assert.equal(result.dropped, 1);
  assert.equal(result.inserted, 1);
  // CC's order is preserved — the splice is not moved to the tail.
  assert.deepEqual(
    result.messages.map((m) => m.content[0].text),
    ["u0", "a1", "SPLICED", "u2", "a3", "u4", "a5"],
  );
});

// The other side of the discriminator: a splice landing in the gap left by a
// dropped entry IS an edit and must still reset, even with drop-tolerance on.
test("pin: a splice inside the dropped entry's gap IS an edit — reset", () => {
  const orig = [userMsg("u0"), assistantMsg("a1"), userMsg("original"), assistantMsg("a3")];
  const canon = pinCanon(orig);
  const edited = [userMsg("u0"), assistantMsg("a1"), userMsg("REPLACEMENT"), assistantMsg("a3")];
  const result = classifyPinned(edited, canon);
  assert.equal(result.action, "reset");
  assert.equal(result.resetReason, "edit-shaped");
});

test("pin: prune (context-management removal) — match survives, entries flagged dropped, no reset", () => {
  const full = conv(10, "prune");
  const canon = pinCanon(full);
  // Remove messages 2 and 3 (an old exchange), keep the rest, grow the tail.
  const pruned = [...full.slice(0, 2), ...full.slice(4), userMsg("new tail")];
  const result = classifyPinned(pruned, canon);
  assert.notEqual(result.action, "reset", "prune must not reset canonical");
  assert.equal(result.dropped, 2);
  const droppedEntries = result.canonicalEntries.filter((e) => e.d);
  assert.equal(droppedEntries.length, 2, "dropped entries kept in the file, flagged");
});

test("pin: phase-2 baseline resets on the same prune (the behavior being fixed)", () => {
  const full = conv(10, "prune2");
  const canon = computeIdentities(full).map((e) => ({ h: e.h, r: e.r, o: e.o }));
  const pruned = [...full.slice(0, 2), ...full.slice(4)];
  const result = classifyInsertion(pruned, canon);
  assert.equal(result.action, "reset");
});

test("pin: dropping the majority resets — a compaction is not a prune", () => {
  const full = conv(10, "compact");
  const canon = pinCanon(full);
  const compacted = [full[0], userMsg("summary of the rest")];
  const result = classifyPinned(compacted, canon);
  assert.equal(result.action, "reset");
  assert.equal(result.resetReason, "dropped-majority");
});

// THE positional-canonical regression guard. A mid-history splice must leave
// the canonical in WIRE order, so the next request is a plain append. Filing
// the new entry at the tail of the canonical instead (arrival order) made
// canonical and wire order disagree permanently: request 3 then failed the
// strictly-increasing check with not-subsequence. That was the mechanism
// behind every remaining real reset measured on live captures 2026-07-28.
test("pin: a mid-history splice stays in place — the NEXT request is append-only, not a reset", () => {
  const r1 = [userMsg("u0"), assistantMsg("a1"), userMsg("u2"), assistantMsg("a3")];
  let canon = pinCanon(r1);

  // CC splices INJECTED between a1 and u2.
  const r2 = [userMsg("u0"), assistantMsg("a1"), userMsg("INJECTED"), userMsg("u2"), assistantMsg("a3")];
  const res2 = classifyPinned(r2, canon);
  assert.equal(res2.action, "normalized");
  assert.equal(res2.inserted, 1);
  // Forwarded order is CC's order — the spliced entry is NOT moved to the tail.
  assert.deepEqual(
    res2.messages.map((m) => m.content[0].text),
    ["u0", "a1", "INJECTED", "u2", "a3"],
  );
  canon = res2.canonicalEntries;

  // CC keeps appending; the spliced entry stays where it was.
  const r3 = [...r2, assistantMsg("a4"), userMsg("u5")];
  const res3 = classifyPinned(r3, canon);
  assert.equal(res3.action, "append-only", "a settled splice must not re-classify");
  assert.deepEqual(
    res3.messages.map((m) => m.content[0].text),
    ["u0", "a1", "INJECTED", "u2", "a3", "a4", "u5"],
  );
});

test("pin: flip + prune combined in one request — both handled", () => {
  const msgs = [userMsg("u0"), assistantMsg("a1"), userWithReminder("deep"),
    assistantMsg("a3"), userMsg("u4"), assistantMsg("a5")];
  const canon = pinCanon(msgs);
  // Prune u4/a5, flip the reminder off, grow tail.
  const next = [userMsg("u0"), assistantMsg("a1"),
    { role: "user", content: [{ type: "text", text: "deep" }] },
    assistantMsg("a3"), userMsg("tail")];
  const result = classifyPinned(next, canon);
  assert.equal(result.action, "normalized");
  assert.equal(result.pinned, 1);
  assert.equal(result.dropped, 2);
  assert.deepEqual(result.messages[2].content[1], { type: "text", text: REMINDER });
});

test("pin: a message carrying cache_control is never rewritten", () => {
  const marked = {
    role: "user",
    content: [
      { type: "text", text: "tail msg", cache_control: { type: "ephemeral" } },
      { type: "text", text: REMINDER },
    ],
  };
  const msgs = [userMsg("u0"), assistantMsg("a1"), marked];
  const canon = pinCanon(msgs);
  const flipped = [userMsg("u0"), assistantMsg("a1"),
    { role: "user", content: [{ type: "text", text: "tail msg", cache_control: { type: "ephemeral" } }] },
    userMsg("new")];
  const result = classifyPinned(flipped, canon);
  assert.notEqual(result.action, "reset");
  assert.deepEqual(
    result.messages[2].content,
    [{ type: "text", text: "tail msg", cache_control: { type: "ephemeral" } }],
    "marker-carrying message forwarded as-is",
  );
});

test("pin: assistant messages keep phase-2 identity — an assistant content change still resets", () => {
  const msgs = [userMsg("u0"), assistantMsg("original"), userMsg("u2")];
  const canon = pinCanon(msgs);
  const changed = [userMsg("u0"), assistantMsg("CHANGED"), userMsg("u2")];
  const result = classifyPinned(changed, canon);
  assert.equal(result.action, "reset");
});

test("pin: tool_result blocks are never volatile even when reminder-shaped", () => {
  const tr = {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: REMINDER }],
  };
  assert.equal(isVolatileBlock(tr.content[0]), false);
});

test("pin: adjacency invariant enforced across pinned forwarding", () => {
  const msgs = [toolUseMsg("t1"), toolResultMsg("t1"), userMsg("u2")];
  const canon = pinCanon(msgs);
  const next = [toolUseMsg("t1"), toolResultMsg("t1"), userMsg("u2"), toolUseMsg("t2"), toolResultMsg("t2")];
  const result = classifyPinned(next, canon);
  assert.notEqual(result.action, "reset");
  assert.equal(validateToolAdjacency(result.messages), true);
});

test("pin: identical request is append-only with zero pins (idempotent)", () => {
  const msgs = [userMsg("u0"), assistantMsg("a1"), userWithReminder("stable")];
  const canon = pinCanon(msgs);
  const result = classifyPinned(msgs, canon);
  assert.equal(result.action, "append-only");
  assert.equal(result.pinned, 0);
  assert.equal(result.dropped, 0);
});

test("pin: mode marker isolates canon files — a plain-mode file is ignored under pin mode (one honest reset)", async () => {
  const dir = await newTmp();
  try {
    const body1 = { model: "m", system: [{ type: "text", text: "s" }], messages: conv(4, "mode") };
    // Write canon under phase-2.
    await withEnvAsync(
      { CACHE_FIX_INSERTION_NORMALIZE: "1", CACHE_FIX_VOLATILE_PIN: undefined },
      () => runExt(body1, { dir, headers: { "x-session-id": "mode-test" } }),
    );
    // Same session under pin mode: prior canon must NOT half-match.
    const body2 = { model: "m", system: [{ type: "text", text: "s" }], messages: conv(5, "mode") };
    const ctx = await withEnvAsync(
      { CACHE_FIX_INSERTION_NORMALIZE: "1", CACHE_FIX_VOLATILE_PIN: "1" },
      () => runExt(body2, { dir, headers: { "x-session-id": "mode-test" } }),
    );
    assert.equal(ctx.meta.insertionNormalizeStats.action, "reset");
    assert.equal(ctx.meta.insertionNormalizeStats.resetReason, "no-prior-canonical");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pin: end-to-end onRequest — flip absorbed and body mutated under the flag", async () => {
  const dir = await newTmp();
  const mk = (msgs) => ({ model: "m", system: [{ type: "text", text: "s" }], messages: msgs });
  try {
    await withEnvAsync(
      { CACHE_FIX_INSERTION_NORMALIZE: "1", CACHE_FIX_VOLATILE_PIN: "1" },
      () => runExt(mk([userMsg("u0"), assistantMsg("a1"), userWithReminder("deep"), assistantMsg("a3")]),
        { dir, headers: { "x-session-id": "e2e-pin" } }),
    );
    const flippedBody = mk([userMsg("u0"), assistantMsg("a1"),
      { role: "user", content: [{ type: "text", text: "deep" }] },
      assistantMsg("a3"), userMsg("go on")]);
    const ctx = await withEnvAsync(
      { CACHE_FIX_INSERTION_NORMALIZE: "1", CACHE_FIX_VOLATILE_PIN: "1" },
      () => runExt(flippedBody, { dir, headers: { "x-session-id": "e2e-pin" } }),
    );
    assert.equal(ctx.meta.insertionNormalizeStats.action, "normalized");
    assert.equal(ctx.meta.insertionNormalizeStats.pinned, 1);
    assert.deepEqual(ctx.body.messages[2].content[1], { type: "text", text: REMINDER });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pin: flag off -> classifyPinned never runs, phase-2 byte-identical behavior", async () => {
  const dir = await newTmp();
  const mk = (msgs) => ({ model: "m", system: [{ type: "text", text: "s" }], messages: msgs });
  try {
    await withEnvAsync(
      { CACHE_FIX_INSERTION_NORMALIZE: "1", CACHE_FIX_VOLATILE_PIN: undefined },
      () => runExt(mk([userMsg("u0"), assistantMsg("a1"), userWithReminder("deep")]),
        { dir, headers: { "x-session-id": "off-test" } }),
    );
    const flippedBody = mk([userMsg("u0"), assistantMsg("a1"),
      { role: "user", content: [{ type: "text", text: "deep" }] }]);
    const before = JSON.stringify(flippedBody.messages);
    const ctx = await withEnvAsync(
      { CACHE_FIX_INSERTION_NORMALIZE: "1", CACHE_FIX_VOLATILE_PIN: undefined },
      () => runExt(flippedBody, { dir, headers: { "x-session-id": "off-test" } }),
    );
    assert.equal(ctx.meta.insertionNormalizeStats.action, "reset");
    assert.equal(JSON.stringify(ctx.body.messages), before, "no mutation without the flag");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Pins survive a reset (threat-matrix row 22) ---
//
// Measured 2026-07-28: CC honestly replaced message 196,
// so reset(edit-shaped) was right and the cost belonged to 196+. But every
// reset returned without a `messages` field, so the caller forwarded the raw
// array and message 177 lost the first-seen <system-reminder> this extension
// had been restoring — our bytes changed at 177 where CC's were identical,
// starting the bust 19 messages early.
//
// The order model is what a reset abandons. The pins are not.
test("classifyPinned: a reset still forwards PINNED bytes for surviving identities", () => {
  const volatileBlock = { type: "text", text: "<system-reminder>\nhook note\n</system-reminder>" };
  const u0 = { role: "user", content: [{ type: "text", text: "turn 0" }, volatileBlock] };
  const a0 = assistantMsg("reply 0");
  const u1 = userMsg("turn 1");
  const a1 = assistantMsg("reply 1");

  // First request pins u0's first-seen form.
  const first = classifyPinned([u0, a0, u1, a1], null);
  assert.equal(first.resetReason, "no-prior-canonical");
  const canon = first.canonicalEntries;

  // CC drops the volatile block from u0 AND splices an assistant message
  // mid-history — the latter forces a reset that has nothing to do with u0.
  const u0NoBlock = userMsg("turn 0");
  const res = classifyPinned([u0NoBlock, a0, assistantMsg("SPLICED"), u1, a1], canon);

  assert.equal(res.action, "reset");
  assert.equal(res.resetReason, "assistant-interleaved");
  assert.ok(res.messages, "a reset must still carry the pinned array");
  assert.deepEqual(
    res.messages[0],
    u0,
    "u0 keeps its first-seen form — the reset is about ORDER, not decoration",
  );
  // Safety: substitution only — never a count, role or order change.
  assert.equal(res.messages.length, 5);
  assert.deepEqual(
    res.messages.map((m) => m.role),
    ["user", "assistant", "assistant", "user", "assistant"],
  );
});

test("BITE — without the carry-over the reset would un-pin the surviving message", () => {
  // Same setup, but assert the property that actually costs cache: the bytes
  // we forward for an UNCHANGED message must not move because some OTHER
  // message was edited.
  const volatileBlock = { type: "text", text: "<system-reminder>\nnote\n</system-reminder>" };
  const u0 = { role: "user", content: [{ type: "text", text: "u0" }, volatileBlock] };
  const a0 = { role: "assistant", content: [{ type: "text", text: "a0" }] };
  const canon = classifyPinned([u0, a0], null).canonicalEntries;

  const stripped = { role: "user", content: [{ type: "text", text: "u0" }] };
  const res = classifyPinned([stripped, { role: "assistant", content: [{ type: "text", text: "EDITED" }] }], canon);
  assert.notDeepEqual(
    res.messages[0],
    stripped,
    "forwarding CC's stripped form here is exactly the row-22 defect",
  );
});
