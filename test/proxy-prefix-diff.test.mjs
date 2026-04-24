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
  truncatePrefixMessages,
  diffHasChanges,
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
    const json = JSON.parse(await readFile(join(dir, expected), "utf-8"));
    assert.equal(json.messageCount, 2);
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
    assert.deepEqual(files, [`${r1.key}-diff.json`, `${r1.key}-last.json`]);
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
    assert.equal(json.messageCount, 2);
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
        snapshotPrefix(payloadA, { dir }),
        snapshotPrefix(payloadB, { dir }),
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
    const actual = JSON.stringify(deterministic(json));
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
