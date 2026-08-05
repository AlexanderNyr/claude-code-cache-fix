import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ext, {
  snapshotPrefix,
  buildSnapshot,
  computeDiff,
  computeSessionKey,
  resolveSessionKey,
  tenantId,
  truncatePrefixMessages,
  truncateTailMessages,
  buildMarkerSnapshot,
  buildSystemSnapshot,
  buildToolsSnapshot,
  buildMessageHashes,
  messageTextPreview,
  diffSystemBlocks,
  diffTools,
  diffParams,
  diffMessageHashes,
  summariseCauses,
  buildEventRecord,
  diffHasChanges,
  buildBetaHeaderSnapshot,
  diffBetaHeader,
  TAP_ORDER,
  TAP_VIEW,
} from "../proxy/extensions/prefix-diff.mjs";

// `import.meta.dirname` requires Node 20.11+; CI matrix includes Node 18,
// so derive the directory from import.meta.url for portability.
const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Helpers ---

async function newTmp() {
  return mkdtemp(join(tmpdir(), "prefix-diff-test-"));
}

function makePayload({
  system = [{ type: "text", text: "you are claude" }],
  tools = [{ name: "Read" }, { name: "Bash" }],
  messages = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ],
} = {}) {
  return { system, tools, messages };
}

async function listFiles(dir) {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

// Capture stderr from a function. Restores before returning.
async function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join("");
}

// --- Pure helper tests ---

test("computeSessionKey is deterministic and 12 chars", () => {
  const sys = [{ type: "text", text: "you are claude" }];
  const k1 = computeSessionKey(sys);
  const k2 = computeSessionKey(sys);
  assert.equal(k1, k2);
  assert.equal(k1.length, 12);
});

test("computeSessionKey differs for different system content", () => {
  const a = computeSessionKey([{ type: "text", text: "system A" }]);
  const b = computeSessionKey([{ type: "text", text: "system B" }]);
  assert.notEqual(a, b);
});

test("truncatePrefixMessages strips cache_control from blocks", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
        { type: "text", text: "world" },
      ],
    },
  ];
  const out = truncatePrefixMessages(messages);
  assert.equal(out[0].content[0].text, "hello");
  assert.equal(out[0].content[0].cache_control, undefined);
  assert.equal(out[0].content[1].cache_control, undefined);
});

test("truncatePrefixMessages truncates text >500 chars with N marker", () => {
  const longText = "x".repeat(600);
  const messages = [
    { role: "user", content: [{ type: "text", text: longText }] },
  ];
  const out = truncatePrefixMessages(messages);
  const t = out[0].content[0].text;
  assert.equal(t.length, 500 + `...[600 chars]`.length);
  assert.ok(t.endsWith("...[600 chars]"));
  assert.ok(t.startsWith("xxxxxxxxxx"));
});

test("truncatePrefixMessages keeps short text untouched", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "short" }] },
  ];
  const out = truncatePrefixMessages(messages);
  assert.equal(out[0].content[0].text, "short");
});

test("truncatePrefixMessages slices to first 5 messages", () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `msg ${i}` }],
  }));
  const out = truncatePrefixMessages(messages);
  assert.equal(out.length, 5);
  assert.equal(out[4].content[0].text, "msg 4");
});

// --- Tail window tests ---

test("truncateTailMessages slices to last 3 messages", () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `msg ${i}` }],
  }));
  const out = truncateTailMessages(messages);
  assert.equal(out.length, 3);
  assert.equal(out[0].content[0].text, "msg 7");
  assert.equal(out[2].content[0].text, "msg 9");
});

test("truncateTailMessages applies the same truncation rules as the head window", () => {
  const longText = "y".repeat(600);
  const messages = [
    { role: "user", content: [{ type: "text", text: "short" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: longText, cache_control: { type: "ephemeral" } },
      ],
    },
  ];
  const out = truncateTailMessages(messages);
  assert.equal(out[1].content[0].cache_control, undefined);
  assert.ok(out[1].content[0].text.endsWith("...[600 chars]"));
});

test("truncateTailMessages handles fewer than 3 messages", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "only" }] }];
  const out = truncateTailMessages(messages);
  assert.equal(out.length, 1);
});

// --- Marker window tests ---

test("buildMarkerSnapshot returns empty array when no messages carry cache_control", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ];
  assert.deepEqual(buildMarkerSnapshot(messages), []);
});

test("buildMarkerSnapshot picks up messages carrying a cache_control block, in order", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "no marker" }] },
    {
      role: "user",
      content: [
        { type: "text", text: "marked one", cache_control: { type: "ephemeral" } },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "no marker either" }] },
    {
      role: "user",
      content: [
        { type: "text", text: "marked two", cache_control: { type: "ephemeral" } },
      ],
    },
  ];
  const markers = buildMarkerSnapshot(messages);
  assert.equal(markers.length, 2);
  assert.equal(markers[0].index, 1);
  assert.equal(markers[1].index, 3);
  assert.equal(typeof markers[0].hash, "string");
  assert.ok(markers[0].textPreview.includes("marked one"));
});

test("buildMarkerSnapshot caps at 8 stored markers even with more in the array", () => {
  const messages = Array.from({ length: 12 }, (_, i) => ({
    role: "user",
    content: [
      { type: "text", text: `m${i}`, cache_control: { type: "ephemeral" } },
    ],
  }));
  const markers = buildMarkerSnapshot(messages);
  assert.equal(markers.length, 8);
  assert.equal(markers[0].index, 0);
  assert.equal(markers[7].index, 7);
});

test("buildMarkerSnapshot hash changes when marked message content changes", () => {
  const markedMsg = (text) => ({
    role: "user",
    content: [{ type: "text", text, cache_control: { type: "ephemeral" } }],
  });
  const a = buildMarkerSnapshot([markedMsg("v1")]);
  const b = buildMarkerSnapshot([markedMsg("v2")]);
  assert.notEqual(a[0].hash, b[0].hash);
});

test("buildMarkerSnapshot hash strips cache_control before hashing (marker presence alone isn't a diff)", () => {
  const a = buildMarkerSnapshot([
    {
      role: "user",
      content: [{ type: "text", text: "same", cache_control: { type: "ephemeral" } }],
    },
  ]);
  const b = buildMarkerSnapshot([
    {
      role: "user",
      content: [
        { type: "text", text: "same", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
    },
  ]);
  assert.equal(a[0].hash, b[0].hash);
});

test("buildSnapshot returns null when payload has no system", () => {
  assert.equal(buildSnapshot({ messages: [] }), null);
  assert.equal(buildSnapshot({ system: null }), null);
  assert.equal(buildSnapshot({}), null);
});

test("buildSnapshot includes systemHash, toolsHash, messageCount, prefixMessages", () => {
  const snap = buildSnapshot(makePayload());
  assert.equal(typeof snap.timestamp, "string");
  assert.equal(snap.messageCount, 2);
  assert.equal(snap.toolsHash.length, 16);
  assert.equal(snap.systemHash.length, 16);
  assert.equal(snap.prefixMessages.length, 2);
});

test("buildSnapshot includes tailMessages and markerMessages windows", () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    role: "user",
    content: [{ type: "text", text: `msg ${i}` }],
  }));
  messages[6].content[0].cache_control = { type: "ephemeral" };
  const snap = buildSnapshot(makePayload({ messages }));
  assert.equal(snap.tailMessages.length, 3);
  assert.equal(snap.tailMessages[2].content[0].text, "msg 9");
  assert.equal(snap.markerMessages.length, 1);
  assert.equal(snap.markerMessages[0].index, 6);
});

test("computeDiff: identical snapshots → no differences", () => {
  const snap = buildSnapshot(makePayload());
  const diff = computeDiff(snap, snap);
  assert.equal(diff.prefixDiffs.length, 0);
  assert.equal(diff.toolsMatch, true);
  assert.equal(diff.systemMatch, true);
  assert.equal(diffHasChanges(diff), false);
});

test("computeDiff: tools/system hash mismatch flips the corresponding flag", () => {
  const a = buildSnapshot(makePayload());
  const b = buildSnapshot(
    makePayload({ tools: [{ name: "Read" }, { name: "Edit" }] }),
  );
  const diff = computeDiff(a, b);
  assert.equal(diff.toolsMatch, false);
  assert.equal(diff.systemMatch, true);
  assert.equal(diffHasChanges(diff), true);
});

test("computeDiff: differing prefixMessages produce indexed diff entries", () => {
  const a = buildSnapshot(makePayload());
  const b = buildSnapshot(
    makePayload({
      messages: [
        { role: "user", content: [{ type: "text", text: "DIFFERENT" }] },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
      ],
    }),
  );
  const diff = computeDiff(a, b);
  assert.equal(diff.prefixDiffs.length, 1);
  assert.equal(diff.prefixDiffs[0].index, 0);
});

test("computeDiff: tail window catches a change outside the head window's first 5 messages", () => {
  // The blind-spot regression: a long session where the change lands past
  // index 5 must NOT report 0 differences just because the head window
  // (first 5 messages) is unaffected.
  const longSession = (tailText) =>
    makePayload({
      messages: [
        ...Array.from({ length: 7 }, (_, i) => ({
          role: "user",
          content: [{ type: "text", text: `head-stable ${i}` }],
        })),
        { role: "user", content: [{ type: "text", text: tailText }] },
      ],
    });
  const a = buildSnapshot(longSession("original tail"));
  const b = buildSnapshot(longSession("BUSTED tail"));
  const diff = computeDiff(a, b);
  assert.equal(diff.prefixDiffs.length, 0, "head window is unaffected by design");
  assert.ok(diff.tailDiffs.length > 0, "tail window must catch the change");
  assert.equal(diffHasChanges(diff), true);
});

test("computeDiff: marker window catches a change at a cache_control boundary outside head/tail", () => {
  const messages = (markerText) => [
    ...Array.from({ length: 5 }, (_, i) => ({
      role: "user",
      content: [{ type: "text", text: `head ${i}` }],
    })),
    {
      role: "user",
      content: [
        { type: "text", text: markerText, cache_control: { type: "ephemeral" } },
      ],
    },
    ...Array.from({ length: 20 }, (_, i) => ({
      role: "user",
      content: [{ type: "text", text: `filler ${i}` }],
    })),
  ];
  const a = buildSnapshot(makePayload({ messages: messages("marker v1") }));
  const b = buildSnapshot(makePayload({ messages: messages("marker v2") }));
  const diff = computeDiff(a, b);
  assert.equal(diff.prefixDiffs.length, 0, "head window doesn't reach the marker");
  assert.equal(diff.tailDiffs.length, 0, "tail window doesn't reach the marker either");
  assert.equal(diff.markerDiffs.length, 1);
  assert.equal(diff.markerDiffs[0].index, 5);
  assert.equal(diffHasChanges(diff), true);
});

test("computeDiff: identical marker/tail windows produce no marker/tail diffs", () => {
  const snap = buildSnapshot(makePayload());
  const diff = computeDiff(snap, snap);
  assert.equal(diff.tailDiffs.length, 0);
  assert.equal(diff.markerDiffs.length, 0);
  assert.equal(diff.markerCount, 0);
});

test("computeDiff: messageCount change is reflected", () => {
  const a = buildSnapshot(makePayload());
  const b = buildSnapshot(
    makePayload({
      messages: [...makePayload().messages, { role: "user", content: [{ type: "text", text: "third" }] }],
    }),
  );
  const diff = computeDiff(a, b);
  assert.equal(diff.messageCountPrev, 2);
  assert.equal(diff.messageCountNow, 3);
  assert.equal(diffHasChanges(diff), true);
});

// --- Integration tests on snapshotPrefix ---

test("snapshotPrefix: returns null when no system", async () => {
  const dir = await newTmp();
  try {
    const result = await snapshotPrefix({ messages: [] }, { dir });
    assert.equal(result, null);
    assert.deepEqual(await listFiles(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshotPrefix: writes <key>-last.json on first invocation", async () => {
  const dir = await newTmp();
  try {
    const payload = makePayload();
    const result = await snapshotPrefix(payload, { dir });
    assert.ok(result?.wroteSnapshot);
    assert.equal(result.wroteDiff, false);
    const expected = `${result.key}-last.json`;
    const files = await listFiles(dir);
    assert.deepEqual(files, [expected]);
    // The file holds one baseline per tenant (co-tenants share a session id).
    const json = JSON.parse(await readFile(join(dir, expected), "utf-8"));
    assert.equal(json.tenants[json.lastTenant].messageCount, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshotPrefix: identical second call rewrites last.json, no diff file", async () => {
  const dir = await newTmp();
  try {
    const payload = makePayload();
    const r1 = await snapshotPrefix(payload, { dir });
    const r2 = await snapshotPrefix(payload, { dir });
    assert.ok(r2.wroteSnapshot);
    assert.equal(r2.wroteDiff, false);
    const files = await listFiles(dir);
    assert.deepEqual(files, [`${r1.key}-last.json`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshotPrefix: differing second call writes <key>-diff.json with prefixDiffs", async () => {
  const dir = await newTmp();
  try {
    const r1 = await snapshotPrefix(makePayload(), { dir });
    // Suppress the success-summary stderr write during the diff call.
    let r2;
    await captureStderr(async () => {
      r2 = await snapshotPrefix(
        makePayload({
          messages: [
            { role: "user", content: [{ type: "text", text: "CHANGED" }] },
            { role: "assistant", content: [{ type: "text", text: "hi" }] },
          ],
        }),
        { dir },
      );
    });
    assert.ok(r2.wroteSnapshot);
    assert.ok(r2.wroteDiff);
    const files = await listFiles(dir);
    // The events ledger is written alongside the detail file (see design
    // note 2 — the detail file alone was self-erasing).
    assert.deepEqual(files, [
      `${r1.key}-diff.json`,
      `${r1.key}-events.jsonl`,
      `${r1.key}-last.json`,
    ]);
    const diff = JSON.parse(await readFile(join(dir, `${r1.key}-diff.json`), "utf-8"));
    assert.ok(diff.prefixDiffs.length > 0);
    assert.equal(diff.prefixDiffs[0].index, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshotPrefix: rename failure leaves prior last.json intact", async () => {
  const dir = await newTmp();
  try {
    // Seed a known prior snapshot
    const payload = makePayload();
    await snapshotPrefix(payload, { dir });
    const key = computeSessionKey(payload.system);
    const lastPath = join(dir, `${key}-last.json`);
    const priorContent = await readFile(lastPath, "utf-8");

    // Now monkey-patch rename to throw; both diff and snapshot writes hit it
    const failingFs = {
      rename: async () => {
        throw new Error("simulated rename failure");
      },
    };

    let result;
    await captureStderr(async () => {
      result = await snapshotPrefix(
        makePayload({
          messages: [
            { role: "user", content: [{ type: "text", text: "CHANGED" }] },
          ],
        }),
        { dir, fs: failingFs },
      );
    });
    assert.equal(result.wroteSnapshot, false);
    assert.equal(result.wroteDiff, false);
    // Prior snapshot must still match what we seeded
    const after = await readFile(lastPath, "utf-8");
    assert.equal(after, priorContent);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshotPrefix: corrupt prior snapshot is treated as no-prior", async () => {
  const dir = await newTmp();
  try {
    const payload = makePayload();
    const key = computeSessionKey(payload.system);
    const lastPath = join(dir, `${key}-last.json`);
    // Write garbage that is not valid JSON
    await writeFile(lastPath, "{not json", "utf-8");

    let result;
    await captureStderr(async () => {
      result = await snapshotPrefix(payload, { dir });
    });
    assert.ok(result.wroteSnapshot);
    assert.equal(result.wroteDiff, false);
    // Last.json should now be valid JSON
    const json = JSON.parse(await readFile(lastPath, "utf-8"));
    assert.equal(json.tenants[json.lastTenant].messageCount, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshotPrefix: concurrent invocations both succeed; final snapshot matches one of the two payloads", async () => {
  const dir = await newTmp();
  try {
    const payloadA = makePayload();
    const payloadB = makePayload({
      messages: [
        { role: "user", content: [{ type: "text", text: "OTHER" }] },
      ],
    });
    let results;
    await captureStderr(async () => {
      results = await Promise.all([
        // contentEnabled:true so the written snapshot's shape matches the
        // buildSnapshot(payloadA/B) comparison calls below, which also
        // default to content-enabled — otherwise the two shapes diverge
        // (default mode omits prefixMessages' text) for reasons unrelated
        // to the concurrency behaviour this test actually checks.
        snapshotPrefix(payloadA, { dir, contentEnabled: true }),
        snapshotPrefix(payloadB, { dir, contentEnabled: true }),
      ]);
    });
    // Both same key (same system), so both write to same last.json
    assert.equal(results[0].key, results[1].key);
    // At least one succeeded (the other may have lost the rename race)
    assert.ok(results.some((r) => r.wroteSnapshot));
    // Final last.json must be valid JSON (no torn write)
    const lastPath = join(dir, `${results[0].key}-last.json`);
    const json = JSON.parse(await readFile(lastPath, "utf-8"));
    // Stronger: the final file must equal one of the two candidate snapshots
    // — not a mix of A and B, not a corrupt partial.
    const snapshotA = buildSnapshot(payloadA);
    const snapshotB = buildSnapshot(payloadB);
    // Timestamps are generated at build time and will differ; compare the
    // deterministic content fields (prefixMessages + counts/hashes).
    const deterministic = ({ prefixMessages, messageCount, toolsHash, systemHash }) => ({
      prefixMessages,
      messageCount,
      toolsHash,
      systemHash,
    });
    const actual = JSON.stringify(deterministic(json.tenants[json.lastTenant]));
    assert.ok(
      actual === JSON.stringify(deterministic(snapshotA)) ||
        actual === JSON.stringify(deterministic(snapshotB)),
      "final snapshot content must match exactly one of the two candidate payloads",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshotPrefix: hot-reload — re-importing module preserves disk-based diff behavior", async () => {
  const dir = await newTmp();
  try {
    // Use the already-imported snapshotPrefix for the seed
    const payloadV1 = makePayload();
    await snapshotPrefix(payloadV1, { dir });

    // Re-import the module with cache-busting query string
    const url =
      pathToFileURL(
        join(__dirname, "..", "proxy", "extensions", "prefix-diff.mjs"),
      ).href + "?reload=" + Date.now();
    const reloaded = await import(url);

    // Use the freshly-imported snapshotPrefix with a mutated payload
    let result;
    await captureStderr(async () => {
      result = await reloaded.snapshotPrefix(
        makePayload({
          messages: [
            { role: "user", content: [{ type: "text", text: "POST_RELOAD_CHANGE" }] },
          ],
        }),
        { dir },
      );
    });
    assert.ok(result.wroteDiff, "diff should fire across module re-imports");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshotPrefix: mkdir failure with debug=1 logs but does not throw", async () => {
  const dir = await newTmp();
  const prevDebug = process.env.CACHE_FIX_DEBUG;
  try {
    // DEBUG is read at module-import time, so to test the logging path
    // deterministically we set the env var then re-import the module with
    // a cache-busting query string. This mirrors the hot-reload test.
    process.env.CACHE_FIX_DEBUG = "1";
    const url =
      pathToFileURL(
        join(__dirname, "..", "proxy", "extensions", "prefix-diff.mjs"),
      ).href + "?debugReload=" + Date.now();
    const reloaded = await import(url);

    const failingFs = {
      mkdir: async () => {
        throw new Error("simulated mkdir failure");
      },
    };
    const stderr = await captureStderr(async () => {
      const result = await reloaded.snapshotPrefix(makePayload(), {
        dir: join(dir, "subdir"),
        fs: failingFs,
      });
      assert.equal(result.wroteSnapshot, false);
      assert.equal(result.wroteDiff, false);
    });
    // With DEBUG=1 at import time, the mkdir failure MUST be logged.
    assert.ok(
      stderr.includes("mkdir failed") && stderr.includes("simulated mkdir failure"),
      `expected mkdir failure in stderr, got: ${JSON.stringify(stderr)}`,
    );
  } finally {
    if (prevDebug === undefined) delete process.env.CACHE_FIX_DEBUG;
    else process.env.CACHE_FIX_DEBUG = prevDebug;
    await rm(dir, { recursive: true, force: true });
  }
});

// --- default.onRequest tests ---

test("default.onRequest: no-op when CACHE_FIX_PREFIXDIFF unset (module-time check)", async () => {
  // The extension reads ENABLED at module import time. If the env var was
  // unset when the test process started, ext.onRequest is a no-op regardless
  // of what we do at test time. We assert that calling onRequest does not
  // throw and does not mutate ctx.body.
  const ctx = { body: makePayload() };
  const before = JSON.stringify(ctx.body);
  await ext.onRequest(ctx);
  const after = JSON.stringify(ctx.body);
  assert.equal(after, before);
});

test("default.onRequest: never mutates ctx.body", async () => {
  const ctx = { body: makePayload() };
  const before = JSON.stringify(ctx.body);
  await ext.onRequest(ctx);
  const after = JSON.stringify(ctx.body);
  assert.equal(after, before);
});

test("default.onRequest: tolerates missing ctx and missing body", async () => {
  await ext.onRequest({});
  await ext.onRequest({ body: null });
  // No throw = pass
  assert.ok(true);
});

test("default has correct extension contract metadata", () => {
  assert.equal(ext.name, "prefix-diff");
  assert.equal(ext.order, 680);
  assert.equal(typeof ext.onRequest, "function");
  assert.equal(typeof ext.description, "string");
});

// --- Blind-spot regressions (2026-07-27) ---
//
// Each test below pins one way the diagnostic used to report nothing, or
// something misleading, on a real cache bust. They are regressions in the
// strict sense: the old implementation fails every one of them.

// Blind spot 1: the storage key was derived from `system`, so a change
// inside the first 2000 chars moved the key, missed the prior snapshot,
// and produced NO diff and NO log line at all.
test("resolveSessionKey: stays stable when the system prompt changes", () => {
  const headers = { "x-claude-code-session-id": "abc-123" };
  const k1 = resolveSessionKey(headers, [{ type: "text", text: "system v1" }]);
  const k2 = resolveSessionKey(headers, [{ type: "text", text: "system v2 TOTALLY DIFFERENT" }]);
  assert.equal(k1, k2, "session-keyed storage must not move when content changes");
});

test("resolveSessionKey: differs per session id", () => {
  const sys = [{ type: "text", text: "same" }];
  const a = resolveSessionKey({ "x-claude-code-session-id": "aaa" }, sys);
  const b = resolveSessionKey({ "x-claude-code-session-id": "bbb" }, sys);
  assert.notEqual(a, b);
});

test("resolveSessionKey: falls back to the content hash without headers", () => {
  const sys = [{ type: "text", text: "no headers here" }];
  assert.equal(resolveSessionKey(null, sys), computeSessionKey(sys));
});

// Blind spot 6 (2026-07-27): co-tenants on ONE session id. A main session,
// its subagents, and Claude Code's background calls share the session-id
// header. With a single baseline per session they diffed against each
// other, so conversations advancing normally rendered as prefix churn —
// misread that day as the cause of a 93k bust it had no part in.
test("snapshotPrefix: co-tenants on one session id do not diff against each other", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "shared-session" };
  const main = (text) =>
    makePayload({
      system: [{ type: "text", text: "You are an interactive agent" }],
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    });
  const sub = (text) =>
    makePayload({
      system: [{ type: "text", text: "You are a subagent with a task brief" }],
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    });
  try {
    await snapshotPrefix(main("turn 1"), { dir, headers });
    // The subagent's FIRST request has no baseline of its own. The diff
    // against the main session's snapshot is kept (a system-prompt change
    // in ONE conversation looks identical, and dropping it would hide a
    // real bust) but must be MARKED, so it is never read as a cause.
    let rSub, subErr;
    subErr = await captureStderr(async () => {
      rSub = await snapshotPrefix(sub("sub turn 1"), { dir, headers });
    });
    assert.ok(rSub.wroteDiff, "evidence is kept, not dropped");
    assert.match(String(subErr), /CROSS-TENANT/, "and it is labelled on stderr");
    const events = (await readFile(join(dir, `${rSub.key}-events.jsonl`), "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(events.at(-1).crossTenant, true, "and in the ledger");

    // Main advancing must still diff against MAIN's baseline, not the
    // subagent's — and must still be reported.
    let rMain;
    await captureStderr(async () => {
      rMain = await snapshotPrefix(main("turn 2"), { dir, headers });
    });
    assert.ok(rMain.wroteDiff, "the main session's own advance still diffs");

    // One file per session id: separation is inside the file, so the
    // path never moves (design note 1's blind spot stays closed).
    assert.equal(rSub.key, rMain.key);
    const json = JSON.parse(await readFile(join(dir, `${rMain.key}-last.json`), "utf-8"));
    assert.equal(Object.keys(json.tenants).length, 2, "both tenants keep a baseline");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tenantId: prefers the agent-id header over the system prompt", () => {
  const sysA = [{ type: "text", text: "prompt A" }];
  const sysB = [{ type: "text", text: "prompt B TOTALLY DIFFERENT" }];
  const hdr = { "x-claude-code-agent-id": "agent-7" };
  // Authoritative when present: an edited system prompt must not split a
  // conversation's baseline in two.
  assert.equal(tenantId(hdr, sysA), tenantId(hdr, sysB));
  // Distinct agents stay distinct even on an identical prompt.
  assert.notEqual(
    tenantId({ "x-claude-code-agent-id": "agent-8" }, sysA),
    tenantId(hdr, sysA),
  );
  // Absent (the common case — CC omits it for Workflow legs): fall back
  // to the system prompt.
  assert.notEqual(tenantId({}, sysA), tenantId({}, sysB));
  assert.equal(tenantId({}, sysA), tenantId(null, sysA));
});

test("snapshotPrefix: a system-prompt change still finds its prior snapshot (key stability)", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "resume-test" };
  try {
    await snapshotPrefix(makePayload({ system: [{ type: "text", text: "v1 prompt" }] }), {
      dir,
      headers,
    });
    let result;
    await captureStderr(async () => {
      result = await snapshotPrefix(
        makePayload({ system: [{ type: "text", text: "v2 prompt" }] }),
        { dir, headers },
      );
    });
    // The whole point: the diff MUST fire. Under the old key derivation
    // this wrote a fresh baseline under a new name and reported nothing.
    assert.ok(result.wroteDiff, "system change must still produce a diff");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Blind spot 2: `<key>-diff.json` was overwritten on every diff, so a
// bust's detail survived only until the next one.
test("snapshotPrefix: appends every diff to an events ledger that is never overwritten", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "ledger-test" };
  try {
    await snapshotPrefix(makePayload(), { dir, headers });
    await captureStderr(async () => {
      for (const text of ["change one", "change two", "change three"]) {
        await snapshotPrefix(
          makePayload({ messages: [{ role: "user", content: [{ type: "text", text }] }] }),
          { dir, headers },
        );
      }
    });
    const key = resolveSessionKey(headers, makePayload().system);
    const lines = (await readFile(join(dir, `${key}-events.jsonl`), "utf-8"))
      .trim()
      .split("\n");
    assert.equal(lines.length, 3, "each diff appends one record");
    for (const line of lines) {
      const rec = JSON.parse(line);
      assert.ok(rec.ts && Array.isArray(rec.causes));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Blind spot 3: toolsHash covered only names, so schema/description
// changes reported `tools=match` for a genuinely different payload.
test("buildToolsSnapshot: hashes full schemas, not just names", () => {
  const a = buildToolsSnapshot([{ name: "Read", input_schema: { a: 1 } }]);
  const b = buildToolsSnapshot([{ name: "Read", input_schema: { a: 2 } }]);
  assert.notEqual(a.hash, b.hash, "same name, different schema must not hash equal");
});

test("diffTools: names the tool and classifies the change", () => {
  const prev = buildToolsSnapshot([{ name: "Read", description: "old" }, { name: "Bash" }]);
  const now = buildToolsSnapshot([{ name: "Read", description: "new" }, { name: "Edit" }]);
  const diffs = diffTools(prev, now);
  const byName = Object.fromEntries(diffs.map((d) => [d.name, d.change]));
  assert.equal(byName.Read, "schema");
  assert.equal(byName.Bash, "removed");
  assert.equal(byName.Edit, "added");
});

test("diffTools: pure reordering is reported as reordered, not as churn", () => {
  const prev = buildToolsSnapshot([{ name: "A" }, { name: "B" }]);
  const now = buildToolsSnapshot([{ name: "B" }, { name: "A" }]);
  const diffs = diffTools(prev, now);
  assert.equal(diffs.length, 2);
  assert.ok(diffs.every((d) => d.change === "reordered"));
});

// Blind spot 4: one opaque systemHash answered "did it change" and
// nothing else — the exact wall a real investigation hit.
test("diffSystemBlocks: locates the changed block, its label, and the differing offset", () => {
  const mk = (envText) => [
    { type: "text", text: "You are Claude Code, an agent." },
    { type: "text", text: envText },
  ];
  const prev = buildSystemSnapshot(mk("<env>Working directory: /tmp\nToday: 2026-07-26</env>"));
  const now = buildSystemSnapshot(mk("<env>Working directory: /tmp\nToday: 2026-07-27</env>"));
  const diffs = diffSystemBlocks(prev, now);
  assert.equal(diffs.length, 1, "only the env block changed");
  assert.equal(diffs[0].index, 1);
  assert.equal(diffs[0].label, "env");
  assert.ok(diffs[0].charAt > 0, "reports where the divergence starts");
  assert.ok(
    diffs[0].prevWindow.includes("2026-07-26") && diffs[0].nowWindow.includes("2026-07-27"),
    "shows the bytes from both sides",
  );
});

test("buildSystemSnapshot: labels known Claude Code block shapes", () => {
  const blocks = buildSystemSnapshot([
    { type: "text", text: "You are Claude Code, an agent" },
    { type: "text", text: "<env>Platform: linux</env>" },
  ]);
  assert.equal(blocks[0].label, "cc-identity");
  assert.equal(blocks[1].label, "env");
});

test("buildSystemSnapshot: accepts a plain string system prompt", () => {
  const blocks = buildSystemSnapshot("plain string prompt");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "string");
});

// Coverage gap: top-level params were not snapshotted at all, so a model
// switch — a guaranteed cache-key change — read as "0 differences".
test("diffParams: a model switch is detected", () => {
  const a = buildSnapshot({ ...makePayload(), model: "claude-opus-5" });
  const b = buildSnapshot({ ...makePayload(), model: "claude-sonnet-5" });
  const diff = computeDiff(a, b);
  assert.equal(diff.paramDiffs.length, 1);
  assert.equal(diff.paramDiffs[0].key, "model");
  assert.equal(diffHasChanges(diff), true, "param-only change must count as a change");
});

test("diffParams: temperature and thinking config are tracked", () => {
  const a = buildSnapshot({ ...makePayload(), temperature: 1, thinking: { type: "enabled" } });
  const b = buildSnapshot({ ...makePayload(), temperature: 0, thinking: { type: "disabled" } });
  const keys = computeDiff(a, b).paramDiffs.map((d) => d.key).sort();
  assert.deepEqual(keys, ["temperature", "thinking"]);
});

// Coverage gap: head(5) + markers(8) + tail(3) left a long session's
// middle unobserved — a mutation there reported zero differences.
test("messageChain: catches a mutation in the middle, outside every window", () => {
  const build = (midText) =>
    makePayload({
      messages: Array.from({ length: 60 }, (_, i) => ({
        role: "user",
        content: [{ type: "text", text: i === 30 ? midText : `msg ${i}` }],
      })),
    });
  const a = buildSnapshot(build("original middle"));
  const b = buildSnapshot(build("MUTATED middle"));
  const diff = computeDiff(a, b);
  assert.equal(diff.prefixDiffs.length, 0, "head window cannot see index 30");
  assert.equal(diff.tailDiffs.length, 0, "tail window cannot see index 30");
  assert.equal(diff.markerDiffs.length, 0, "no cache_control markers present");
  assert.equal(diff.messageChain.firstDivergentIndex, 30);
  assert.equal(diffHasChanges(diff), true);
});

test("messageChain: a normal append is flagged appendOnly with no divergence", () => {
  const base = makePayload();
  const a = buildSnapshot(base);
  const b = buildSnapshot(
    makePayload({
      messages: [...base.messages, { role: "user", content: [{ type: "text", text: "next" }] }],
    }),
  );
  const chain = computeDiff(a, b).messageChain;
  assert.equal(chain.firstDivergentIndex, -1);
  assert.equal(chain.appendOnly, true);
});

// Every content shape a request can carry must yield a non-null preview —
// null previews are exactly what made the 2026-07-28 37k bust
// unattributable (all divergent messages were tool-shaped).
test("messageTextPreview: string content is previewed, not nulled", () => {
  const p = messageTextPreview({ role: "user", content: "plain string body" });
  assert.equal(p, "plain string body");
});

test("messageTextPreview: tool_use-only content names the tool and input", () => {
  const p = messageTextPreview({
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
  });
  assert.match(p, /tool_use:Bash/);
  assert.match(p, /"command":"ls"/);
});

test("messageTextPreview: tool_result-only content carries the result body", () => {
  const p = messageTextPreview({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "exit 0" }],
  });
  assert.match(p, /tool_result/);
  assert.match(p, /exit 0/);
});

test("messageTextPreview: tool_result error flag and block-array content survive", () => {
  const p = messageTextPreview({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "t1",
        is_error: true,
        content: [{ type: "text", text: "boom" }],
      },
    ],
  });
  assert.match(p, /tool_result:error/);
  assert.match(p, /boom/);
});

test("messageTextPreview: thinking blocks are marked present but redacted", () => {
  const p = messageTextPreview({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "secret reasoning bytes" },
      { type: "text", text: "visible" },
    ],
  });
  assert.match(p, /\[thinking\]/);
  assert.match(p, /visible/);
  assert.doesNotMatch(p, /secret reasoning/);
});

test("messageTextPreview: unknown block types name their type", () => {
  const p = messageTextPreview({
    role: "user",
    content: [{ type: "image", source: { type: "base64", data: "AAAA" } }],
  });
  assert.match(p, /\[image\]/);
});

test("messageTextPreview: still bounded and null only for shapeless input", () => {
  const p = messageTextPreview(
    { role: "user", content: "y".repeat(5000) },
    120,
  );
  assert.equal(p.length, 120);
  assert.equal(messageTextPreview(null), null);
  assert.equal(messageTextPreview({ role: "user" }), null);
});

test("buildMessageHashes: sees a change past 500 chars (no truncation blindness)", () => {
  const mk = (tail) => [
    { role: "user", content: [{ type: "text", text: "x".repeat(600) + tail }] },
  ];
  const a = buildMessageHashes(mk("A"));
  const b = buildMessageHashes(mk("B"));
  assert.notEqual(a[0].h, b[0].h, "hash chain must not truncate before hashing");
});

test("diffMessageHashes: truncation is distinguished from in-place mutation", () => {
  const long = buildMessageHashes(
    Array.from({ length: 5 }, (_, i) => ({ role: "user", content: [{ type: "text", text: `m${i}` }] })),
  );
  const short = long.slice(0, 3);
  const chain = diffMessageHashes(long, short);
  assert.equal(chain.firstDivergentIndex, -1, "shared prefix is intact");
  assert.equal(chain.appendOnly, false, "shrinking is not an append");
  assert.equal(chain.prevLength, 5);
  assert.equal(chain.nowLength, 3);
});

// The summary line is the artifact most reads stop at, so the cause must
// be legible there without opening any file.
test("summariseCauses: names the specific block, tool, param, and index", () => {
  const a = buildSnapshot({
    ...makePayload({ system: [{ type: "text", text: "<env>Today: A</env>" }] }),
    model: "claude-opus-5",
  });
  const b = buildSnapshot({
    ...makePayload({
      system: [{ type: "text", text: "<env>Today: B</env>" }],
      tools: [{ name: "Read", input_schema: { changed: true } }, { name: "Bash" }],
      messages: [{ role: "user", content: [{ type: "text", text: "different" }] }],
    }),
    model: "claude-sonnet-5",
  });
  const causes = summariseCauses(computeDiff(a, b)).join(" | ");
  assert.ok(causes.includes("params:model"), `expected model in: ${causes}`);
  assert.ok(causes.includes("system["), `expected system block in: ${causes}`);
  assert.ok(causes.includes("tools["), `expected tools in: ${causes}`);
  assert.ok(causes.includes("messages@0"), `expected message index in: ${causes}`);
});

// Tap points (dev-loop.md): a bare index was equated across tap points
// during the 587k attribution. Every record this module emits must name
// its own tap point, derived from the SAME order the extension itself
// registers under — never a second literal that could drift from it.
test("buildEventRecord: carries its tap-point view marker, single-sourced from the module's own order", () => {
  assert.equal(ext.order, TAP_ORDER, "the default export's order must be the single source TAP_VIEW derives from");
  assert.equal(TAP_VIEW, `forwarded@${TAP_ORDER}`);

  const a = buildSnapshot(makePayload({ system: [{ type: "text", text: "<env>A</env>" }] }));
  const b = buildSnapshot(makePayload({ system: [{ type: "text", text: "<env>B</env>" }] }));
  const rec = buildEventRecord(computeDiff(a, b), "key123", "sid-1");
  assert.equal(rec.view, TAP_VIEW, `expected tap-point view marker on the record, got ${JSON.stringify(rec.view)}`);
});

test("buildEventRecord: bounded — carries evidence without full message bodies", () => {
  const a = buildSnapshot(makePayload({ system: [{ type: "text", text: "<env>A</env>" }] }));
  const b = buildSnapshot(
    makePayload({
      system: [{ type: "text", text: "<env>B</env>" }],
      messages: [{ role: "user", content: [{ type: "text", text: "y".repeat(5000) }] }],
    }),
  );
  const rec = buildEventRecord(computeDiff(a, b), "key123", "sid-1");
  const serialized = JSON.stringify(rec);
  assert.ok(serialized.length < 8000, `record should stay small, got ${serialized.length}`);
  assert.ok(!serialized.includes("y".repeat(200)), "must not embed full message bodies");
  assert.equal(rec.sid, "sid-1");
  assert.ok(rec.system.length > 0, "but must carry the system-block evidence");
});

// Version-boundary safety: a snapshot written by the previous release has
// none of the new fields. Diffing across that boundary must degrade, not
// throw.
test("computeDiff: tolerates an old-format snapshot with no new fields", () => {
  const old = {
    timestamp: "2026-07-26T00:00:00.000Z",
    messageCount: 2,
    toolsHash: "abc",
    systemHash: "def",
    prefixMessages: [],
    tailMessages: [],
    markerMessages: [],
  };
  const current = buildSnapshot(makePayload());
  const diff = computeDiff(old, current);
  assert.ok(Array.isArray(diff.systemBlockDiffs));
  assert.ok(Array.isArray(diff.toolDiffs));
  assert.ok(Array.isArray(diff.paramDiffs));
  assert.equal(typeof diff.messageChain.firstDivergentIndex, "number");
});

test("snapshotPrefix: ledger append failure does not prevent the diff file", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "append-fail" };
  try {
    await snapshotPrefix(makePayload(), { dir, headers });
    const failingFs = {
      appendFile: async () => {
        throw new Error("simulated append failure");
      },
    };
    let result;
    await captureStderr(async () => {
      result = await snapshotPrefix(
        makePayload({ messages: [{ role: "user", content: [{ type: "text", text: "X" }] }] }),
        { dir, headers, fs: failingFs },
      );
    });
    assert.ok(result.wroteDiff, "detail file must still be written");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Prefix-diff's own blind spots (2026-07-27): output_config/speed/betas,
// and the anthropic-beta HEADER, are part of the cache key but were
// untracked — a bust from an effort change, fast-mode toggle, or beta-header
// drift was previously unattributable (bare messages@N or empty causes).

test("diffParams: an effort change inside output_config is detected", () => {
  const a = buildSnapshot({ ...makePayload(), output_config: { effort: "low" } });
  const b = buildSnapshot({ ...makePayload(), output_config: { effort: "high" } });
  const diff = computeDiff(a, b);
  assert.equal(diff.paramDiffs.length, 1);
  assert.equal(diff.paramDiffs[0].key, "output_config");
  assert.equal(diffHasChanges(diff), true);
  const causes = summariseCauses(diff).join(" | ");
  assert.ok(causes.includes("params:output_config"), `expected output_config in: ${causes}`);
});

test("diffParams: a speed (fast mode) change is detected", () => {
  const a = buildSnapshot({ ...makePayload(), speed: "standard" });
  const b = buildSnapshot({ ...makePayload(), speed: "fast" });
  const diff = computeDiff(a, b);
  assert.equal(diff.paramDiffs.length, 1);
  assert.equal(diff.paramDiffs[0].key, "speed");
  assert.equal(diffHasChanges(diff), true);
});

test("diffParams: a betas (body param) change is detected", () => {
  const a = buildSnapshot({ ...makePayload(), betas: ["fast-mode-2026-02-01"] });
  const b = buildSnapshot({ ...makePayload(), betas: ["fast-mode-2026-02-01", "context-1m-2025-08-07"] });
  const diff = computeDiff(a, b);
  assert.equal(diff.paramDiffs.length, 1);
  assert.equal(diff.paramDiffs[0].key, "betas");
});

test("buildBetaHeaderSnapshot: absent header normalizes to present:false, tokens:[]", () => {
  assert.deepEqual(buildBetaHeaderSnapshot(null), { present: false, tokens: [] });
  assert.deepEqual(buildBetaHeaderSnapshot({}), { present: false, tokens: [] });
});

test("buildBetaHeaderSnapshot: parses and sorts comma-separated tokens, case-insensitive header name", () => {
  const snap = buildBetaHeaderSnapshot({ "Anthropic-Beta": "b-token, a-token" });
  assert.equal(snap.present, true);
  assert.deepEqual(snap.tokens, ["a-token", "b-token"]);
});

test("diffBetaHeader: no change when the token set is identical (order-insensitive)", () => {
  const a = buildBetaHeaderSnapshot({ "anthropic-beta": "x, y" });
  const b = buildBetaHeaderSnapshot({ "anthropic-beta": "y, x" });
  const diff = diffBetaHeader(a, b);
  assert.deepEqual(diff, { added: [], removed: [] });
});

test("diffBetaHeader: detects an added and a removed token in the same change", () => {
  const a = buildBetaHeaderSnapshot({ "anthropic-beta": "context-1m-2025-08-07, fast-mode-2026-02-01" });
  const b = buildBetaHeaderSnapshot({ "anthropic-beta": "fast-mode-2026-02-01, task-budgets-2026-03-13" });
  const diff = diffBetaHeader(a, b);
  assert.deepEqual(diff.added, ["task-budgets-2026-03-13"]);
  assert.deepEqual(diff.removed, ["context-1m-2025-08-07"]);
});

test("computeDiff + summariseCauses: a beta-header-only change produces a header cause", () => {
  const a = buildSnapshot(makePayload(), { "anthropic-beta": "fast-mode-2026-02-01" });
  const b = buildSnapshot(makePayload(), { "anthropic-beta": "context-1m-2025-08-07" });
  const diff = computeDiff(a, b);
  assert.equal(diffHasChanges(diff), true, "a header-only change must count as a change");
  const causes = summariseCauses(diff).join(" | ");
  assert.ok(causes.includes("header:anthropic-beta"), `expected header cause in: ${causes}`);
  assert.ok(causes.includes("+context-1m-2025-08-07"), `expected added token in: ${causes}`);
  assert.ok(causes.includes("-fast-mode-2026-02-01"), `expected removed token in: ${causes}`);
});

test("computeDiff: identical beta headers produce no header cause and no spurious change", () => {
  const a = buildSnapshot(makePayload(), { "anthropic-beta": "context-1m-2025-08-07" });
  const b = buildSnapshot(makePayload(), { "anthropic-beta": "context-1m-2025-08-07" });
  const diff = computeDiff(a, b);
  assert.equal(diffHasChanges(diff), false);
  assert.deepEqual(diff.betaHeaderDiff, { added: [], removed: [] });
});

// Version-boundary safety, mirroring the existing "tolerates an old-format
// snapshot" test above: a snapshot written before this change has no
// `betaHeader` field at all. Diffing across that boundary must not throw,
// and — critically — must not report a spurious header cause just because
// the old side has no data to compare against.
test("computeDiff: old-format snapshot (no betaHeader field) migrates silently when neither side actually carries a header", () => {
  const old = {
    timestamp: "2026-07-26T00:00:00.000Z",
    messageCount: 2,
    toolsHash: "abc",
    systemHash: "def",
    prefixMessages: [],
    tailMessages: [],
    markerMessages: [],
    // no params, systemBlocks, toolsDetail, messageHashes, betaHeader — simulates
    // a snapshot from before ANY of the coverage additions, old and new alike.
  };
  // No anthropic-beta header on this request either — the pre-upgrade snapshot
  // and the first post-upgrade request agree there is nothing to report.
  const current = buildSnapshot(makePayload(), {});
  const diff = computeDiff(old, current);
  assert.deepEqual(diff.betaHeaderDiff, { added: [], removed: [] });
  assert.ok(!summariseCauses(diff).some((c) => c.startsWith("header:")));
});

// Distinguishes "no data on the old side" from "no header on either side":
// when the old snapshot predates beta-header tracking but the CURRENT
// request genuinely carries one, that's real new information the old
// snapshot has no way to rule out — it must surface, exactly as the
// pre-existing paramDiffs/toolDiffs/systemBlockDiffs helpers already do
// when their "old" side lacks the corresponding field (see the sibling
// "tolerates an old-format snapshot" test above, which asserts the arrays
// exist and doesn't claim they stay empty on a real underlying change).
test("computeDiff: old-format snapshot + a real header on the current request still surfaces as added", () => {
  const old = {
    timestamp: "2026-07-26T00:00:00.000Z",
    messageCount: 2,
    toolsHash: "abc",
    systemHash: "def",
    prefixMessages: [],
    tailMessages: [],
    markerMessages: [],
  };
  const current = buildSnapshot(makePayload(), { "anthropic-beta": "context-1m-2025-08-07" });
  const diff = computeDiff(old, current);
  assert.deepEqual(diff.betaHeaderDiff, { added: ["context-1m-2025-08-07"], removed: [] });
});

test("snapshotPrefix: a beta-header-only change on real requests fires a diff with a header cause", async () => {
  const dir = await newTmp();
  try {
    await snapshotPrefix(makePayload(), {
      dir,
      headers: { "x-claude-code-session-id": "beta-test", "anthropic-beta": "fast-mode-2026-02-01" },
    });
    let result;
    await captureStderr(async () => {
      result = await snapshotPrefix(makePayload(), {
        dir,
        headers: { "x-claude-code-session-id": "beta-test", "anthropic-beta": "context-1m-2025-08-07" },
      });
    });
    assert.ok(result.wroteDiff, "beta-header-only change must produce a diff");
    const key = resolveSessionKey({ "x-claude-code-session-id": "beta-test" }, makePayload().system);
    const diffJson = JSON.parse(await readFile(join(dir, `${key}-diff.json`), "utf-8"));
    assert.deepEqual(diffJson.betaHeaderDiff.added, ["context-1m-2025-08-07"]);
    assert.deepEqual(diffJson.betaHeaderDiff.removed, ["fast-mode-2026-02-01"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default.onRequest: passes ctx.headers through to the key derivation", async () => {
  // Contract check: onRequest must forward headers, else every request
  // silently falls back to the content-derived key this work removed.
  const src = await readFile(
    join(__dirname, "..", "proxy", "extensions", "prefix-diff.mjs"),
    "utf-8",
  );
  assert.ok(
    /snapshotPrefix\(ctx\.body,\s*\{\s*headers:\s*ctx\.headers\s*\}\)/.test(src),
    "onRequest must pass ctx.headers to snapshotPrefix",
  );
});

// Blind spot 7 (2026-07-27): a mid-history mutation was reported by index and
// nothing more. `messages@83(user)` on a ~93k bust could not be attributed
// afterwards — index 83 falls outside the head-5 and tail-3 content windows,
// so no stored artifact held what changed, and the live request was long gone.
test("a mid-history mutation records HOW it changed, not just where", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "midhistory" };
  const mk = (midText) => {
    const msgs = [];
    for (let i = 0; i < 12; i++) {
      msgs.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: i === 7 ? midText : `turn ${i}` }],
      });
    }
    return makePayload({ messages: msgs });
  };
  try {
    // contentEnabled:true — this test is specifically about the
    // CACHE_FIX_PREFIXDIFF_CONTENT=1 opt-in surface (prevContent/
    // nowContent are omitted by default under content minimization,
    // 2026-08-05).
    await snapshotPrefix(mk("ORIGINAL mid-history content"), { dir, headers, contentEnabled: true });
    let r;
    await captureStderr(async () => {
      r = await snapshotPrefix(mk("MUTATED mid-history content"), { dir, headers, contentEnabled: true });
    });
    assert.ok(r.wroteDiff);

    const events = (await readFile(join(dir, `${r.key}-events.jsonl`), "utf-8"))
      .trim().split("\n").map((l) => JSON.parse(l));
    const rec = events.at(-1);
    assert.equal(rec.chain.first, 7, "index 7 diverged");
    // The point of the fix: both sides are recoverable from the ledger alone.
    assert.match(rec.chain.prevContent, /ORIGINAL/);
    assert.match(rec.chain.nowContent, /MUTATED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Defects found by an isolated verifier against 6aa85f8 (2026-07-27). Both are
// in the per-tenant baseline machinery introduced by that commit.

test("concurrent co-tenants each keep a baseline (no lost update)", async () => {
  const dir = await newTmp();
  const headers = { "x-claude-code-session-id": "shared" };
  try {
    // The exact shape the per-tenant work targets: one session id, many
    // agents in flight at once. The read-modify-write of the tenants map is
    // separated by awaits, so unserialized writers clobber each other —
    // measured 1 of 10 surviving before the per-key lock.
    const reqs = [];
    for (let i = 0; i < 10; i++) {
      reqs.push(
        snapshotPrefix(
          makePayload({
            system: [{ type: "text", text: `agent ${i} system prompt` }],
            messages: [{ role: "user", content: [{ type: "text", text: `t${i}` }] }],
          }),
          { dir, headers },
        ),
      );
    }
    let results;
    await captureStderr(async () => {
      results = await Promise.all(reqs);
    });
    const json = JSON.parse(await readFile(join(dir, `${results[0].key}-last.json`), "utf-8"));
    assert.equal(Object.keys(json.tenants).length, 10, "every concurrent tenant keeps its baseline");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tenant eviction drops the oldest by timestamp, not by key order", () => {
  // Object.keys enumerates integer-like keys FIRST in ascending numeric order,
  // regardless of insertion order — and an 8-hex tenant id is all-digits about
  // one time in 16. Slicing Object.keys therefore evicted such a tenant ahead
  // of genuinely older ones. This pins the ordering rule the fix relies on.
  const obj = {};
  obj["deadbeef"] = 1;
  obj["12345678"] = 2;
  obj["cafe0000"] = 3;
  assert.equal(
    Object.keys(obj)[0],
    "12345678",
    "numeric-string keys sort to the front — key order is NOT insertion order",
  );
});

// BITE — the shape a short-prompt test cannot catch. Short prompts differ in
// their first bytes, so they separate under ANY prefix length; the collision
// needed a long SHARED preamble, which is what real agent system prompts look
// like. tenantId truncated to 400 chars until 2026-07-28 and merged these two
// into one tenant, silently combining their baselines — every co-tenant diff
// after that was attributed against the wrong baseline.
test("tenantId: two prompts sharing a long preamble must not collide — hash the FULL text", () => {
  const preamble = "You are a Claude agent. ".repeat(40); // ~960 chars, shared
  const longA = tenantId({}, [{ type: "text", text: preamble + "TASK A" }]);
  const longB = tenantId({}, [{ type: "text", text: preamble + "TASK B" }]);
  assert.notEqual(longA, longB, "a truncated hash merges tenants that differ only past the cut");
});
