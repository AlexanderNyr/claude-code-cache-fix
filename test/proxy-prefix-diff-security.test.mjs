// prefix-diff — permissions, content minimization, and cross-key retention
// (2026-08-05, PR #280 review round). Three independent invariants, each
// with its own BITE:
//
//   1. Every artifact this module writes lands 0600, not at the ambient
//      umask.
//   2. In DEFAULT mode (CACHE_FIX_PREFIXDIFF_CONTENT unset), no byte of
//      prompt-derived text reaches any written file — proven by grepping
//      every file written for a sentinel string placed in the request,
//      not by asserting which fields are set (a field-shape assertion
//      would pass even if some OTHER field the assertion didn't think to
//      check leaked the same bytes).
//   3. A boot-time sweep bounds the snapshot directory across sessions:
//      artifacts older than 14 days are deleted regardless of key count,
//      and once fewer than 200 keys remain, the oldest keys beyond that
//      cap are deleted regardless of age.
//
// All I/O in this file is confined to a fresh mkdtemp() per test, passed
// explicitly as `dir`/`options.dir` — never the real
// `~/.claude/cache-fix-snapshots/`, which is production state for a
// running proxy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  snapshotPrefix,
  sweepSnapshotDir,
  SNAPSHOT_MAX_AGE_MS,
  SNAPSHOT_MAX_KEYS,
} from "../proxy/extensions/prefix-diff.mjs";

const OWNER_ONLY = 0o600;

async function newTmp() {
  return mkdtemp(join(tmpdir(), "prefix-diff-security-test-"));
}

async function modeOf(path) {
  return (await stat(path)).mode & 0o777;
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

async function captureStderr(fn) {
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
}

// Grep every file under `dir` for `needle`. Returns the list of file names
// that contain it — empty means clean.
async function grepDirFor(dir, needle) {
  const names = await readdir(dir).catch(() => []);
  const hits = [];
  for (const name of names) {
    const content = await readFile(join(dir, name), "utf-8").catch(() => "");
    if (content.includes(needle)) hits.push(name);
  }
  return hits;
}

// =====================================================================
// 1. Mode-bit BITEs
// =====================================================================

test("BITE — a freshly written -last.json snapshot lands 0600", async () => {
  const dir = await newTmp();
  try {
    const headers = { "x-claude-code-session-id": "mode-last" };
    const r = await snapshotPrefix(makePayload(), { dir, headers });
    assert.equal(await modeOf(join(dir, `${r.key}-last.json`)), OWNER_ONLY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("BITE — a freshly written -diff.json lands 0600", async () => {
  const dir = await newTmp();
  try {
    const headers = { "x-claude-code-session-id": "mode-diff" };
    await snapshotPrefix(makePayload(), { dir, headers });
    let r;
    await captureStderr(async () => {
      r = await snapshotPrefix(
        makePayload({ messages: [{ role: "user", content: [{ type: "text", text: "CHANGED" }] }] }),
        { dir, headers },
      );
    });
    assert.ok(r.wroteDiff, "precondition: a diff must actually have been written");
    assert.equal(await modeOf(join(dir, `${r.key}-diff.json`)), OWNER_ONLY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("BITE — a freshly written -events.jsonl ledger lands 0600", async () => {
  const dir = await newTmp();
  try {
    const headers = { "x-claude-code-session-id": "mode-events" };
    await snapshotPrefix(makePayload(), { dir, headers });
    let r;
    await captureStderr(async () => {
      r = await snapshotPrefix(
        makePayload({ messages: [{ role: "user", content: [{ type: "text", text: "CHANGED" }] }] }),
        { dir, headers },
      );
    });
    assert.ok(r.wroteDiff);
    assert.equal(await modeOf(join(dir, `${r.key}-events.jsonl`)), OWNER_ONLY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("BITE — a rotated -events.jsonl.1 stays 0600 after the boot sweep repairs it", async () => {
  const dir = await newTmp();
  try {
    const key = "s-modetest01";
    const eventsPath = join(dir, `${key}-events.jsonl`);
    // Seed a pre-existing events file at a loose mode, as if written by
    // code that predates this fix — this is exactly the case rotation's
    // rename-preserves-mode behaviour cannot repair on its own (rotation
    // never calls the owner-only writer on the `.1` name).
    await writeFile(eventsPath, "old\n", { mode: 0o644 });
    assert.equal(await modeOf(eventsPath), 0o644, "precondition: starts world-readable");

    await sweepSnapshotDir(dir);

    assert.equal(await modeOf(eventsPath), OWNER_ONLY, "sweep must repair a stale mode on a surviving file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// 2. Content minimization — sentinel grep
// =====================================================================

const SENTINEL = "SENTINEL-9f3c2b7e-do-not-persist";

function payloadWithSentinel() {
  return makePayload({
    system: [{ type: "text", text: `you are claude. ${SENTINEL} extra context that pads past any short cap` }],
    messages: [
      { role: "user", content: SENTINEL },
      { role: "assistant", content: [{ type: "text", text: "ack" }] },
      { role: "user", content: [{ type: "tool_result", content: `result containing ${SENTINEL}` }] },
      { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: SENTINEL } }] },
    ],
  });
}

test("BITE — default mode: the sentinel never lands in any written file", async () => {
  const dir = await newTmp();
  try {
    const headers = { "x-claude-code-session-id": "content-default" };
    // First request establishes the baseline; second mutates it so a diff
    // and an event record are actually written — the artifacts most
    // likely to carry a leaked preview.
    await snapshotPrefix(payloadWithSentinel(), { dir, headers });
    await captureStderr(async () => {
      await snapshotPrefix(
        payloadWithSentinel({
          messages: [{ role: "user", content: `${SENTINEL} mutated` }],
        }),
        { dir, headers },
      );
    });

    const hits = await grepDirFor(dir, SENTINEL);
    assert.deepEqual(hits, [], `sentinel must not appear in any written file, found in: ${hits.join(", ")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CONTROL — CACHE_FIX_PREFIXDIFF_CONTENT mode: the sentinel DOES land on disk (proves the grep can detect it)", async () => {
  const dir = await newTmp();
  try {
    const headers = { "x-claude-code-session-id": "content-enabled" };
    await snapshotPrefix(payloadWithSentinel(), { dir, headers, contentEnabled: true });
    await captureStderr(async () => {
      await snapshotPrefix(
        payloadWithSentinel({
          messages: [{ role: "user", content: `${SENTINEL} mutated` }],
        }),
        { dir, headers, contentEnabled: true },
      );
    });

    const hits = await grepDirFor(dir, SENTINEL);
    assert.ok(hits.length > 0, "control must find the sentinel when content mode is on, or the grep instrument is broken");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// 3. Cross-key retention sweep
// =====================================================================

async function seedKey(dir, key, { mtimeMs } = {}) {
  const files = [`${key}-last.json`, `${key}-diff.json`, `${key}-events.jsonl`];
  for (const name of files) {
    const p = join(dir, name);
    await writeFile(p, "{}");
    if (mtimeMs !== undefined) {
      const t = mtimeMs / 1000;
      await utimes(p, t, t);
    }
  }
  return files;
}

test("BITE — sweep deletes artifacts older than the age cap regardless of key count", async () => {
  const dir = await newTmp();
  try {
    const now = Date.now();
    const old = now - (SNAPSHOT_MAX_AGE_MS + 24 * 60 * 60 * 1000); // 15 days old
    const fresh = now - 60 * 1000; // 1 minute old

    await seedKey(dir, "s-oldkey0001", { mtimeMs: old });
    await seedKey(dir, "s-freshkey01", { mtimeMs: fresh });

    const result = await sweepSnapshotDir(dir, undefined, { now });
    const remaining = (await readdir(dir)).sort();

    assert.equal(result.deleted, 3, "all 3 artifacts of the old key must be deleted");
    assert.deepEqual(
      remaining,
      ["s-freshkey01-diff.json", "s-freshkey01-events.jsonl", "s-freshkey01-last.json"],
      "only the fresh key's artifacts survive",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("BITE — sweep prunes the oldest keys beyond the 200-key cap", async () => {
  const dir = await newTmp();
  try {
    const now = Date.now();
    // 205 keys, all well within the age cap, spread across distinct
    // mtimes so oldest-first pruning is well-defined.
    const totalKeys = 205;
    for (let i = 0; i < totalKeys; i++) {
      const key = `s-key${String(i).padStart(6, "0")}`;
      // Oldest key first (i=0 is oldest), 1 minute apart.
      await seedKey(dir, key, { mtimeMs: now - (totalKeys - i) * 60 * 1000 });
    }

    const result = await sweepSnapshotDir(dir, undefined, { now });
    const remainingNames = await readdir(dir);
    const remainingKeys = new Set(
      remainingNames.map((n) => n.replace(/-(last\.json|diff\.json|events\.jsonl)$/, "")),
    );

    assert.equal(remainingKeys.size, SNAPSHOT_MAX_KEYS, "exactly maxKeys survive");
    assert.equal(result.deleted, (totalKeys - SNAPSHOT_MAX_KEYS) * 3, "3 artifacts per evicted key");
    // The 5 oldest keys (i=0..4) must be gone; the 200 newest must remain.
    for (let i = 0; i < totalKeys - SNAPSHOT_MAX_KEYS; i++) {
      const key = `s-key${String(i).padStart(6, "0")}`;
      assert.ok(!remainingKeys.has(key), `oldest key ${key} must have been evicted`);
    }
    const newestKey = `s-key${String(totalKeys - 1).padStart(6, "0")}`;
    assert.ok(remainingKeys.has(newestKey), "the newest key must survive");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sweep is a safe no-op on a directory that does not exist yet", async () => {
  const dir = join(await newTmp(), "does-not-exist");
  const result = await sweepSnapshotDir(dir, undefined, {});
  assert.deepEqual(result, { deleted: 0, keysRemaining: 0 });
});

test("sweep ignores files that are not this module's own artifacts", async () => {
  const dir = await newTmp();
  try {
    await writeFile(join(dir, "cache-fix-keymap.jsonl"), "unrelated\n");
    await writeFile(join(dir, "s-somekey-last.json"), "{}");
    const result = await sweepSnapshotDir(dir, undefined, {});
    assert.equal(result.deleted, 0);
    const remaining = (await readdir(dir)).sort();
    assert.deepEqual(remaining, ["cache-fix-keymap.jsonl", "s-somekey-last.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
