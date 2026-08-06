// Cross-extension session-key invariants — the guard against "the lesson did
// not travel to the sibling".
//
// This exact failure happened twice in one day (2026-07-28), the second time
// costing real cache:
//
//   insertion-normalization keyed persisted state on (session-id,
//   system-prompt). Every subagent of a session runs the same agent prompt,
//   so one bucket held 39 distinct conversations and 100% of conversation
//   switches within a bucket reset (60/60). Fixed by adding a conversation
//   sub-key: 0 resets across 940 requests.
//
//   deferred-tool-rewrite had the IDENTICAL key and did not get the fix,
//   because nothing connected the two. Its tool_addition announcement is
//   anchored to a MESSAGE IDENTITY, so under a shared key the stored anchor
//   belonged to another conversation's history, failed to match, and
//   re-anchored to "after the last user message" — a different index every
//   request. Measured: our output diverging at index 4 while CC's history was
//   byte-identical through index 23, twice in one corpus.
//
// A fix applied to one consumer of a shared idea is not applied. So this file
// does not test a list someone maintains: it DISCOVERS every exported
// `*SessionKey` function under proxy/extensions/ and holds all of them to the
// same invariants. A new stateful extension is covered the moment it exports
// one, and an existing one cannot quietly regress.
//
// If a future extension legitimately needs a coarser key, this test failing is
// the conversation about it — which is the point.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "proxy", "extensions");

// prefix-diff is exempt, and the exemption is checked rather than trusted.
// It keeps its FILE key at the session id deliberately (its design note 1: a
// path that moves with content misses its own baseline, so a bust never gets
// logged) and separates co-tenants INSIDE the file via tenantId. It also
// shapes no request — it is telemetry, so a coarse key costs attribution
// precision, not cache. The exemption is paired with an assertion that
// tenantId still exists, so if that design ever changes this guard notices
// instead of staying quietly satisfied.
const SEPARATES_INSIDE_THE_FILE = new Set(["prefix-diff.mjs"]);

async function discoverKeyResolvers({ all = false } = {}) {
  const found = [];
  for (const f of (await readdir(EXT_DIR)).sort()) {
    if (!f.endsWith(".mjs")) continue;
    if (!all && SEPARATES_INSIDE_THE_FILE.has(f)) continue;
    const mod = await import(pathToFileURL(join(EXT_DIR, f)).href);
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn === "function" && /SessionKey$/.test(name)) {
        found.push({ file: f, name, fn });
      }
    }
  }
  return found;
}

const HEADERS = { "x-claude-code-session-id": "shared-session" };
const SYSTEM = [{ type: "text", text: "You are a Claude agent." }];
const convA = [{ role: "user", content: [{ type: "text", text: "conversation A" }] }];
const convB = [{ role: "user", content: [{ type: "text", text: "conversation B" }] }];

// The resolvers do not share a signature — insertion-normalization takes
// (headers, messages, system), deferred-tool-rewrite takes (headers, body).
// ARITY distinguishes them mechanically, so no name list is maintained here:
// a name list is the same hand-maintained roster this file exists to avoid.
function callResolver(fn, { messages, system }) {
  return fn.length >= 3
    ? fn(HEADERS, messages, system)
    : fn(HEADERS, { messages, system, model: "test-model" });
}

test("every extension exporting a *SessionKey is discovered", async () => {
  const resolvers = await discoverKeyResolvers();
  assert.ok(resolvers.length >= 2, `expected at least the two stateful extensions, found ${resolvers.length}`);
  const files = new Set(resolvers.map((r) => r.file));
  // These two are the reason the file exists; losing either from discovery
  // would silently empty the guard.
  assert.ok(files.has("insertion-normalization.mjs"), [...files].join(","));
  assert.ok(files.has("deferred-tool-rewrite.mjs"), [...files].join(","));
});

test("BITE — a session key must separate CONVERSATIONS, not just system prompts", async () => {
  for (const { file, name, fn } of await discoverKeyResolvers()) {
    const a = callResolver(fn, { messages: convA, system: SYSTEM });
    const b = callResolver(fn, { messages: convB, system: SYSTEM });
    assert.notEqual(
      a,
      b,
      `${file}:${name} gives one key to two conversations under the same session-id and system prompt — ` +
        `the collision that cost cache in deferred-tool-rewrite. Add conversationSubKey from message-hash.mjs.`,
    );
  }
});

test("a session key must separate SYSTEM PROMPTS (sidecar classes)", async () => {
  for (const { file, name, fn } of await discoverKeyResolvers()) {
    const main = callResolver(fn, { messages: convA, system: SYSTEM });
    const sidecar = callResolver(fn, {
      messages: convA,
      system: [{ type: "text", text: "Generate a concise 5-word title." }],
    });
    assert.notEqual(main, sidecar, `${file}:${name} shares a key across system-prompt classes`);
  }
});

test("a session key is STABLE for the same conversation as it grows", async () => {
  // The other half: a key that changes every turn is not an identity either,
  // and would abandon state on every request rather than colliding.
  for (const { file, name, fn } of await discoverKeyResolvers()) {
    const first = callResolver(fn, { messages: convA, system: SYSTEM });
    const grown = callResolver(fn, {
      messages: [...convA, { role: "assistant", content: [{ type: "text", text: "reply" }] }],
      system: SYSTEM,
    });
    assert.equal(first, grown, `${file}:${name} changes key as the conversation grows — state cannot persist`);
  }
});

// (A further case verifying prefix-diff's exemption from this invariant --
// its own tenantId separation -- ships with the prefix-diff changes, which
// export the function it inspects.)
