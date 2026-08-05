// insertion-normalization — re-serialize a mid-history splice back into
// arrival order so the prefix cache sees an append instead of a rewrite.
//
// Design: docs/directives/proxy-insertion-normalization.md (phase 2 of the
// the removed mid-history-breakpoint-ladder work). Implements the Design
// sketch rules 1-4 only; the "Alternative considered" (full marker
// ownership) section is explicitly NOT built here.
//
// Activation: `enabled: true` in extensions.json (always loaded), runtime
// gate CACHE_FIX_INSERTION_NORMALIZE=1 (opt-in, read per-call so tests can
// flip it without re-importing). CACHE_FIX_DEBUG honored for swallowed
// I/O errors, same idiom as prefix-diff.
//
// Order 395 — after read-dedupe (380), before cache-control-normalize
// (400), so the marker-placing pass sees the normalized order. (Two other
// marker placers once sat at 410 and 420; both were removed 2026-07-28 —
// see message-hash.mjs.)
// Verified-safe adjacent slot: read-dedupe only rewrites LATER duplicate
// occurrences of a Read tool_result (the first/keeper occurrence is never
// rewritten, and "keeper" is monotonic — a message that was already the
// earliest occurrence of its dedupe key stays the earliest occurrence as
// new messages arrive), so a message already recorded in canonical never
// has its content-hash change out from under it by running after
// read-dedupe. content-strip (330) and microcompact-stability (350) run
// even earlier, so their output is what canonical hashes see from the
// start — no special handling needed for those either.
//
// --- Canonical history model ---
//
// Per session (keyed off the session-id header, same derivation as
// prefix-diff post-fc432bf — SUB-KEYED additionally by a hash
// of the request's system prompt, see systemPromptSubKey/threat-matrix
// row 14: sidecar requests such as title-generation share the session-id
// header with the main thread but carry a different system prompt, so
// without the sub-key every sidecar turn thrashed the main thread's
// canonical back to reset), the proxy holds an append-only list of entry
// identity records: { h: contentHash, r: role, o: occurrence }.
// The hash is computed AFTER stripping cache_control (message-hash.mjs's
// hashMessageContent, imported rather than reimplemented) so a marker placed by a downstream extension never
// changes an entry's identity. `o` is a 0-based occurrence counter over
// (hash, role) pairs in array order, which disambiguates duplicate
// identical messages (directive's "Known risks to resolve").
//
// --- Classification ---
//
// On each request, canonical entries are matched into the incoming
// messages array by identity. Two things can go wrong with that match,
// and either one sends the request to rule 3 (passthrough + reset):
//   - some canonical entry has no matching identity in incoming (covers
//     true edits, removals, assistant-content changes, and a shrunk
//     history — a shorter incoming array can never contain every
//     canonical entry);
//   - the matched incoming indices are not strictly increasing (the
//     canonical order isn't preserved as a subsequence).
//
// If the match holds, incoming entries not matched into canonical are
// "new". New entries positioned AFTER every matched canonical index are
// ordinary tail growth (the ordinary shape of a conversation advancing —
// including a new assistant turn, which is expected and never restricted).
// New entries positioned AT OR BEFORE the last matched canonical index are
// the actual splice: content Claude Code inserted earlier than where it
// arrived. Rule 2 (INSERTION-ONLY) applies only to those:
//   - every such entry's role must not be "assistant" (the directive says
//     "user-role or system-role — never assistant"; this transport's
//     messages[] array only ever carries role "user" or "assistant" — the
//     system prompt is a separate top-level field, never a messages[]
//     entry — so this reduces to "must be role user". Surfaced as a GAP
//     rather than silently assumed away: see the closing report.);
//   - re-serializing (canonical order first, then ALL new entries —
//     spliced and tail alike — appended in their incoming relative order)
//     must not separate any tool_result-bearing user message from an
//     immediately-preceding assistant message carrying the matching
//     tool_use id(s).
//
// When both hold, the request is re-serialized and forwarded; canonical
// grows by appending the new entries' identities (in the same order they
// were appended to the message array). When either fails, or when the
// match itself failed, the request passes through UNCHANGED and canonical
// resets to a fresh identity list computed from incoming — one honest
// bust, per the directive's conservative bias.
//
// Note the re-serialization formula subsumes plain append: when every new
// entry is already tail growth, "canonical order + new entries appended
// in arrival order" reproduces incoming byte-for-byte. The two cases are
// told apart only for telemetry (action: "append-only" when nothing
// moved, "normalized" when a splice was detected and corrected).
//
// --- Phase 3: volatile-block pinning + removal tolerance (opt-in) ---
//
// Directive: docs/directives/proxy-volatile-block-pinning.md. Gated
// separately by CACHE_FIX_VOLATILE_PIN=1 so the phase-2 behavior above is
// byte-identical when the flag is off — the two modes even keep separate
// canonical identity math, and a canon file written under one mode is
// ignored by the other (one honest reset at the flag flip, never a
// mismatch).
//
// WHAT THE FLIP COSTS, measured when it was actually thrown (2026-07-28
// 17:08, live): the reset is per-conversation and lands on the FIRST request
// after the flip, so a session already deep in context re-caches all of it —
// here cache_read 605,220 -> 15,132 with 678,522 creation tokens, the first
// post-flip request reporting `cause=messages@4(assistant)`. The canon ledger
// shows it plainly: `reset/no-prior-canonical` under a NEW canon key,
// `append-only` immediately after. That is the documented behaviour working,
// not a defect — but it is a real one-time bill, so throw this flag at a
// session boundary or on a young session, never mid-way through a long one.
// It cannot recur for a session once flipped.
//
// (A canon migration — read the phase-2 file, re-derive pin identities — would
// remove the cost. Deliberately NOT built: it is one-time per session, and a
// migration path is a second identity code path to keep correct forever.)
//
// Pin mode changes two things, both measured on live traffic 2026-07-28:
//
// 1. FLIP ABSORPTION. CC serializes hook-injected additionalContext
//    <system-reminder> blocks nondeterministically for deep-history
//    messages — present in one request, absent from the next (two
//    attributed whole-context busts: 135k + 182k, both named by the
//    prevContent/nowContent capture). In pin mode a user message's
//    identity hash EXCLUDES volatile blocks (a text block that is
//    entirely a <system-reminder> wrap, or empty text — the observed
//    flip counterpart), so both serializations match the same canonical
//    entry, and the proxy forwards the FIRST-SEEN bytes: byte-stable
//    history, the flip never reaches the cache. Hard limits: user-role
//    only; text blocks only (tool_results are never volatile); a message
//    carrying a cache_control marker is never rewritten; a non-volatile
//    difference changes the identity hash and takes the reset path.
//
// 2. REMOVAL TOLERANCE. Same-tenant message-count shrinks are routine
//    (91 measured; context-management-2025-06-27 confirmed in the wire
//    beta set), and each one killed the phase-2 subsequence match —
//    reset-per-prune, degrading the extension to a no-op for the rest of
//    the session. In pin mode a canonical entry missing from incoming is
//    marked dropped (kept in the file, flagged, never forwarded) and the
//    match continues past the gap; order violations among SURVIVORS
//    remain a hard reset, and dropping more than half the live entries
//    resets too (that is a compaction, not a prune).

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { claudeHome } from "../claude-home.mjs";
import { resolveSessionId } from "./cache-telemetry.mjs";
import { hashMessageContent, conversationSubKey } from "./message-hash.mjs";

const DEFAULT_FS = { readFile, writeFile, rename, appendFile, mkdir };

// --- Env gates (read per-call, mirrors the prefix-diff idiom) ---

function isEnabled(env = process.env) {
  return env.CACHE_FIX_INSERTION_NORMALIZE === "1";
}

// Phase-3 gate (volatile-block pinning + removal tolerance). Requires the
// phase-2 gate too: pin mode is a refinement of the canonical model, not
// an independent extension.
function isPinEnabled(env = process.env) {
  return env.CACHE_FIX_VOLATILE_PIN === "1";
}

function isDebug(env = process.env) {
  return env.CACHE_FIX_DEBUG === "1";
}

function debug(msg) {
  if (isDebug()) process.stderr.write(`[insertion-normalize] DEBUG: ${msg}\n`);
}

// --- Storage ---

function getSnapshotDir() {
  return join(claudeHome(), "cache-fix-snapshots");
}

// Sub-key on the system prompt (threat-matrix row 14): sidecar requests
// (title-generation etc.) share the session-id header with the main thread
// but carry a DIFFERENT system prompt. Keying persisted canonical state on
// the session-id header alone made every sidecar turn look like a splice
// against the main thread's canonical (or vice versa), thrashing it back
// to a reset — never corrupting, but degrading the extension to a no-op
// for that session. A short hash of system[0]'s text (mirrors prefix-
// diff's computeSessionKey idiom — same "cheap discriminator over the
// diffed content" shape, but used here as a SUB-key alongside the stable
// session-id, never as the sole key, so prefix-diff's own "self-defeating
// key" lesson doesn't apply: a change inside the hashed text can only ever
// route to a *different* bucket, never lose the lookup entirely) buckets
// the main thread and each distinct sidecar system prompt independently
// under the same session-id.
//
// Exported so sibling extensions that persist per-session state key it the
// same way — the collision is a property of the session-id header, not of
// this extension, so every consumer of that header needs the same sub-key.
export function systemPromptSubKey(system) {
  let text;
  if (typeof system === "string") {
    text = system;
  } else if (Array.isArray(system) && system.length > 0) {
    const first = system[0];
    text = typeof first?.text === "string" ? first.text : JSON.stringify(first ?? null);
  } else {
    return "nosys";
  }
  if (!text) return "nosys";
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

// Session-id header derivation, same idiom as prefix-diff
// (post-fc432bf: session-id header preferred, content-hash fallback for
// requests without it — direct API calls, tests). Sub-keyed on the system
// prompt (see systemPromptSubKey) so sidecar requests sharing the header
// bucket separately from the main thread. Old single-key state files
// (pre-sub-key) are simply abandoned under the new path — loadCanonical's
// existing ENOENT handling already treats an absent file as "no prior
// canonical" (ordinary session start), so no explicit migration is needed.
// CONVERSATION sub-key (2026-07-28) — row 14, one level deeper. The
// system-prompt hash separates a sidecar CLASS from the main thread, but not
// the individual conversations WITHIN a class: every subagent this session
// dispatches runs the same agent system prompt, so they all landed in one
// bucket and overwrote each other's canonical. Measured on real traffic
// (602 requests): one system-prompt bucket held 39
// distinct conversations, another 12 — and the correlation with resets was
// total.
//
//     conversation SWITCH within a bucket: 60 requests, 60 resets (100%)
//     same conversation continuing       : 538 requests,  4 resets (1%)
//
// 72 of 83 resets across both corpora were this artifact, not real history
// churn: each switch made the incoming history look like a wholesale rewrite
// of whatever tenant spoke last, which classifies as dropped-majority. The
// extension was spending almost all of its reset budget on a keying bug.
//
// msgs[0] identifies a conversation because it is the one entry nothing
// appends past. When compaction or context-management replaces it the key
// moves and the canonical is abandoned — one honest reset, exactly what the
// old key produced anyway on the same event, since a replaced msgs[0] fails
// the subsequence match regardless.
// Conversation identity from msgs[0]. hashMessageContent covers block-array
// content only (it strips cache_control per block) and returns null for
// STRING content — correct for its own callers, but as a bucket key that
// null collapsed every string-content conversation into one shared "empty"
// bucket: 56 of 602 requests in the measured capture, which is where the
// residual dropped-majority resets lived after the first sub-key attempt.
// Falling back to a hash of the raw content covers both shapes; a message
// carrying no content at all is the only remaining "empty".
// conversationSubKey now lives in message-hash.mjs — deferred-tool-rewrite
// needs the identical function, and a second copy is a second truth.

export function resolveInsertionSessionKey(headers, messages, system) {
  const sid = headers ? resolveSessionId(headers) : null;
  const conv = conversationSubKey(messages);
  if (sid) {
    return `s-${sid.replace(/[^A-Za-z0-9_-]/g, "_")}-${systemPromptSubKey(system)}-${conv}`;
  }
  return `c-${conv}`;
}

function canonPath(dir, sessionKey) {
  return join(dir, `${sessionKey}-insertion-canon.json`);
}

function eventsPath(dir, sessionKey) {
  return join(dir, `${sessionKey}-insertion-events.jsonl`);
}

// `mode` discriminates phase-2 ("plain") from phase-3 ("pin") canon
// files: their identity hashes are incompatible ("v:"-prefixed user
// hashes in pin mode), and without the marker a flag flip could
// PARTIALLY match the other mode's file (assistant hashes are shared),
// producing wrong dropped flags instead of the intended single honest
// reset. Old files without the field read as "plain".
async function loadCanonical(dir, sessionKey, fs, mode = "plain") {
  try {
    const txt = await fs.readFile(canonPath(dir, sessionKey), "utf-8");
    const parsed = JSON.parse(txt);
    if (!Array.isArray(parsed?.entries)) return null;
    if ((parsed.mode ?? "plain") !== mode) return null;
    return parsed.entries;
  } catch (err) {
    if (err && err.code !== "ENOENT") debug(`canonical read failed: ${err?.message ?? err}`);
    return null;
  }
}

async function saveCanonical(dir, sessionKey, entries, fs, mode = "plain") {
  await fs.mkdir(dir, { recursive: true });
  const finalPath = canonPath(dir, sessionKey);
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify({ mode, entries }, null, 2));
  await fs.rename(tmpPath, finalPath);
}

async function appendTelemetry(dir, sessionKey, record, fs) {
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(eventsPath(dir, sessionKey), JSON.stringify(record) + "\n");
  } catch (err) {
    debug(`telemetry append failed: ${err?.message ?? err}`);
  }
}

// --- Identity ---

// One identity record per message, in array order. `o` is the 0-based
// occurrence count of (hash, role) seen so far — disambiguates duplicate
// identical messages (directive's "Known risks to resolve at
// implementation time").
export function computeIdentities(messages) {
  const seen = new Map(); // "hash|role" -> next occurrence index
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = canonicalMessageShape(messages[i]);
    const h = hashMessageContent(msg) ?? hashNonBlockContent(msg, i);
    const r = msg?.role ?? "unknown";
    const key = `${h}|${r}`;
    const o = seen.get(key) ?? 0;
    seen.set(key, o + 1);
    out.push({ index: i, h, r, o });
  }
  return out;
}

// Identity for a message `hashMessageContent` cannot hash — it returns null
// unless `content` is a block ARRAY, and CC sends plenty of messages whose
// content is a plain string (system notes, mid-conversation system blocks).
//
// This fallback used to be `noContent:${i}` — the array INDEX, which made a
// message's identity its position. That is self-defeating for an extension
// whose entire job is absorbing mid-history insertions: the first insertion
// ahead of such a message shifted its index, the canonical lookup missed, and
// classifyInsertion reset with "not-subsequence". Measured 2026-07-27 in one
// live session: 83 index-keyed entries in a single sub-key and 125 resets
// across 350 requests — roughly one request in three, i.e. the extension was
// rebuilding from scratch instead of normalizing.
//
// Hash the content instead, so identity travels with the message. Only a
// genuinely contentless message (null/undefined) still falls back to the
// index, where no better identity exists; `noContent:` is kept as that
// marker's prefix so old canonical files degrade to one reset rather than
// mismatching silently.
function hashNonBlockContent(msg, i) {
  const c = msg?.content;
  if (c === null || c === undefined) return `noContent:${i}`;
  const text = typeof c === "string" ? c : JSON.stringify(c);
  return "s:" + createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// SHAPE FLIP (measured 2026-07-28, census over 771 captured requests). CC
// re-serializes the SAME message between two equivalent shapes:
//
//     [{ "type": "text", "text": "X" }]     <->     "X"
//
// The model sees identical content either way, but the two shapes hash
// through different functions (hashMessageContent for block arrays,
// hashNonBlockContent for strings), so their identities could never match:
// the message read as "one entry dropped, a different one added" and took a
// reset. Applied here — at the one point every identity path passes through
// — rather than in the pin, because the flip is NOT user-role-specific: the
// census found it predominantly on SYSTEM messages (harness reminders), and
// a user-only fold left every one of those still resetting.
//
// Deliberately narrow: only the exact single-text-block <-> string pair, and
// only when the block carries nothing beyond type/text/cache_control. A
// multi-block array is a genuinely different message and keeps its own
// identity.
function canonicalMessageShape(msg) {
  const c = msg?.content;
  if (typeof c === "string") return { ...msg, content: [{ type: "text", text: c }] };
  if (!Array.isArray(c) || c.length !== 1) return msg;
  const b = c[0];
  if (!b || typeof b !== "object" || b.type !== "text" || typeof b.text !== "string") return msg;
  const extra = Object.keys(b).filter((k) => k !== "type" && k !== "text" && k !== "cache_control");
  if (extra.length) return msg;
  return { ...msg, content: [{ type: "text", text: b.text }] };
}

function identityKey(entry) {
  return `${entry.h}|${entry.r}|${entry.o}`;
}

// --- Phase 3: volatile blocks and pin-mode identity ---

// The wrap regex identity-normalization already uses — the harness marks
// its own injections with it. No allowlist of reminder texts: the flip
// evidence already covers four reminder kinds, and a pattern list would
// be the next mole (directive, part A).
//
// Captures the inner text (group 1) so the SAME regex serves both
// isVolatileBlock's boolean test (unaffected by adding a group) and
// suppression's unwrapVolatileText below — one pattern, not a second
// derivation of it (dev-loop.md, "never hand-roll identity in a probe").
const VOLATILE_WRAP_REGEX = /^<system-reminder>\n([\s\S]*)\n<\/system-reminder>\s*$/;

// A text block is volatile iff it is entirely a system-reminder wrap OR
// empty — the observed flip alternates a reminder block with an
// empty-text block (capture 2026-07-27T22:13Z: prev = the reminder,
// now = ""), so both sides must classify volatile for the identities to
// meet. tool_result / tool_use / thinking blocks are NEVER volatile.
export function isVolatileBlock(block) {
  if (!block || typeof block !== "object" || block.type !== "text") return false;
  if (typeof block.text !== "string") return false;
  if (block.text === "") return true;
  return VOLATILE_WRAP_REGEX.test(block.text);
}

// Identity hash for pin mode: user-role messages hash over their
// non-volatile blocks only (cache_control stripped, same as
// hashMessageContent). Assistant and string-content messages fall through to
// the phase-2 identity, which applies canonicalMessageShape itself — so the
// shape flip documented there is absorbed on every role, not just this path.
function hashPinnedIdentity(msg) {
  if (!msg || msg.role !== "user" || !Array.isArray(msg.content)) return null;
  const kept = [];
  for (const block of msg.content) {
    if (isVolatileBlock(block)) continue;
    if (block && typeof block === "object") {
      const { cache_control, ...rest } = block;
      kept.push(rest);
    } else {
      kept.push(block);
    }
  }
  return "v:" + createHash("sha256").update(JSON.stringify(kept)).digest("hex").slice(0, 16);
}

// Pin-mode identities: same record shape as computeIdentities, with the
// volatile-excluded hash for user block-array messages. The "v:" prefix
// keeps pin-mode canon files disjoint from phase-2 ones — a canon written
// under the other mode fails the identity match wholesale and takes one
// honest reset, never a silent partial mismatch.
export function computePinnedIdentities(messages) {
  const seen = new Map();
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = canonicalMessageShape(messages[i]);
    const h =
      hashPinnedIdentity(msg) ?? hashMessageContent(msg) ?? hashNonBlockContent(msg, i);
    const r = msg?.role ?? "unknown";
    const key = `${h}|${r}`;
    const o = seen.get(key) ?? 0;
    seen.set(key, o + 1);
    out.push({ index: i, h, r, o });
  }
  return out;
}

// --- Tool_result / tool_use adjacency invariant ---
//
// For every user message carrying >=1 tool_result block, the immediately
// preceding message must be an assistant message whose tool_use blocks
// cover every tool_use_id referenced by this message's tool_result
// blocks. Violating this is a hard API-shape break, not just a cache
// concern — the directive requires falling back to rule 3 rather than
// producing an invalid re-serialization.
export function validateToolAdjacency(messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "user" || !Array.isArray(msg.content)) continue;
    const toolUseIds = msg.content
      .filter((b) => b && b.type === "tool_result" && typeof b.tool_use_id === "string")
      .map((b) => b.tool_use_id);
    if (toolUseIds.length === 0) continue;

    const prev = messages[i - 1];
    if (!prev || prev.role !== "assistant" || !Array.isArray(prev.content)) return false;
    const prevToolUseIds = new Set(
      prev.content.filter((b) => b && b.type === "tool_use" && typeof b.id === "string").map((b) => b.id),
    );
    for (const id of toolUseIds) {
      if (!prevToolUseIds.has(id)) return false;
    }
  }
  return true;
}

// --- Core classifier (pure) ---
//
// Returns:
//   { action: "reset", resetReason, canonicalEntries }              — passthrough, canonical := fresh(incoming)
//   { action: "append-only", messages, canonicalEntries, inserted }  — passthrough (formula reproduces incoming)
//   { action: "normalized", messages, canonicalEntries, inserted }   — re-serialized, forward `messages`
export function classifyInsertion(messages, priorCanonical) {
  const incomingIdentities = computeIdentities(messages);

  if (!Array.isArray(priorCanonical) || priorCanonical.length === 0) {
    return {
      action: "reset",
      resetReason: "no-prior-canonical",
      canonicalEntries: incomingIdentities.map((e) => ({ h: e.h, r: e.r, o: e.o })),
    };
  }

  const incomingByKey = new Map(incomingIdentities.map((e) => [identityKey(e), e.index]));

  const matchedIndices = [];
  for (const stored of priorCanonical) {
    const idx = incomingByKey.get(identityKey(stored));
    if (idx === undefined) {
      return {
        action: "reset",
        resetReason: "not-subsequence",
        canonicalEntries: incomingIdentities.map((e) => ({ h: e.h, r: e.r, o: e.o })),
      };
    }
    matchedIndices.push(idx);
  }
  for (let i = 1; i < matchedIndices.length; i++) {
    if (matchedIndices[i] <= matchedIndices[i - 1]) {
      return {
        action: "reset",
        resetReason: "not-subsequence",
        canonicalEntries: incomingIdentities.map((e) => ({ h: e.h, r: e.r, o: e.o })),
      };
    }
  }

  const matchedSet = new Set(matchedIndices);
  const lastMatched = matchedIndices.length > 0 ? matchedIndices[matchedIndices.length - 1] : -1;
  const newEntries = incomingIdentities.filter((e) => !matchedSet.has(e.index));
  const splicedEntries = newEntries.filter((e) => e.index <= lastMatched);

  if (splicedEntries.length === 0) {
    // Pure tail growth — the re-serialization formula reproduces `messages`
    // unchanged, so skip building it and just report append-only.
    const canonicalEntries = priorCanonical.concat(newEntries.map((e) => ({ h: e.h, r: e.r, o: e.o })));
    return { action: "append-only", messages, canonicalEntries, inserted: newEntries.length };
  }

  if (splicedEntries.some((e) => e.r === "assistant")) {
    return {
      action: "reset",
      resetReason: "assistant-interleaved",
      canonicalEntries: incomingIdentities.map((e) => ({ h: e.h, r: e.r, o: e.o })),
    };
  }

  // Re-serialize: canonical order first, then ALL new entries (spliced and
  // tail alike) appended in their incoming relative order.
  const finalMessages = matchedIndices.map((idx) => messages[idx]).concat(newEntries.map((e) => messages[e.index]));

  if (!validateToolAdjacency(finalMessages)) {
    return {
      action: "reset",
      resetReason: "adjacency-violation",
      canonicalEntries: incomingIdentities.map((e) => ({ h: e.h, r: e.r, o: e.o })),
    };
  }

  const canonicalEntries = priorCanonical.concat(newEntries.map((e) => ({ h: e.h, r: e.r, o: e.o })));
  return { action: "normalized", messages: finalMessages, canonicalEntries, inserted: newEntries.length };
}

// --- Phase 3 classifier (pure) ---

function hasCacheControl(msg) {
  if (!msg || !Array.isArray(msg.content)) return false;
  return msg.content.some((b) => b && typeof b === "object" && b.cache_control);
}

function stripAllCacheControl(msg) {
  if (!msg || !Array.isArray(msg.content)) return msg;
  return {
    ...msg,
    content: msg.content.map((b) => {
      if (b && typeof b === "object" && b.cache_control) {
        const { cache_control, ...rest } = b;
        return rest;
      }
      return b;
    }),
  };
}

// Remove volatile blocks from a user message. When a canonical entry has
// no stored first-seen form (`m`), this IS the first-seen form: `m` is
// stored precisely when first-seen contained a volatile block, so its
// absence means first-seen had none — and stripping the incoming
// message's later-gained volatile blocks reproduces those bytes.
export function stripVolatileBlocks(msg) {
  if (!msg || msg.role !== "user" || !Array.isArray(msg.content)) return msg;
  const kept = msg.content.filter((b) => !isVolatileBlock(b));
  if (kept.length === msg.content.length) return msg;
  return { ...msg, content: kept };
}

function buildPinEntry(identity, msg) {
  const entry = { h: identity.h, r: identity.r, o: identity.o };
  if (
    msg?.role === "user" &&
    Array.isArray(msg.content) &&
    msg.content.some(isVolatileBlock)
  ) {
    // First-seen form, cache_control stripped: a marker the tail rotation
    // happened to leave on this message at creation must not be replayed
    // forever from the pin.
    entry.m = stripAllCacheControl(msg);
  }
  return entry;
}

// The bytes forwarded for a matched canonical entry. The pin applies only
// from the second appearance on: a NEW message (not yet canonical) always
// forwards as-is, so a fresh hook reminder reaches the model at the live
// edge; by the time the pin kicks in, the model has already consumed it.
// A message currently carrying a cache_control marker is never rewritten
// — markers sit at the tail, flips live deep, and losing a marker would
// cost more than one flip absorbs.
function pinnedForwardForm(stored, incomingMsg) {
  if (stored.r !== "user") return incomingMsg;
  if (hasCacheControl(incomingMsg)) return incomingMsg;
  return stored.m ?? stripVolatileBlocks(incomingMsg);
}

// --- Reminder-swap suppression (#76606, decision B) ---
//
// CC sometimes migrates a hook reminder OUT of the user message that
// carries it and INTO a standalone message of its own — measured directly
// (capture s-4b6a435234bf, n=26->28): message[30]'s <system-reminder>-wrapped
// block is gone from message[30] and its inner text, wrapper stripped,
// is the entire content of a new message[31] (role system). Pinning above
// restores message[30]'s first-seen bytes, reminder included; treating the
// new standalone as ordinary tail growth then forwards the SAME text a
// second time, and because it lands mid-array the cache's
// longest-identical-prefix boundary moves to right before it — everything
// after is re-billed (measured: cacheRead 15424 / cacheCreation 124025).
//
// Strip the wrapper for comparison ONLY — never for what gets forwarded;
// the pin already owns that. Reuses VOLATILE_WRAP_REGEX's capture group
// rather than a second regex, per the same rule cited above it.
function unwrapVolatileText(block) {
  if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") {
    return block;
  }
  const m = VOLATILE_WRAP_REGEX.exec(block.text);
  return m ? { type: "text", text: m[1] } : block;
}

// The set of block identities this extension is CURRENTLY restoring —
// i.e. present in a LIVE (not dropped) canonical entry's stored first-seen
// form. Dropped entries are excluded on purpose: their content is not being
// served anywhere, so a new standalone message matching a dropped block
// must flow through normally rather than being silently discarded with no
// copy left at all. Scoped to VOLATILE blocks only (isVolatileBlock), since
// those are what buildPinEntry ever stores `m` for and what the measured
// migration shape moves — a plain text block coincidentally matching a
// pinned message's ordinary content is not this class.
function pinnedBlockHashes(priorCanonical) {
  const hashes = new Set();
  if (!Array.isArray(priorCanonical)) return hashes;
  for (const entry of priorCanonical) {
    if (entry.d || !entry.m || !Array.isArray(entry.m.content)) continue;
    for (const block of entry.m.content) {
      if (!isVolatileBlock(block)) continue;
      const h = hashMessageContent({ content: [unwrapVolatileText(block)] });
      if (h !== null) hashes.add(h);
    }
  }
  return hashes;
}

// The merged-standalone shape (measured 2026-07-30, capture s-4b6a435234bf,
// msg864, the 587k window): CC sometimes migrates ALL of a message's
// volatile blocks out TOGETHER, joined into one standalone message,
// rather than one standalone per block. pinnedBlockHashes above can never
// match that — it hashes one block at a time, and a merged message is one
// block whose text spans two reminders. A second set covers exactly the
// observed join: for each pinned entry with >=2 volatile blocks, hash the
// concatenation of ALL its volatile blocks' wrapper-stripped texts, in
// WIRE order, joined with "\n\n" — the exact separator measured on the
// real merged standalone (both hook reminders, 627 chars). No
// subset-merges: partial joins were never observed and would only invite
// false suppression on coincidental partial matches. "\n\n" is hardcoded
// to the one observed instance, not a general N-ary merge grammar — other
// separators are unobserved, and the census keeps watching for them.
function pinnedJoinHashes(priorCanonical) {
  const hashes = new Set();
  if (!Array.isArray(priorCanonical)) return hashes;
  for (const entry of priorCanonical) {
    if (entry.d || !entry.m || !Array.isArray(entry.m.content)) continue;
    const volatileTexts = entry.m.content.filter(isVolatileBlock).map((b) => unwrapVolatileText(b).text);
    if (volatileTexts.length < 2) continue;
    const h = hashMessageContent({ content: [{ type: "text", text: volatileTexts.join("\n\n") }] });
    if (h !== null) hashes.add(h);
  }
  return hashes;
}

// Is `msg` a suppressible duplicate of a currently-pinned block (or, since
// 2026-07-30, a currently-pinned entry's FULL joined volatile-block set)?
// Narrow by definition (BACKLOG #76606 part (c)): STANDALONE only (single
// block after the same string->one-block fold canonicalMessageShape
// already applies elsewhere in this file), and its wrapper-stripped bytes
// must exactly equal a hash in `pinnedHashes` or `joinHashes` — never a
// positional or role heuristic. `joinHashes` is optional (existing callers
// checking single-block duplicates only are unaffected). Returns the
// matched hash (for telemetry) or null (genuine content: no suppression,
// existing rules apply unchanged).
export function findSuppressibleDuplicate(msg, pinnedHashes, joinHashes) {
  const shaped = canonicalMessageShape(msg);
  if (!Array.isArray(shaped.content) || shaped.content.length !== 1) return null;
  const h = hashMessageContent({ content: [unwrapVolatileText(shaped.content[0])] });
  if (h === null) return null;
  if (pinnedHashes.has(h)) return h;
  if (joinHashes && joinHashes.has(h)) return h;
  return null;
}

export { pinnedBlockHashes, pinnedJoinHashes };

// Pin-mode classification. Differences from classifyInsertion:
//   - identities exclude volatile blocks (flip absorption);
//   - canonical entries missing from incoming are marked dropped
//     (`d: true`, kept in the file, skipped in later matches) instead of
//     resetting — unless the dropped total passes half the canon, which
//     reads as a compaction, not a prune;
//   - matched user messages forward their first-seen form.
export function classifyPinned(messages, priorCanonical) {
  const incoming = computePinnedIdentities(messages);
  const freshEntries = () => incoming.map((e) => buildPinEntry(e, messages[e.index]));

  // A reset abandons the ORDER model. It must NOT abandon the PINS, and
  // conflating the two cost real cache — threat-matrix row 22, measured
  // 2026-07-28:
  //
  //   CC honestly replaced message 196, so reset(edit-shaped) was the right
  //   verdict and the cost belonged to 196+. But every reset returns without
  //   a `messages` field, so the caller forwards the incoming array raw — and
  //   that silently un-pinned message 177, whose first-seen <system-reminder>
  //   this extension had been restoring. Our bytes changed at 177 while CC's
  //   were byte-identical there, so the bust began 19 messages early.
  //
  // Identity deliberately EXCLUDES volatile blocks, so an identity still
  // present in priorCanonical names the same message and its stored
  // first-seen bytes are still the right bytes to send. Pinning substitutes
  // the CONTENT of a single user message and never adds, drops or reorders
  // one, so applying it on a reset cannot affect count, roles or adjacency.
  //
  // Deliberately NOT used by the adjacency-violation reset: that path exists
  // precisely because the pinned form broke tool adjacency, so it must send
  // the raw array.
  const priorByKey = new Map(
    (Array.isArray(priorCanonical) ? priorCanonical : []).map((e) => [identityKey(e), e]),
  );
  const resetKeepingPins = (resetReason) => {
    const out = messages.slice();
    let applied = 0;
    for (const e of incoming) {
      const stored = priorByKey.get(identityKey(e));
      if (!stored) continue;
      const fwd = pinnedForwardForm(stored, messages[e.index]);
      if (fwd !== messages[e.index] && JSON.stringify(fwd) !== JSON.stringify(messages[e.index])) {
        out[e.index] = fwd;
        applied++;
      }
    }
    // The canonical must describe the wire we JUST FORWARDED — the same
    // invariant the success path states. Building it from `messages` while
    // sending `out` makes the two disagree, and the next request then
    // diverges against a baseline that was never on the wire. Measured: that
    // mistake turned 0 violations into 3 before the
    // canonical was switched to the pinned array.
    return {
      action: "reset",
      resetReason,
      canonicalEntries: incoming.map((e) => buildPinEntry(e, out[e.index])),
      ...(applied > 0 ? { messages: out } : {}),
      pinned: applied,
    };
  };

  if (!Array.isArray(priorCanonical) || priorCanonical.length === 0) {
    return { action: "reset", resetReason: "no-prior-canonical", canonicalEntries: freshEntries() };
  }

  const incomingByKey = new Map(incoming.map((e) => [identityKey(e), e.index]));

  const matched = []; // { ci: index into priorCanonical, idx: incoming index }
  const droppedNow = new Set();
  let droppedBefore = 0;
  for (let ci = 0; ci < priorCanonical.length; ci++) {
    const stored = priorCanonical[ci];
    if (stored.d) {
      droppedBefore++;
      continue;
    }
    const idx = incomingByKey.get(identityKey(stored));
    if (idx === undefined) droppedNow.add(ci);
    else matched.push({ ci, idx });
  }
  for (let i = 1; i < matched.length; i++) {
    if (matched[i].idx <= matched[i - 1].idx) {
      return resetKeepingPins("not-subsequence");
    }
  }
  if (droppedBefore + droppedNow.size > priorCanonical.length / 2) {
    return resetKeepingPins("dropped-majority");
  }

  const matchedIdxSet = new Set(matched.map((m) => m.idx));
  const lastMatched = matched.length > 0 ? matched[matched.length - 1].idx : -1;
  const newEntries = incoming.filter((e) => !matchedIdxSet.has(e.index));
  const splicedEntries = newEntries.filter((e) => e.index <= lastMatched);

  // A true EDIT decomposes under drop-tolerance into drop + splice: the old
  // content's identity disappears and a new one appears IN ITS PLACE. That
  // must still reset — never paper over a real content change.
  //
  // But "a drop and a splice occurred in the same request" is too coarse a
  // test for it, because the two can be unrelated: measured 2026-07-28
  // (request 09:47:31) a tail message was pruned by an
  // operator interrupt while a hook reminder migrated mid-history 24 indices
  // away — one prune plus one insertion, neither an edit, reset anyway. That
  // single false positive was the last real reset in the corpus.
  //
  // Co-location is the discriminator: a dropped canonical entry sits in a
  // definite gap — between its nearest surviving predecessor and successor —
  // and only a spliced entry landing INSIDE that gap is a plausible
  // replacement for it. A splice elsewhere is an independent insertion.
  const matchedCi = new Set(matched.map((m) => m.ci));
  const isEdit = (() => {
    if (droppedNow.size === 0 || splicedEntries.length === 0) return false;
    const splicedIdx = splicedEntries.map((e) => e.index);
    for (const ci of droppedNow) {
      // Nearest surviving neighbours of the dropped entry, in incoming space.
      let lo = -1;
      for (let j = ci - 1; j >= 0; j--) {
        if (!matchedCi.has(j)) continue;
        lo = matched.find((m) => m.ci === j).idx;
        break;
      }
      let hi = Infinity;
      for (let j = ci + 1; j < priorCanonical.length; j++) {
        if (!matchedCi.has(j)) continue;
        hi = matched.find((m) => m.ci === j).idx;
        break;
      }
      if (splicedIdx.some((idx) => idx > lo && idx < hi)) return true;
    }
    return false;
  })();
  if (isEdit) {
    return resetKeepingPins("edit-shaped");
  }

  if (splicedEntries.some((e) => e.r === "assistant")) {
    return resetKeepingPins("assistant-interleaved");
  }

  // Suppress a NEW entry that duplicates a block this extension is already
  // restoring elsewhere (see the block comment above findSuppressibleDuplicate).
  // Assistant entries are excluded on principle even though the measured
  // shape never produces one — silently dropping the model's own prior
  // output is a correctness question this extension has no business
  // deciding, unlike a hook reminder it already owns via the pin.
  // Genuine change (normalized bytes differ from every pinned block):
  // findSuppressibleDuplicate returns null, the entry is untouched here,
  // and whatever the existing rules above already decided (append/splice/
  // edit-shaped reset) stands — no new reset path is introduced.
  // TAIL GUARD (BACKLOG.md, "suppression can strip a request's FINAL
  // message", 2026-07-30). Three real 400s ("must end with a user
  // message"): report-enforcer injects identical instruction bytes at
  // every SubagentStop; the first occurrence gets pinned, and when the
  // SAME bytes arrive again as the resume request's ONLY/new final
  // message, suppressing it left the forwarded array ending on the prior
  // assistant turn. A tail-position duplicate is never a stray migration
  // copy of already-pinned content — CC just sent it as the live,
  // load-bearing final entry of THIS request, and the model needs to see
  // it. Applies uniformly to both single-block and join-hash matches: the
  // guard is positional, not about which hash set matched.
  const lastIdx = messages.length - 1;
  const pinnedHashes = pinnedBlockHashes(priorCanonical);
  const pinnedJoin = pinnedJoinHashes(priorCanonical);
  const suppressions = [];
  for (const e of newEntries) {
    if (e.r === "assistant") continue;
    if (e.index === lastIdx) continue;
    const h = findSuppressibleDuplicate(messages[e.index], pinnedHashes, pinnedJoin);
    if (h !== null) suppressions.push({ index: e.index, hash: h });
  }
  const suppressedIdx = new Set(suppressions.map((s) => s.index));

  // Forwarded order is the INCOMING order, not "survivors then new". The two
  // agree for a plain append; they diverge when CC splices an entry
  // mid-history, and concatenating new entries at the end would then reorder
  // real content — the very thing this extension exists to prevent.
  let pinApplied = 0;
  const matchedByIdx = new Map(matched.map(({ ci, idx }) => [idx, ci]));
  const finalMessages = [];
  for (const e of incoming) {
    if (suppressedIdx.has(e.index)) continue; // the pinned inline form already carries these bytes
    const ci = matchedByIdx.get(e.index);
    if (ci === undefined) {
      finalMessages.push(messages[e.index]);
      continue;
    }
    const fwd = pinnedForwardForm(priorCanonical[ci], messages[e.index]);
    if (fwd !== messages[e.index] && JSON.stringify(fwd) !== JSON.stringify(messages[e.index])) {
      pinApplied++;
      finalMessages.push(fwd);
    } else {
      finalMessages.push(messages[e.index]);
    }
  }

  if (!validateToolAdjacency(finalMessages)) {
    return { action: "reset", resetReason: "adjacency-violation", canonicalEntries: freshEntries() };
  }

  // POSITIONAL canonical rebuild (2026-07-28). Appending new entries to the
  // tail records ARRIVAL order, not the order they occupy on the wire. When
  // CC splits a message — hook reminders migrating out of a user message into
  // their own system message is the measured case — the new entry is created
  // mid-history but was filed at the end. Canonical order and wire order then
  // disagreed permanently, and the next request touching that region failed
  // the strictly-increasing check with `not-subsequence`.
  //
  // Measured before this fix: an inversion at canonical
  // position 81 for an entry that sits at wire index 79, and every remaining
  // real reset in both corpora traced to exactly this.
  //
  // Rebuilding in incoming order fixes it. Dropped entries have no position
  // in the new array, so they are re-inserted after the last surviving entry
  // that preceded them — keeping them adjacent to their original neighbours
  // so a later un-prune still matches in order.
  const canonByIdx = new Map();
  for (const { ci, idx } of matched) canonByIdx.set(idx, priorCanonical[ci]);
  const newByIdx = new Map(newEntries.map((e) => [e.index, buildPinEntry(e, messages[e.index])]));
  const droppedAfter = new Map(); // incoming index -> canonical entries to trail it
  {
    let lastSeenIdx = -1;
    for (let ci = 0; ci < priorCanonical.length; ci++) {
      const entry = priorCanonical[ci];
      const hit = matched.find((m) => m.ci === ci);
      if (hit) {
        lastSeenIdx = hit.idx;
        continue;
      }
      const marked = entry.d ? entry : { ...entry, d: true };
      if (!droppedAfter.has(lastSeenIdx)) droppedAfter.set(lastSeenIdx, []);
      droppedAfter.get(lastSeenIdx).push(marked);
    }
  }
  const canonicalEntries = [];
  for (const trailing of droppedAfter.get(-1) ?? []) canonicalEntries.push(trailing);
  for (const e of incoming) {
    // A suppressed entry was never forwarded, so it gets no canonical
    // identity — the invariant just below states the canonical must
    // describe the wire we just forwarded, and this entry isn't on it.
    // Recomputed fresh on every request (findSuppressibleDuplicate against
    // the currently-live pins), so leaving no trace here is not a gap: CC
    // keeps re-sending the duplicate as long as it believes it's part of
    // history, and it is re-detected and re-suppressed every time — no
    // persisted "suppressed" marker is needed for the suppression to stay
    // stable across subsequent requests.
    if (suppressedIdx.has(e.index)) continue;
    canonicalEntries.push(canonByIdx.get(e.index) ?? newByIdx.get(e.index));
    for (const trailing of droppedAfter.get(e.index) ?? []) canonicalEntries.push(trailing);
  }

  const changed = splicedEntries.length > 0 || pinApplied > 0 || suppressions.length > 0;
  return {
    action: changed ? "normalized" : "append-only",
    messages: finalMessages,
    canonicalEntries,
    // ORDER INVARIANT (2026-07-28). The canonical we just wrote must describe
    // the wire we just forwarded: reading live entries in canonical order, the
    // wire index each occupies must be STRICTLY INCREASING.
    //
    // This is the mechanism behind every reset class this extension has had.
    // The arrival-order defect violated exactly this — canonical position 81
    // holding an entry that sits at wire index 79 — and was visible only
    // downstream, as a not-subsequence reset on a LATER request whose cause
    // had to be traced backwards. A size statistic cannot see it: a split adds
    // one canonical entry AND one wire message, so the counts stay equal while
    // the order diverges. Bite-tested both ways — a size-drift signal flagged
    // nothing; this check names the exact inversion.
    //
    // Reported, not asserted: a violation is a defect in OUR state model, so
    // it belongs in front of a developer with a location rather than being
    // swallowed by a silent reset.
    canonOrderViolation: (() => {
      const wireOf = new Map(incoming.map((e) => [identityKey(e), e.index]));
      let prev = -1;
      let seen = 0;
      for (const entry of canonicalEntries) {
        if (entry.d) continue;
        const idx = wireOf.get(identityKey(entry));
        if (idx === undefined) continue;
        seen++;
        if (idx <= prev) return { at: seen - 1, wireIdx: idx, prevWireIdx: prev };
        prev = idx;
      }
      return null;
    })(),
    // `inserted` counts what actually landed on the wire — a suppressed
    // entry was a new entry CC sent but never one we forwarded, so it must
    // not inflate this the way it would inflate a real insertion count.
    inserted: newEntries.length - suppressions.length,
    pinned: pinApplied,
    dropped: droppedNow.size,
    suppressed: suppressions.length,
    suppressions,
  };
}

// --- Extension contract ---

export default {
  name: "insertion-normalization",
  description:
    "Re-serialize a mid-history splice (queued message / hook attachment / " +
    "notification inserted earlier than its arrival) back into arrival " +
    "order so the prefix cache sees an append instead of a rewrite",
  enabled: false, // overridden by extensions.json
  order: 395,

  async onRequest(ctx) {
    if (!isEnabled()) return;
    if (!ctx || !ctx.body) return;

    const body = ctx.body;
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const dir = getSnapshotDir();
    const fs = DEFAULT_FS;
    const headers = ctx.headers || null;
    const sessionId = headers ? resolveSessionId(headers) : null;
    const sessionKey = resolveInsertionSessionKey(headers, messages, body.system);

    try {
      const pin = isPinEnabled();
      const mode = pin ? "pin" : "plain";
      const prior = await loadCanonical(dir, sessionKey, fs, mode);
      const result = pin ? classifyPinned(messages, prior) : classifyInsertion(messages, prior);

      // Apply whatever the classifier produced, rather than keying on the
      // action name. A reset now returns a pinned array too (row 22): the
      // order model is abandoned, the pins are not. `append-only` returns the
      // incoming array unchanged, so this stays a no-op there.
      if (result.messages) {
        body.messages = result.messages;
      }

      await saveCanonical(dir, sessionKey, result.canonicalEntries, fs, mode);

      ctx.meta = ctx.meta || {};
      // canonSize / canonLive / msgs expose the STATE, not just the verdict.
      // The append-vs-position defect (canonical entries filed in arrival
      // order while sitting mid-history on the wire) was invisible in
      // action + resetReason alone — it surfaced only as a canonical grown to
      // 92 entries for an 84-message history. A state model drifting from the
      // wire is the failure mode behind every reset class this extension has
      // had, so the sizes belong in the telemetry tools/replay.mjs --trace
      // reads.
      ctx.meta.insertionNormalizeStats = {
        action: result.action,
        inserted: result.inserted ?? 0,
        resetReason: result.resetReason,
        canonSize: result.canonicalEntries?.length ?? 0,
        canonLive: result.canonicalEntries?.filter((e) => !e.d).length ?? 0,
        msgs: messages.length,
        canonOrderViolation: result.canonOrderViolation ?? null,
        // `suppressions` (not just the count) rides on the stats object —
        // tools/replay.mjs's safety-gate exemption reads the incoming
        // indices from here to declare them, the same way it already reads
        // deferred-tool-rewrite's tool_addition shape.
        ...(pin
          ? {
              pinned: result.pinned ?? 0,
              dropped: result.dropped ?? 0,
              suppressed: result.suppressed ?? 0,
              suppressions: result.suppressions ?? [],
            }
          : {}),
      };

      await appendTelemetry(
        dir,
        sessionKey,
        {
          ts: new Date().toISOString(),
          key: sessionKey,
          sid: sessionId,
          action: result.action,
          inserted: result.inserted ?? 0,
          ...(result.resetReason ? { resetReason: result.resetReason } : {}),
          ...(pin ? { pinned: result.pinned ?? 0, dropped: result.dropped ?? 0, suppressed: result.suppressed ?? 0 } : {}),
        },
        fs,
      );

      // One event line PER SUPPRESSION (not aggregated into the summary
      // line above), to the same file/format — the pattern every other
      // record in this log already uses, just one call per occurrence
      // instead of once per request.
      if (pin && Array.isArray(result.suppressions) && result.suppressions.length) {
        for (const s of result.suppressions) {
          await appendTelemetry(
            dir,
            sessionKey,
            {
              ts: new Date().toISOString(),
              key: sessionKey,
              sid: sessionId,
              event: "suppressed-duplicate",
              index: s.index,
              hash: s.hash,
            },
            fs,
          );
        }
      }

      if (isDebug()) {
        process.stderr.write(
          `[insertion-normalize] action=${result.action} inserted=${result.inserted ?? 0}` +
            (result.resetReason ? ` reason=${result.resetReason}` : "") +
            (pin ? ` pinned=${result.pinned ?? 0} dropped=${result.dropped ?? 0} suppressed=${result.suppressed ?? 0}` : "") +
            "\n",
        );
      }
    } catch (err) {
      debug(`onRequest unexpected: ${err?.message ?? err}`);
    }
  },
};
