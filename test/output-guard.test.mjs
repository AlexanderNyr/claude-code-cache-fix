import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import guard, { findViolation } from "../proxy/extensions/output-guard.mjs";
import stash from "../proxy/extensions/output-guard-stash.mjs";
import { loadExtensions, runOnRequest } from "../proxy/pipeline.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(__dirname, "..", "proxy", "extensions");
const EXT_CONFIG = join(__dirname, "..", "proxy", "extensions.json");
const FIXTURES = join(__dirname, "fixtures", "replay-classes");

const cc = { cache_control: { type: "ephemeral" } };

function sha(v) {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);
}

function userMsg(text) {
  return { role: "user", content: [{ type: "text", text }] };
}

function goodBody() {
  return {
    model: "m",
    system: [{ type: "text", text: "sys", ...cc }],
    messages: [
      userMsg("u0"),
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ],
  };
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

async function withGuardEnv(fn) {
  const dir = await mkdtemp(join(tmpdir(), "output-guard-test-"));
  const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CACHE_FIX_OUTPUT_GUARD: process.env.CACHE_FIX_OUTPUT_GUARD };
  process.env.CLAUDE_CONFIG_DIR = dir;
  process.env.CACHE_FIX_OUTPUT_GUARD = "1";
  try {
    return await silenced(() => fn(dir));
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  }
}

// --- Validator unit coverage ---

test("findViolation: healthy body -> null", () => {
  assert.equal(findViolation(goodBody()), null);
});

test("findViolation: broken tool adjacency named", () => {
  const b = goodBody();
  b.messages.splice(2, 0, userMsg("interloper"));
  assert.match(findViolation(b), /tool-adjacency/);
});

test("findViolation: fifth marker named", () => {
  const b = goodBody();
  for (let i = 0; i < 4; i++) b.messages.push({ role: "user", content: [{ type: "text", text: `m${i}`, ...cc }] });
  // system already carries 1 -> total 5. But adjacency must stay valid:
  // appended AFTER the tool_result, fine.
  assert.match(findViolation(b), /marker-budget: 5/);
});

test("findViolation: invalid role and empty content named", () => {
  const b1 = goodBody();
  b1.messages.push({ role: "tool", content: [{ type: "text", text: "x" }] });
  assert.match(findViolation(b1), /roles: messages\[3\]/);
  // system is legal mid-conversation (tool_addition injections,
  // mid-conversation system messages) but never as messages[0]
  const b2sys = goodBody();
  b2sys.messages.push({ role: "system", content: [{ type: "text", text: "ok" }] });
  assert.equal(findViolation(b2sys), null);
  const b3sys = goodBody();
  b3sys.messages.unshift({ role: "system", content: [{ type: "text", text: "bad" }] });
  assert.match(findViolation(b3sys), /messages\[0\] must not be system/);
  const b2 = goodBody();
  b2.messages.push({ role: "user", content: [] });
  assert.match(findViolation(b2), /content: messages\[3\]/);
});

// --- Invariant 5: assistant-terminal (BACKLOG.md, "suppression can strip
// a request's FINAL message", 2026-07-30) ---

test("findViolation: healthy body, incoming also ends non-assistant -> null (no incomingBody = cannot verify, also null)", () => {
  const b = goodBody(); // ends on a tool_result (role user)
  assert.equal(findViolation(b, b), null);
  assert.equal(findViolation(b), null, "no incomingBody -> this check cannot fire");
});

test("findViolation: incoming ended non-assistant but forwarded ends assistant -> assistant-terminal named", () => {
  const incoming = goodBody(); // last message role "user"
  const forwarded = goodBody();
  forwarded.messages.pop(); // simulate a mutation stripping the trailing tool_result
  assert.equal(forwarded.messages[forwarded.messages.length - 1].role, "assistant");
  assert.match(findViolation(forwarded, incoming), /assistant-terminal/);
});

test("findViolation: incoming ITSELF ended assistant (prefill-shaped) -> not this guard's business, no violation", () => {
  const incoming = goodBody();
  incoming.messages.push({ role: "assistant", content: [{ type: "text", text: "partial" }] });
  const forwarded = structuredClone(incoming); // forwarded also ends assistant, matching CC's own intent
  assert.equal(findViolation(forwarded, incoming), null);
});

test("findViolation: incoming and forwarded both end non-assistant -> null (healthy case)", () => {
  const incoming = goodBody();
  const forwarded = structuredClone(incoming);
  assert.equal(findViolation(forwarded, incoming), null);
});

test("gate 2 (assistant-terminal): a mutator that strips the trailing message is caught, forwards the original, telemetry names it", async () => {
  await withGuardEnv(async (dir) => {
    const body = goodBody();
    const originalHash = sha(body);
    const ctx = { body, headers: { "x-session-id": "tail-strip-test" }, meta: { route: "messages" } };
    const stripTailMutator = {
      name: "test-strip-tail-mutator",
      order: 300,
      async onRequest(c) {
        c.body.messages.pop();
      },
    };
    await runOnRequest(ctx, [stash, stripTailMutator, guard]);

    assert.equal(ctx.meta.outputGuardStats.fired, true);
    assert.equal(ctx.meta.outputGuardStats.restored, true);
    assert.match(ctx.meta.outputGuardStats.violation, /assistant-terminal/);
    assert.equal(sha(ctx.body), originalHash, "forwarded body is byte-identical to the pre-pipeline original");

    const events = await readFile(join(dir, "cache-fix-snapshots", "s-tail-strip-test-guard-events.jsonl"), "utf-8");
    assert.match(events, /assistant-terminal/, "telemetry record names the violated invariant");
  });
});

// --- Gate 1: zero fires on all healthy class corpora ---

// The corpus COUNT is deliberately not pinned. It was (`=== 8`), and adding a
// ninth corpus in 3aeafef turned this into a hard failure — so a BLOCKING gate
// stopped validating anything the moment the regression set grew, which is the
// opposite of what a gate is for. Extending coverage must never break the
// check that consumes it. What matters is that the corpora are present and
// that every one of them replays without firing the guard; both are asserted.
test("gate 1: guard fires zero times across every class-matrix corpus", async () => {
  await withGuardEnv(async () => {
    const extensions = await loadExtensions(EXT_DIR, EXT_CONFIG);
    const files = (await readdir(FIXTURES)).filter((f) => f.endsWith(".jsonl"));
    assert.ok(files.length >= 8, `class-matrix corpora missing: found ${files.length}`);
    let requests = 0;
    for (const f of files) {
      const lines = (await readFile(join(FIXTURES, f), "utf-8")).split("\n").filter((l) => l.trim());
      for (const line of lines) {
        const rec = JSON.parse(line);
        const ctx = {
          body: structuredClone(rec.body),
          headers: { "x-session-id": rec.headers?.["session-id"] ?? rec.sid },
          meta: { route: "messages" },
        };
        await runOnRequest(ctx, extensions);
        requests++;
        assert.notEqual(ctx.meta.outputGuardStats?.fired, true, `guard fired on healthy traffic in ${f}`);
      }
    }
    assert.ok(requests >= 18, "corpora actually replayed");
  });
});

// --- Gate 2: injection proof — a broken mutator is caught and undone ---

function brokenAdjacencyMutator() {
  return {
    name: "test-broken-mutator",
    order: 300,
    async onRequest(ctx) {
      // Splice a user message between tool_use and tool_result — the
      // composition-defect shape the guard exists for.
      const i = ctx.body.messages.findIndex(
        (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_result"),
      );
      if (i > 0) ctx.body.messages.splice(i, 0, userMsg("BROKEN"));
    },
  };
}

function fifthMarkerMutator() {
  return {
    name: "test-marker-mutator",
    order: 300,
    async onRequest(ctx) {
      for (let i = 0; i < 5; i++) {
        ctx.body.messages.push({ role: "user", content: [{ type: "text", text: `mk${i}`, ...cc }] });
      }
    },
  };
}

for (const [label, mutator, pattern] of [
  ["adjacency break", brokenAdjacencyMutator, /tool-adjacency/],
  ["marker overflow", fifthMarkerMutator, /marker-budget/],
]) {
  test(`gate 2 (${label}): guard fires, forwards byte-identical original, telemetry names the invariant`, async () => {
    await withGuardEnv(async (dir) => {
      const body = goodBody();
      const originalHash = sha(body);
      const ctx = { body, headers: { "x-session-id": "inject-test" }, meta: { route: "messages" } };
      await runOnRequest(ctx, [stash, mutator(), guard]);

      assert.equal(ctx.meta.outputGuardStats.fired, true);
      assert.equal(ctx.meta.outputGuardStats.restored, true);
      assert.match(ctx.meta.outputGuardStats.violation, pattern);
      assert.equal(sha(ctx.body), originalHash, "forwarded body is byte-identical to the pre-pipeline original");

      const events = await readFile(
        join(dir, "cache-fix-snapshots", "s-inject-test-guard-events.jsonl"),
        "utf-8",
      );
      assert.match(events, pattern, "telemetry record names the violated invariant");
    });
  });
}

test("gate 2 addendum: no stash (guard enabled without stash ext) -> mutated body forwarded, restored=false", async () => {
  await withGuardEnv(async () => {
    const ctx = { body: goodBody(), headers: {}, meta: { route: "messages" } };
    await runOnRequest(ctx, [brokenAdjacencyMutator(), guard]);
    assert.equal(ctx.meta.outputGuardStats.fired, true);
    assert.equal(ctx.meta.outputGuardStats.restored, false);
  });
});

// --- Gate 3: guard crash -> fail-open, request unharmed ---

test("gate 3: validator crash passes the mutated body through with verified=false", async () => {
  await withGuardEnv(async () => {
    // A body whose messages array is a Proxy that throws on access deep
    // enough to pass the entry checks but crash a validator.
    const body = goodBody();
    let reads = 0;
    body.messages = new Proxy(body.messages, {
      get(target, prop, receiver) {
        if (prop === "length" && ++reads > 2) throw new Error("synthetic validator crash");
        return Reflect.get(target, prop, receiver);
      },
    });
    const ctx = { body, headers: {}, meta: { route: "messages" } };
    await runOnRequest(ctx, [guard]);
    assert.equal(ctx.meta.outputGuardStats.verified, false);
    assert.match(ctx.meta.outputGuardStats.error, /synthetic validator crash/);
  });
});

// --- Flag off: complete no-op ---

test("flag off: guard and stash are no-ops, no stats, no stash key", async () => {
  const saved = process.env.CACHE_FIX_OUTPUT_GUARD;
  delete process.env.CACHE_FIX_OUTPUT_GUARD;
  try {
    const ctx = { body: goodBody(), headers: {}, meta: { route: "messages" } };
    await runOnRequest(ctx, [stash, guard]);
    assert.equal(ctx.meta.outputGuardStats, undefined);
    assert.equal(ctx.meta._preMutationBody, undefined);
  } finally {
    if (saved !== undefined) process.env.CACHE_FIX_OUTPUT_GUARD = saved;
  }
});
