// prefix-diff — diagnostic extension for hunting cache-bust sources.
//
// On every request, snapshots a projection of everything the prompt cache
// keys on and diffs it against the previous request's snapshot. Writes
// three artifacts under `~/.claude/cache-fix-snapshots/`:
//
//   <key>-last.json    latest snapshot (overwritten; the diff baseline)
//   <key>-diff.json    latest diff, full detail (overwritten)
//   <key>-events.jsonl append-only ledger, one bounded record per diff
//
// No request mutation. Fail-open: any I/O error is swallowed. Set
// CACHE_FIX_DEBUG=1 to also log swallowed errors.
//
// Permissions + retention (2026-08-05, reviewer-requested — the rewrite
// below persists more than the old diagnostic did, and the persistence
// story had to catch up):
//
//   - All three artifacts, and their rotated forms, are written owner-only
//     (0600) via write-owner-only.mjs, applied at create time so there is
//     no window where a file is briefly group- or world-readable.
//   - CONTENT MINIMIZATION. By default this module persists only hashes,
//     lengths, and indices — enough to say WHICH block/message/index
//     changed, never the bytes that changed. Full text (system-block
//     windows, message previews, event-record previews) is stored only
//     under CACHE_FIX_PREFIXDIFF_CONTENT=1. Enabling it persists
//     prompt-derived text to disk; it is an explicit, separate opt-in from
//     CACHE_FIX_PREFIXDIFF itself.
//   - CROSS-KEY RETENTION. A sweep runs once per process (the first live
//     request — there is no dedicated boot hook) deleting artifacts older
//     than 14 days and, if more than 200 session keys remain, pruning the
//     oldest keys beyond that cap. This bounds the snapshot directory
//     across sessions; the pre-existing per-key tenant eviction only
//     bounded the map inside one key's own file.
//
// ---------------------------------------------------------------------
// Design notes — the four blind spots this version closes (2026-07-27)
//
// A resume-after-quit bust was traced to `system=DIFFER` and went no
// further: the tooling could say the system prompt changed but not which
// block, let alone which bytes. Investigating that turned up four ways
// the diagnostic could report nothing, or report something misleading,
// on exactly the events it exists to catch.
//
// 1. SELF-DEFEATING KEY. The session key was
//    `sha256(JSON.stringify(system).slice(0, 2000))` — derived from one
//    of the very things being diffed. A system-prompt change inside that
//    2000-char window changed the key, so the lookup missed the prior
//    snapshot, so NO diff was written and NO line was logged. The most
//    important bust class could vanish without a trace, and whether it
//    did came down to whether the changed bytes happened to sit before
//    or after char 2000. The key now comes from the request's session-id
//    header (`resolveSessionId`) — an identifier that cannot drift with
//    the content it indexes. The content hash remains only as a fallback
//    for requests without the header.
//
// 2. SELF-ERASING EVIDENCE. `<key>-diff.json` was a single fixed path
//    rewritten on every diff, so a bust's detail survived only until the
//    next one — minutes, in an active session. Post-mortems ran against
//    a file that had already been overwritten. The full-detail file
//    stays (it is the convenient "what just happened" view), but every
//    diff now also appends a bounded record to `<key>-events.jsonl`,
//    which is never rewritten in place.
//
// 3. NAME-ONLY TOOL HASHING. `toolsHash` hashed `tools.map(t => t.name)`.
//    Schema and description changes — MCP servers reconnecting with
//    revised definitions, a tool gaining a parameter — were invisible,
//    and `tools=match` was routinely reported for a tools array whose
//    bytes had changed. Tools are now hashed over their full JSON, with
//    a per-tool hash so a diff names the specific tool.
//
// 4. OPAQUE SYSTEM HASH. One hash over the whole system array answered
//    "did it change" and nothing else. Snapshots now store each block's
//    full text (capped), so a diff reports the changed block's index,
//    label, first differing character offset, and a context window from
//    both sides — byte-level evidence rather than a boolean.
//
// Two further gaps closed at the same time:
//   - TOP-LEVEL PARAMS (model, temperature, max_tokens, thinking, …)
//     were not snapshotted at all, yet a change to any of them changes
//     the cache key. A model switch mid-session read as "0 differences".
//   - MESSAGE-ARRAY MIDDLE. Head (5) + markers (8) + tail (3) windows
//     leave a long session's middle unobserved. Every message is now
//     hashed — cheap, ~40 bytes each — so the diff reports the exact
//     first divergent index regardless of where it lands. The three
//     windows remain, now as detail providers for the region the hash
//     chain points at.
//
// The organising rule, learned the hard way: the snapshot must cover
// everything the cache keys on, and the key under which it is stored
// must not be one of those things.
//
// Closing the diagnostic's own blind spots (2026-07-27, same day): the
// tool that hunts cache busts had three of its own. `output_config`
// (effort — "each effort level has its own cache"), `speed` (fast mode
// — adds a request header that is part of the cache key) and `betas`
// were body params TRACKED_PARAMS never listed, so an effort or
// fast-mode change read as "0 differences" the same way an untracked
// model switch used to. They're plain entries in TRACKED_PARAMS now;
// diffParams already deep-compares by JSON.stringify, so an object
// param like `output_config` (effort lives inside it) diffs correctly
// with no extra code. The fourth blind spot lived outside `ctx.body`
// entirely: the anthropic-beta REQUEST HEADER (e.g.
// context-1m-2025-08-07 — see auto-1m-guard.mjs, which exists because
// of exactly this header) is part of the cache key but was never
// snapshotted at all, so a beta-header-only bust — an effort/speed
// change never touches it either — was unattributable. `ctx.headers`
// reaches onRequest hooks (see pipeline.mjs's runOnRequest and every
// extension that reads `ctx.headers`), so the header is now snapshotted
// via auto-1m-guard's own `findBetaHeader`/`parseBetaTokens` and diffed
// as a normalized, sorted token set — order doesn't change the cache
// key, only membership does.
// ---------------------------------------------------------------------

import {
  mkdir as _mkdir,
  readFile as _readFile,
  writeFile as _writeFile,
  rename as _rename,
  appendFile as _appendFile,
  stat as _stat,
  readdir as _readdir,
  unlink as _unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { claudeHome } from "../claude-home.mjs";
import { resolveSessionId } from "./cache-telemetry.mjs";
import { findBetaHeader, parseBetaTokens } from "./auto-1m-guard.mjs";
import { writeFileOwnerOnly, appendFileOwnerOnly, ensureOwnerOnly } from "./write-owner-only.mjs";

const ENABLED = process.env.CACHE_FIX_PREFIXDIFF === "1";
const DEBUG = process.env.CACHE_FIX_DEBUG === "1";
// Content minimization (2026-08-05, reviewer-requested): by default this
// module persists only hashes, lengths, and indices — enough to say WHICH
// block/message/index changed, never the bytes that changed. Full text
// (system-block windows, message previews, event-record previews) is
// stored only when this is explicitly opted into. Off by default because
// the whole point of the default mode is that prompt-derived text never
// rests on disk.
const CONTENT_ENABLED = process.env.CACHE_FIX_PREFIXDIFF_CONTENT === "1";

// This extension's pipeline order (dev-loop.md, "Tap points"). A bare index
// was equated across tap points during the 587k attribution — a raw-capture
// index (order 60) read as if it were this module's forwarded-body index
// (order 680), naming the wrong message. Every record this module emits now
// carries WHICH tap point its indices belong to, so a reader (or a future
// attribution) never has to guess or re-derive it. Single source: the
// default export's `order` field reads this same constant rather than
// duplicating the literal.
const TAP_ORDER = 680;
const TAP_VIEW = `forwarded@${TAP_ORDER}`;

const DEFAULT_FS = {
  mkdir: _mkdir,
  readFile: _readFile,
  writeFile: _writeFile,
  rename: _rename,
  appendFile: _appendFile,
  stat: _stat,
  readdir: _readdir,
  unlink: _unlink,
};

// Per-block system text is stored in full so diffs can locate exact bytes.
// Capped so a pathological block can't bloat the snapshot; the cap is far
// above any real Claude Code system block.
const SYSTEM_TEXT_CAP = 20000;
// Context window shown either side of a byte-level divergence.
const DIVERGENCE_WINDOW = 120;
const MARKER_CAP = 8;
const MARKER_PREVIEW_CHARS = 200;
// Per-message preview carried on every messageHashes entry. Deliberately
// shorter than the marker preview: this one is paid on EVERY message of
// every snapshot, so it trades detail for a bounded per-request cost.
// Enough to recognise which message an index refers to and see whether its
// opening bytes moved; not a substitute for the full body.
const MESSAGE_PREVIEW_CHARS = 120;
// Rotate the append-only ledger past this size so it cannot grow forever.
const EVENTS_MAX_BYTES = 5 * 1024 * 1024;

// Cross-key retention (2026-08-05, reviewer-requested): the per-tenant
// eviction above (MAX_TENANTS) only bounds the map INSIDE one session
// key's file. Every new session key gets its own `-last.json`/`-diff.json`/
// `-events.jsonl` triple, and nothing bounded the number of keys or their
// total age — a long-lived proxy could accumulate snapshot files forever.
// Two independent bounds, both enforced by the boot sweep below: any
// artifact past this age is deleted regardless of key count, and once
// fewer than this many keys remain, the oldest keys beyond the cap are
// deleted regardless of age.
const SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SNAPSHOT_MAX_KEYS = 200;

// Top-level request fields that participate in the cache key. Anything
// here changing invalidates the prefix, so all of it must be snapshotted.
const TRACKED_PARAMS = [
  "model",
  "max_tokens",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "thinking",
  "tool_choice",
  "service_tier",
  "anthropic_version",
  // Added 2026-07-27 (blind-spot closure): each of these participates in
  // the cache key exactly like the params above, per Claude Code's own
  // caching docs — output_config (effort: "each effort level has its own
  // cache"), speed (fast mode: "adds a request header that is part of
  // the cache key"), betas (the anthropic-beta BODY param some call
  // sites use instead of the header — see the header-based tracking
  // below for the header form). diffParams already deep-compares via
  // JSON.stringify, so output_config's nested effort field diffs
  // correctly with no dedicated code.
  "output_config",
  "speed",
  "betas",
];

function getSnapshotDir() {
  return join(claudeHome(), "cache-fix-snapshots");
}

function debug(msg) {
  if (DEBUG) process.stderr.write(`[prefix-diff] ${msg}\n`);
}

function sha(value, len = 16) {
  return createHash("sha256").update(value).digest("hex").slice(0, len);
}

// Fallback key only. Prefer resolveSessionKey(), which reads the session-id
// header — a key derived from the diffed content is the blind spot that
// made busts disappear (see design note 1).
function computeSessionKey(system) {
  return sha(JSON.stringify(system).slice(0, 2000), 12);
}

/**
 * Storage key for a request. The session-id header is stable across the
 * life of a conversation and independent of the payload, so a snapshot
 * stays findable no matter what changed inside it. Content hash is the
 * fallback when no header is present (direct API calls, tests).
 *
 * The FILE key stays the session id alone — deliberately. Co-tenant
 * separation happens inside the file (see `tenantId`), never by moving the
 * path: a path that moves with content is design note 1's blind spot, where
 * a changed system prompt misses its baseline and the bust is never logged.
 */
function resolveSessionKey(headers, system) {
  const sid = headers ? resolveSessionId(headers) : null;
  if (sid) return `s-${sha(sid, 12)}`;
  return computeSessionKey(system);
}

/**
 * Which conversation a request belongs to, WITHIN one session id.
 *
 * The session-id header is not unique per conversation: a main session,
 * every subagent it dispatches, and Claude Code's own background calls
 * (title generation and friends) all carry the same id. With a single
 * baseline per session, the diff compared each request against whichever
 * co-tenant happened to go last, so conversations advancing normally
 * rendered as violent prefix churn:
 *
 *     msgs: 80->82   (main advancing)
 *     msgs: 82->40   model: opus-5 -> sonnet-5   <- subagent's turn
 *     msgs: 40->43   (subagent advancing)
 *     msgs: 43->2    (a small background call)
 *
 * Nothing is wrong in that trace, but it reads as thrashing — and it was
 * read that way on 2026-07-27, as the cause of a 93k bust it had nothing
 * to do with (cache_read climbed straight through; nothing was evicted).
 * A diagnostic that manufactures false causes is worse than none, so each
 * tenant gets its own baseline — stored side by side under the SAME file
 * key, so nothing has to move. Same remedy insertion-normalization applies
 * to its persisted canonical (commit e0bb7f2).
 *
 * Identity comes from `x-claude-code-agent-id` when CC sets it — that is
 * authoritative and immune to prompt edits. It is often absent
 * (workflow-agent-id-synthesis.mjs exists precisely because CC omits it
 * for Workflow legs, CC#66761), so the fallback is the leading system
 * block, which identifies the agent ("You are an interactive agent…" vs a
 * subagent's brief) and is stable for a conversation's life.
 *
 * The fallback cannot be made exact: `workflow-agent-derivation.mjs:40-55`
 * establishes that CC keeps agentId/agentType/run-id in IN-PROCESS state,
 * never on the wire, and the Messages API has no slots for them. So a new
 * tenant and a mid-conversation system-prompt change are genuinely
 * indistinguishable from here; the read path below labels that case rather
 * than guessing, and keeps the evidence either way.
 */
function tenantId(headers, system) {
  const agentId = headers?.["x-claude-code-agent-id"];
  if (agentId) return sha(String(agentId), 8);
  let text = "none";
  if (typeof system === "string") text = system;
  else if (Array.isArray(system)) {
    const first = system[0];
    const t = typeof first === "string" ? first : first?.text;
    if (typeof t === "string") text = t;
  }
  // FULL text, not a prefix. Truncating to 400 chars made two conversations
  // with the same long preamble collide into one tenant, silently merging
  // their baselines — and a merged baseline is exactly the "sidecar churn"
  // artifact this function exists to remove. Found 2026-07-28 by an audit
  // sweep; same class as the session-key collisions fixed in
  // insertion-normalization and deferred-tool-rewrite the same day: an
  // identity computed more cheaply than the thing it identifies will collide,
  // and the collision presents as churn rather than as a bug.
  //
  // Hashing the whole block costs one pass over a string already in memory.
  // Agent-id short-circuits above when present, so this path is for traffic
  // that carries no agent header.
  return sha(text, 8);
}

// Full-JSON tool hashing (design note 3) plus per-tool hashes so a diff
// can name the tool that changed rather than only that something did.
function buildToolsSnapshot(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { hash: "none", count: 0, tools: [] };
  }
  const entries = tools.map((t, i) => ({
    index: i,
    name: t?.name ?? `<unnamed:${i}>`,
    hash: sha(JSON.stringify(t ?? null)),
    bytes: JSON.stringify(t ?? null).length,
  }));
  return {
    // Order-sensitive: reordering tools changes the request bytes, so it
    // is a real bust cause and must not hash equal.
    hash: sha(JSON.stringify(entries.map((e) => [e.name, e.hash]))),
    count: entries.length,
    tools: entries,
  };
}

// Backwards-compatible scalar hash (kept for the snapshot's flat field and
// for callers/tests that only need "did tools change at all").
function computeToolsHash(tools) {
  return buildToolsSnapshot(tools).hash;
}

function computeSystemHash(system) {
  if (!system) return "none";
  return sha(JSON.stringify(system));
}

// A short human label for a system block, so a diff line reads
// "block 2 (env)" instead of "block 2". Derived from content because
// the API gives blocks no identity of their own.
//
// The fixed categories below are safe to return regardless of
// `contentEnabled`: each is a constant string naming a recognized shape,
// never a slice of the block's own bytes. Only the last-resort fallback
// (an unrecognized block) used to echo the block's own leading text as
// the label — that is prompt-derived content leaking through a field that
// looks like metadata, so it is gated the same as everything else content
// minimization covers.
function labelSystemBlock(text, contentEnabled = true) {
  if (typeof text !== "string" || text.length === 0) return "empty";
  const head = text.slice(0, 200).replace(/\s+/g, " ").trim();
  if (/^You are Claude Code/i.test(head)) return "cc-identity";
  if (/claudeMd|CLAUDE\.md/.test(head)) return "claude-md";
  if (/<env>|Working directory|Platform:/i.test(head)) return "env";
  if (/billing|x-anthropic-billing/i.test(head)) return "billing";
  if (/system-reminder/i.test(head)) return "system-reminder";
  if (/available skills|Skill tool/i.test(head)) return "skills";
  if (/agent types|subagent_type/i.test(head)) return "agents";
  if (!contentEnabled) return "other";
  return head.slice(0, 40) || "text";
}

// Store each system block's full text (capped) rather than one opaque
// hash, so computeDiff can point at the exact bytes that moved — but only
// when `contentEnabled` (CACHE_FIX_PREFIXDIFF_CONTENT=1). Content
// minimization (2026-08-05): by default `text` is omitted entirely and
// only structural metadata (index, type, label, chars, hash,
// hasCacheControl, truncated) is stored, so a system-prompt byte never
// rests on disk unless the operator opted into it. `chars`/`hash` still
// give computeDiff enough to say WHICH block changed and by how much;
// `text` is what it needs to say HOW.
function buildSystemSnapshot(system, contentEnabled = true) {
  if (typeof system === "string") {
    return [
      {
        index: 0,
        type: "string",
        label: labelSystemBlock(system, contentEnabled),
        chars: system.length,
        hash: sha(system),
        truncated: system.length > SYSTEM_TEXT_CAP,
        ...(contentEnabled ? { text: system.slice(0, SYSTEM_TEXT_CAP) } : {}),
      },
    ];
  }
  if (!Array.isArray(system)) return [];
  return system.map((block, i) => {
    const text = typeof block?.text === "string" ? block.text : "";
    // Hash the whole block, not just its text — cache_control placement
    // and any other field are part of the request bytes.
    const { cache_control, ...rest } = block ?? {};
    return {
      index: i,
      type: block?.type ?? "unknown",
      label: labelSystemBlock(text, contentEnabled),
      chars: text.length,
      hash: sha(JSON.stringify(rest)),
      hasCacheControl: Boolean(cache_control),
      truncated: text.length > SYSTEM_TEXT_CAP,
      ...(contentEnabled ? { text: text.slice(0, SYSTEM_TEXT_CAP) } : {}),
    };
  });
}

function buildParamsSnapshot(payload) {
  const params = {};
  for (const key of TRACKED_PARAMS) {
    if (payload && payload[key] !== undefined) params[key] = payload[key];
  }
  return params;
}

// Snapshot of the anthropic-beta REQUEST HEADER (blind spot: this is a
// header, not a body param, so it lives outside `payload` entirely and
// TRACKED_PARAMS can never cover it). Reuses auto-1m-guard's own
// findBetaHeader/parseBetaTokens — the same idiom that extension uses to
// read this exact header — rather than re-deriving header-lookup logic.
// Tokens are stored SORTED: reordering the header (e.g. CC re-serializing
// the same beta set in a different order) does not change the cache key,
// only membership does, so a sorted set is the right comparison basis.
// `present: false` (no header on the request) is a real, distinct state
// from "header present but empty" — both are normalized to an empty
// tokens array, but callers reading `present` can still tell them apart
// if that ever matters.
function buildBetaHeaderSnapshot(headers) {
  const found = findBetaHeader(headers || null);
  if (!found) return { present: false, tokens: [] };
  const tokens = parseBetaTokens(found.raw).slice().sort();
  return { present: true, tokens };
}

// Diff two beta-header snapshots by set membership (order-insensitive by
// construction, since tokens are stored pre-sorted). Old-format snapshots
// (pre-2026-07-27) have no `betaHeader` field at all — the `?? {tokens:
// []}` default treats "field absent" identically to "header absent",
// which is the correct degrade: nothing to compare against means no
// spurious cause on the first request after upgrade (design note: version-
// boundary safety, same rule as systemBlockDiffs/toolDiffs/paramDiffs).
function diffBetaHeader(prevSnap, nowSnap) {
  const prevTokens = new Set((prevSnap ?? { tokens: [] }).tokens ?? []);
  const nowTokens = new Set((nowSnap ?? { tokens: [] }).tokens ?? []);
  const added = [...nowTokens].filter((t) => !prevTokens.has(t));
  const removed = [...prevTokens].filter((t) => !nowTokens.has(t));
  return { added, removed };
}

// Rough content size, safe to store regardless of `contentEnabled` — a
// length, never the bytes themselves.
function charLength(value) {
  if (typeof value === "string") return value.length;
  return JSON.stringify(value ?? null).length;
}

// Project a single message for the head/tail windows.
//
// contentEnabled: strip cache_control, truncate text >500 chars with
// `...[N chars]` marker. Pure: returns a new object, never mutates input.
// Shared by the head and tail windows so both apply identical truncation
// rules.
//
// !contentEnabled (content minimization, 2026-08-05): a single
// hash-over-the-whole-message plus a size, and nothing else. This is
// deliberately NOT a per-block redaction (drop `text`, keep `input`/
// `content` blocks as-is) — a tool_use block's `input` or a tool_result's
// `content` can carry arbitrary prompt- or tool-output-derived text just
// as easily as a `text` block can, and the old per-block truncation only
// ever capped `.text`. Hashing the whole message (via the same
// stripCacheControl used for the always-on hash chain) covers every
// content shape uniformly, so no block type is an accidental content
// leak. Attribution survives: diffMessageWindow still detects a change at
// this position via the hash, and messageChain (buildMessageHashes, which
// covers every index, not just the head/tail windows) already names the
// exact first divergent index and role.
function truncateOneMessage(msg, contentEnabled = true) {
  if (!contentEnabled) {
    return {
      role: msg?.role,
      hash: sha(JSON.stringify(stripCacheControl(msg ?? {})), 12),
      chars: charLength(msg?.content),
    };
  }
  if (!msg || !Array.isArray(msg.content)) {
    return { role: msg?.role, content: msg?.content };
  }
  const cleanedContent = msg.content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const { cache_control, ...rest } = block;
    if (typeof rest.text === "string" && rest.text.length > 500) {
      return {
        ...rest,
        text: rest.text.slice(0, 500) + `...[${rest.text.length} chars]`,
      };
    }
    return rest;
  });
  return { role: msg.role, content: cleanedContent };
}

// Strip cache_control WITHOUT truncating. The hash chain must not be
// blind to a change past char 500 — truncation there would report
// "match" for genuinely different bytes.
function stripCacheControl(msg) {
  if (!msg || !Array.isArray(msg.content)) {
    return { role: msg?.role, content: msg?.content };
  }
  return {
    role: msg.role,
    content: msg.content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const { cache_control, ...rest } = block;
      return rest;
    }),
  };
}

// Hash EVERY message (design note: message-array middle). ~40 bytes per
// entry, so even a 1000-turn session costs ~40KB — cheap enough to make
// the head/marker/tail windows detail providers rather than the only
// detection surface.
// `p` (the per-message preview) is real prompt content and is stored only
// under `contentEnabled` (content minimization, 2026-08-05) — omitted
// entirely otherwise, the same "field absent on an older/degraded
// snapshot" shape this file already uses everywhere a version boundary
// needs to degrade instead of throw. `h` (the hash) is unaffected: it is
// always computed and always stored, because it is what carries the
// attribution value in default mode.
function buildMessageHashes(messages, contentEnabled = true) {
  if (!Array.isArray(messages)) return [];
  return messages.map((msg, i) => ({
    i,
    role: msg?.role ?? "unknown",
    h: sha(JSON.stringify(stripCacheControl(msg)), 12),
    // Bounded preview on EVERY index, not just the head/tail windows.
    // Rationale: the hash tells you an index changed, never how. A
    // mid-history bust (2026-07-27, `messages@83(user)`, ~93k) was
    // unattributable afterwards because index 83 falls outside head-5 and
    // tail-3, and nothing else stored its content. A preview costs
    // MESSAGE_PREVIEW_CHARS per message and makes the ledger
    // self-sufficient for exactly the class that previously needed the
    // live request — which by then no longer exists.
    ...(contentEnabled ? { p: messageTextPreview(msg, MESSAGE_PREVIEW_CHARS) } : {}),
  }));
}

// Project the first 5 messages (the head window): strip cache_control,
// truncate text >500 chars with `...[N chars]` marker.
function truncatePrefixMessages(messages, contentEnabled = true) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(0, 5).map((m) => truncateOneMessage(m, contentEnabled));
}

// Project the last 3 messages (the tail window), same truncation rules as
// the head window. Catches busts near the live edge of long sessions that
// the head window (fixed at the start of the array) can never see.
function truncateTailMessages(messages, contentEnabled = true) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-3).map((m) => truncateOneMessage(m, contentEnabled));
}

// True if `msg` carries at least one content block with a cache_control
// marker. These are exactly the boundaries the API caches against.
function hasCacheControl(msg) {
  if (!msg || !Array.isArray(msg.content)) return false;
  return msg.content.some((b) => b && typeof b === "object" && b.cache_control);
}

// Bounded preview of a message's content, first N chars. Used for the
// marker window and the per-index preview (not the full truncated-content
// detail the head/tail windows carry).
//
// Covers every content shape, not just text blocks. The original
// text-blocks-only version returned null for string-content messages and
// ""/null for tool_use- or tool_result-only messages — which are exactly
// the shapes mid-history mutations kept landing on (2026-07-27: several
// `messages@N(system)`/`(user)` mutation events carried null previews on
// both sides, and a 37k bust on 2026-07-28 was unattributable because
// every divergent message was tool-shaped). A preview that can be empty
// only when the content is empty keeps the ledger self-sufficient.
function messageTextPreview(msg, maxChars = MARKER_PREVIEW_CHARS) {
  if (!msg) return null;
  if (typeof msg.content === "string") return msg.content.slice(0, maxChars);
  if (!Array.isArray(msg.content)) return null;
  const parts = [];
  for (const b of msg.content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool_use") {
      parts.push(`[tool_use:${b.name ?? "?"} ${JSON.stringify(b.input ?? null)}]`);
    } else if (b.type === "tool_result") {
      const inner =
        typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? null);
      parts.push(`[tool_result${b.is_error ? ":error" : ""} ${inner}]`);
    } else if (b.type === "thinking") {
      // Redacted on purpose: thinking bytes are the longest and least
      // diagnostic; the block's presence is what matters for a diff.
      parts.push("[thinking]");
    } else {
      parts.push(`[${b.type ?? "unknown"}]`);
    }
  }
  return parts.join(" ").slice(0, maxChars);
}

// Hash a message's cache_control-stripped content. Used for the marker
// window so stored entries stay small (hash + preview, not full bodies).
function hashMessageContent(msg) {
  return sha(JSON.stringify(truncateOneMessage(msg)));
}

// Build the marker window: one entry per message carrying a cache_control
// block, in array order, capped at MARKER_CAP entries. Each entry stores
// only a hash + short preview, not the full message body — long sessions
// can accumulate many turns, and this window must stay cheap regardless
// of session length.
function buildMarkerSnapshot(messages, contentEnabled = true) {
  if (!Array.isArray(messages)) return [];
  const markers = [];
  for (let i = 0; i < messages.length && markers.length < MARKER_CAP; i++) {
    const msg = messages[i];
    if (!hasCacheControl(msg)) continue;
    markers.push({
      index: i,
      hash: hashMessageContent(msg),
      // Real content — same content-minimization gate as everywhere else
      // (2026-08-05): omitted unless contentEnabled.
      ...(contentEnabled ? { textPreview: messageTextPreview(msg) } : {}),
    });
  }
  return markers;
}

function buildSnapshot(payload, headers, contentEnabled = true) {
  if (!payload || !payload.system) return null;
  return {
    timestamp: new Date().toISOString(),
    messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0,
    toolsHash: computeToolsHash(payload.tools),
    systemHash: computeSystemHash(payload.system),
    // Coverage added 2026-07-27 — see design notes at the top.
    params: buildParamsSnapshot(payload),
    // Every builder below that can carry raw prompt bytes takes
    // `contentEnabled` and gates on it (content minimization, 2026-08-05,
    // CACHE_FIX_PREFIXDIFF_CONTENT=1) — gating once here, at the single
    // point everything downstream (computeDiff, buildEventRecord) reads
    // from, means no consumer has to re-check the flag: an omitted field
    // degrades the same way an old-format snapshot's missing field
    // already does everywhere else in this file.
    systemBlocks: buildSystemSnapshot(payload.system, contentEnabled),
    toolsDetail: buildToolsSnapshot(payload.tools),
    messageHashes: buildMessageHashes(payload.messages, contentEnabled),
    prefixMessages: truncatePrefixMessages(payload.messages, contentEnabled),
    tailMessages: truncateTailMessages(payload.messages, contentEnabled),
    markerMessages: buildMarkerSnapshot(payload.messages, contentEnabled),
    // Blind spot 5 (2026-07-27): the anthropic-beta header lives outside
    // `payload`, so it's threaded in separately rather than read off the
    // body like everything else above. `headers` is optional — direct
    // callers (tests, the fallback content-hash path) that don't have a
    // headers object get {present:false, tokens:[]}, the same shape an
    // old-format snapshot degrades to on diff.
    betaHeader: buildBetaHeaderSnapshot(headers),
  };
}

// Positional diff over two arrays of truncated messages (used for both the
// head and tail windows — same shape, same comparison rule: serialize and
// compare by array position).
function diffMessageWindow(prevMsgs, nowMsgs) {
  const diffs = [];
  const maxIdx = Math.max(prevMsgs.length, nowMsgs.length);
  for (let i = 0; i < maxIdx; i++) {
    const prevSer = JSON.stringify(prevMsgs[i] ?? null);
    const nowSer = JSON.stringify(nowMsgs[i] ?? null);
    if (prevSer !== nowSer) {
      diffs.push({ index: i, prev: prevMsgs[i] ?? null, now: nowMsgs[i] ?? null });
    }
  }
  return diffs;
}

// Diff the marker window. Markers are keyed by their message index in the
// original array (not by position in the marker list) so a shift caused by
// markers entering/leaving the cap doesn't read as spurious churn — each
// entry reports the marker's message index directly, as the diff consumer
// needs to know which prefix boundary moved.
function diffMarkerWindow(prevMarkers, nowMarkers) {
  const prevByIdx = new Map((prevMarkers ?? []).map((m) => [m.index, m]));
  const nowByIdx = new Map((nowMarkers ?? []).map((m) => [m.index, m]));
  const allIdx = new Set([...prevByIdx.keys(), ...nowByIdx.keys()]);
  const diffs = [];
  for (const idx of [...allIdx].sort((a, b) => a - b)) {
    const prevM = prevByIdx.get(idx) ?? null;
    const nowM = nowByIdx.get(idx) ?? null;
    if ((prevM?.hash ?? null) !== (nowM?.hash ?? null)) {
      diffs.push({ index: idx, prev: prevM, now: nowM });
    }
  }
  return diffs;
}

// First index at which two strings differ, or -1 if neither diverges
// before the shorter one ends.
function firstDifferingChar(a = "", b = "") {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

// Byte-level system diff: for each changed block, report where it changed
// and show a window from both sides. This is the evidence that was missing
// when `system=DIFFER` was all the tooling could say.
function diffSystemBlocks(prevBlocks = [], nowBlocks = []) {
  const prevByIdx = new Map(prevBlocks.map((b) => [b.index, b]));
  const nowByIdx = new Map(nowBlocks.map((b) => [b.index, b]));
  const allIdx = [...new Set([...prevByIdx.keys(), ...nowByIdx.keys()])].sort(
    (a, b) => a - b,
  );
  const diffs = [];
  for (const idx of allIdx) {
    const p = prevByIdx.get(idx) ?? null;
    const n = nowByIdx.get(idx) ?? null;
    if ((p?.hash ?? null) === (n?.hash ?? null)) continue;
    const at = firstDifferingChar(p?.text ?? "", n?.text ?? "");
    const from = at < 0 ? 0 : Math.max(0, at - DIVERGENCE_WINDOW / 2);
    diffs.push({
      index: idx,
      label: n?.label ?? p?.label ?? null,
      prevChars: p?.chars ?? null,
      nowChars: n?.chars ?? null,
      added: !p,
      removed: !n,
      charAt: at,
      prevWindow: (p?.text ?? "").slice(from, from + DIVERGENCE_WINDOW),
      nowWindow: (n?.text ?? "").slice(from, from + DIVERGENCE_WINDOW),
    });
  }
  return diffs;
}

// Name the tools that changed. Keyed by name so a reordering reports as
// index movement on stable names rather than as N unrelated changes.
function diffTools(prevDetail, nowDetail) {
  const prev = new Map((prevDetail?.tools ?? []).map((t) => [t.name, t]));
  const now = new Map((nowDetail?.tools ?? []).map((t) => [t.name, t]));
  const names = [...new Set([...prev.keys(), ...now.keys()])];
  const diffs = [];
  for (const name of names) {
    const p = prev.get(name) ?? null;
    const n = now.get(name) ?? null;
    if (!p) diffs.push({ name, change: "added", index: n.index });
    else if (!n) diffs.push({ name, change: "removed", index: p.index });
    else if (p.hash !== n.hash)
      diffs.push({
        name,
        change: "schema",
        index: n.index,
        prevBytes: p.bytes,
        nowBytes: n.bytes,
      });
    else if (p.index !== n.index)
      diffs.push({ name, change: "reordered", prevIndex: p.index, index: n.index });
  }
  return diffs;
}

function diffParams(prevParams = {}, nowParams = {}) {
  const keys = [...new Set([...Object.keys(prevParams), ...Object.keys(nowParams)])];
  const diffs = [];
  for (const k of keys) {
    const p = JSON.stringify(prevParams[k] ?? null);
    const n = JSON.stringify(nowParams[k] ?? null);
    if (p !== n) diffs.push({ key: k, prev: prevParams[k] ?? null, now: nowParams[k] ?? null });
  }
  return diffs;
}

// The exact first message index whose content changed — the answer the
// three fixed windows could only approximate. Appends and truncations are
// reported separately from in-place mutation, because only the latter
// invalidates a prefix the API had already cached.
function diffMessageHashes(prevHashes = [], nowHashes = []) {
  const n = Math.min(prevHashes.length, nowHashes.length);
  let firstDivergent = -1;
  for (let i = 0; i < n; i++) {
    if (prevHashes[i]?.h !== nowHashes[i]?.h) {
      firstDivergent = i;
      break;
    }
  }
  return {
    firstDivergentIndex: firstDivergent,
    commonLength: n,
    prevLength: prevHashes.length,
    nowLength: nowHashes.length,
    // True when the shared prefix is intact and the new array only grew —
    // the normal, cache-friendly shape of a conversation advancing.
    appendOnly: firstDivergent === -1 && nowHashes.length >= prevHashes.length,
    divergentRole: firstDivergent >= 0 ? nowHashes[firstDivergent]?.role ?? null : null,
  };
}

// Previews of the first divergent message, prev side and now side. Returns
// nulls when there is no divergence, when the index is out of range, or when
// either snapshot predates the `p` field (older files simply have no preview
// to give — degrade, never throw).
function divergentPreviews(prevHashes, nowHashes) {
  const chain = diffMessageHashes(prevHashes, nowHashes);
  const i = chain?.firstDivergentIndex ?? -1;
  if (i < 0) return { divergentPrev: null, divergentNow: null };
  return {
    divergentPrev: (Array.isArray(prevHashes) ? prevHashes[i]?.p : null) ?? null,
    divergentNow: (Array.isArray(nowHashes) ? nowHashes[i]?.p : null) ?? null,
  };
}

function computeDiff(prev, current) {
  const prevMsgs = Array.isArray(prev.prefixMessages) ? prev.prefixMessages : [];
  const nowMsgs = Array.isArray(current.prefixMessages) ? current.prefixMessages : [];
  const prevTail = Array.isArray(prev.tailMessages) ? prev.tailMessages : [];
  const nowTail = Array.isArray(current.tailMessages) ? current.tailMessages : [];
  const prevMarkers = Array.isArray(prev.markerMessages) ? prev.markerMessages : [];
  const nowMarkers = Array.isArray(current.markerMessages) ? current.markerMessages : [];

  return {
    timestamp: current.timestamp,
    prevTimestamp: prev.timestamp,
    toolsMatch: prev.toolsHash === current.toolsHash,
    systemMatch: prev.systemHash === current.systemHash,
    messageCountPrev: prev.messageCount,
    messageCountNow: current.messageCount,
    prefixDiffs: diffMessageWindow(prevMsgs, nowMsgs),
    tailDiffs: diffMessageWindow(prevTail, nowTail),
    markerDiffs: diffMarkerWindow(prevMarkers, nowMarkers),
    markerCount: nowMarkers.length,
    // Coverage added 2026-07-27. Older snapshots lack these fields; the
    // helpers default to empty so a diff across a version boundary
    // degrades to the old behaviour instead of throwing.
    systemBlockDiffs: diffSystemBlocks(prev.systemBlocks, current.systemBlocks),
    toolDiffs: diffTools(prev.toolsDetail, current.toolsDetail),
    paramDiffs: diffParams(prev.params, current.params),
    messageChain: diffMessageHashes(prev.messageHashes, current.messageHashes),
    // Previews of the first divergent message on both sides, so the ledger
    // records HOW it changed, not only that it did. Snapshots predating the
    // `p` field yield null here rather than throwing.
    ...divergentPreviews(prev.messageHashes, current.messageHashes),
    // prev.betaHeader is undefined on a pre-2026-07-27 snapshot; diffBetaHeader's
    // `?? {tokens: []}` default degrades that to "no header" rather than throwing.
    betaHeaderDiff: diffBetaHeader(prev.betaHeader, current.betaHeader),
  };
}

function diffHasChanges(diff) {
  return (
    diff.prefixDiffs.length > 0 ||
    diff.tailDiffs.length > 0 ||
    diff.markerDiffs.length > 0 ||
    !diff.toolsMatch ||
    !diff.systemMatch ||
    diff.messageCountPrev !== diff.messageCountNow ||
    (diff.paramDiffs?.length ?? 0) > 0 ||
    (diff.messageChain && diff.messageChain.firstDivergentIndex >= 0) ||
    (diff.betaHeaderDiff &&
      (diff.betaHeaderDiff.added.length > 0 || diff.betaHeaderDiff.removed.length > 0))
  );
}

// Rank the causes so the log line leads with the one that invalidates the
// most of the prefix. Order matters diagnostically: a param or system
// change re-writes everything after it, while a tail-only change is the
// normal cost of the conversation advancing.
function summariseCauses(diff) {
  const causes = [];
  if ((diff.paramDiffs?.length ?? 0) > 0)
    causes.push(`params:${diff.paramDiffs.map((d) => d.key).join(",")}`);
  if (!diff.systemMatch) {
    const labels = (diff.systemBlockDiffs ?? [])
      .map((d) => `${d.index}:${d.label ?? "?"}@${d.charAt}`)
      .join(",");
    causes.push(`system[${labels || "unlocated"}]`);
  }
  if (!diff.toolsMatch) {
    const names = (diff.toolDiffs ?? []).map((d) => `${d.name}:${d.change}`).join(",");
    causes.push(`tools[${names || "unlocated"}]`);
  }
  const chain = diff.messageChain;
  if (chain && chain.firstDivergentIndex >= 0)
    causes.push(`messages@${chain.firstDivergentIndex}(${chain.divergentRole ?? "?"})`);
  else if (chain && !chain.appendOnly && chain.nowLength < chain.prevLength)
    causes.push(`messages:truncated(${chain.prevLength}→${chain.nowLength})`);
  const betaDiff = diff.betaHeaderDiff;
  if (betaDiff && (betaDiff.added.length > 0 || betaDiff.removed.length > 0)) {
    const parts = [];
    if (betaDiff.added.length) parts.push(`+${betaDiff.added.join(",")}`);
    if (betaDiff.removed.length) parts.push(`-${betaDiff.removed.join(",")}`);
    causes.push(`header:anthropic-beta[${parts.join(" ")}]`);
  }
  return causes;
}

// Bounded record for the append-only ledger: enough to identify and
// classify a bust months later, without the full message bodies that
// make the detail file large.
function buildEventRecord(diff, sessionKey, sessionId) {
  return {
    ts: diff.timestamp,
    prevTs: diff.prevTimestamp,
    key: sessionKey,
    sid: sessionId ?? null,
    // Tap point (dev-loop.md): every index in this record — chain.first
    // above all — is a position in the FORWARDED body at this module's own
    // pipeline order, never a raw-capture or other-extension index. Naming
    // it here means a reader never has to know or re-derive the order to
    // avoid the equating-across-tap-points mistake.
    view: TAP_VIEW,
    causes: summariseCauses(diff),
    systemMatch: diff.systemMatch,
    toolsMatch: diff.toolsMatch,
    msgs: `${diff.messageCountPrev}->${diff.messageCountNow}`,
    chain: diff.messageChain
      ? {
          first: diff.messageChain.firstDivergentIndex,
          role: diff.messageChain.divergentRole,
          appendOnly: diff.messageChain.appendOnly,
          // The divergent message's own content, bounded. Without this the
          // ledger says WHICH index changed but never HOW: on 2026-07-27 a
          // ~93k bust reported `messages@83(user)` and the mutation could not
          // be identified afterwards from any stored artifact — head-5/tail-3
          // are the only windows carrying content, and 83 is in neither.
          // Investigating it required the live request, which no longer
          // existed. Captured at diff time, when the index is already known.
          prevContent: diff.divergentPrev ?? null,
          nowContent: diff.divergentNow ?? null,
        }
      : null,
    params: (diff.paramDiffs ?? []).map((d) => ({
      k: d.key,
      prev: typeof d.prev === "object" ? "<obj>" : d.prev,
      now: typeof d.now === "object" ? "<obj>" : d.now,
    })),
    system: (diff.systemBlockDiffs ?? []).map((d) => ({
      i: d.index,
      label: d.label,
      at: d.charAt,
      prevChars: d.prevChars,
      nowChars: d.nowChars,
      prevWin: d.prevWindow,
      nowWin: d.nowWindow,
    })),
    tools: (diff.toolDiffs ?? []).map((d) => ({ n: d.name, c: d.change })),
    betaHeader:
      diff.betaHeaderDiff &&
      (diff.betaHeaderDiff.added.length > 0 || diff.betaHeaderDiff.removed.length > 0)
        ? { added: diff.betaHeaderDiff.added, removed: diff.betaHeaderDiff.removed }
        : null,
    windows: {
      head: diff.prefixDiffs.length,
      markers: diff.markerDiffs.length,
      tail: diff.tailDiffs.length,
    },
  };
}

// Atomic write: stage to a unique-per-invocation .tmp, then rename to
// final path. The unique suffix is essential under concurrency — two
// parallel callers writing to the same finalPath would otherwise share
// a single .tmp and corrupt each other's content.
//
// On rename failure the prior final-path file (if any) remains intact.
// The orphan .tmp persists on disk — because each invocation uses a
// unique temp name, later calls do NOT implicitly overwrite it. This is
// a small leak (accepted: failures are rare, files are tiny) rather than
// a correctness issue. A follow-up could add best-effort cleanup.
async function atomicWriteJson(finalPath, obj, fs) {
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 10)}.tmp`;
  // Owner-only: the tmp file is freshly created every call, so the create
  // mode applies cleanly (no window where it's readable at the ambient
  // umask), and the rename carries that mode onto the final path — which
  // also repairs a loose mode on a pre-existing final file for free.
  await writeFileOwnerOnly(tmpPath, JSON.stringify(obj, null, 2), fs);
  await fs.rename(tmpPath, finalPath);
}

// Append one JSONL record, rotating past EVENTS_MAX_BYTES so the ledger
// is permanent but not unbounded. Rotation keeps exactly one generation:
// the point is surviving the next overwrite, not indefinite history.
async function appendEvent(eventsPath, record, fs) {
  try {
    const st = await fs.stat(eventsPath).catch(() => null);
    if (st && st.size > EVENTS_MAX_BYTES) {
      await fs.rename(eventsPath, `${eventsPath}.1`).catch(() => {});
    }
  } catch {
    // Rotation is best-effort; never block the append on it.
  }
  // Owner-only, with lazy repair: appendFileOwnerOnly chmods the path once
  // per process before appending, so a file created before this mode
  // existed (or a rotated .1 that somehow lost it) gets fixed on the next
  // write rather than staying at the ambient umask forever.
  await appendFileOwnerOnly(eventsPath, JSON.stringify(record) + "\n", fs);
}

// Matches this module's own artifact filenames — `<key>-last.json`,
// `<key>-diff.json`, `<key>-events.jsonl`, and its rotated `.1` — and
// nothing else. Deliberately narrow: the snapshot directory is this
// extension's alone today, but a narrow match means the sweep can never
// touch a file some future co-tenant of the directory writes.
const SNAPSHOT_FILE_RE = /^(.+)-(last\.json|diff\.json|events\.jsonl(?:\.1)?)$/;

// Group a directory listing by session key, ignoring anything that isn't
// one of this module's own artifact names.
function groupSnapshotFiles(names) {
  const byKey = new Map();
  for (const name of names) {
    const m = SNAPSHOT_FILE_RE.exec(name);
    if (!m) continue;
    const key = m[1];
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(name);
  }
  return byKey;
}

/**
 * Cross-key retention sweep: delete artifacts older than `maxAgeMs`, then
 * — if more than `maxKeys` session keys still remain — delete the oldest
 * keys' artifacts until the cap holds. A key's age is its most recently
 * touched surviving file, so a key with any recent activity survives the
 * cap pass even if it also has old rotated files.
 *
 * Best-effort throughout: a stat or unlink failure on one file is logged
 * (CACHE_FIX_DEBUG=1) and skipped, never thrown — a partial sweep is
 * strictly better than an exception that takes the boot-time caller down
 * with it.
 *
 * @param {string} dir  Snapshot directory.
 * @param {object} [fs] fs/promises subset: { readdir, stat, unlink, chmod }.
 *                      Defaults to DEFAULT_FS, same convention as every
 *                      other I/O entry point in this module.
 * @param {object} [opts]
 * @param {number} [opts.now]      Reference time in epoch ms (test seam).
 * @param {number} [opts.maxAgeMs] Defaults to SNAPSHOT_MAX_AGE_MS.
 * @param {number} [opts.maxKeys]  Defaults to SNAPSHOT_MAX_KEYS.
 * @returns {Promise<{ deleted: number, keysRemaining: number }>}
 */
async function sweepSnapshotDir(dir, fs = DEFAULT_FS, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? SNAPSHOT_MAX_AGE_MS;
  const maxKeys = opts.maxKeys ?? SNAPSHOT_MAX_KEYS;

  let names;
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    // ENOENT — no snapshot dir yet — is the normal case on a fresh
    // install and not worth logging even under CACHE_FIX_DEBUG.
    if (err && err.code !== "ENOENT") {
      debug(`sweep readdir failed for ${dir}: ${err?.message ?? err}`);
    }
    return { deleted: 0, keysRemaining: 0 };
  }

  const byKey = groupSnapshotFiles(names);
  const mtimes = new Map();
  for (const fileNames of byKey.values()) {
    for (const name of fileNames) {
      try {
        const st = await fs.stat(join(dir, name));
        mtimes.set(name, st.mtimeMs);
      } catch (err) {
        // Unreadable — e.g. removed between readdir and stat, or a
        // permissions error. Treat as ancient so the age pass below
        // takes it, rather than silently keeping a file we can't stat.
        mtimes.set(name, 0);
        debug(`sweep stat failed for ${name}: ${err?.message ?? err}`);
      }
    }
  }

  let deleted = 0;
  async function unlinkOne(name) {
    try {
      await fs.unlink(join(dir, name));
      deleted++;
    } catch (err) {
      debug(`sweep unlink failed for ${name}: ${err?.message ?? err}`);
    }
  }

  // Age pass: any artifact past its TTL goes regardless of key count, so a
  // single long-dead session cannot survive by riding under the key cap.
  // Every surviving file also gets a mode repair here — a rotated `.1`
  // file inherits whatever mode its pre-rotation path had (rename doesn't
  // change it), so a file rotated before the 0600 fix shipped could
  // otherwise sit at a loose mode indefinitely, since rotation is the one
  // path that never calls appendFileOwnerOnly on the .1 name itself. The
  // sweep already stats every survivor, so the repair is nearly free.
  for (const [key, fileNames] of byKey) {
    const surviving = [];
    for (const name of fileNames) {
      const age = now - (mtimes.get(name) ?? 0);
      if (age > maxAgeMs) {
        await unlinkOne(name);
      } else {
        await ensureOwnerOnly(join(dir, name), fs);
        surviving.push(name);
      }
    }
    if (surviving.length === 0) byKey.delete(key);
    else byKey.set(key, surviving);
  }

  // Key-cap pass: prune the oldest keys — by their newest surviving file's
  // mtime — beyond maxKeys.
  if (byKey.size > maxKeys) {
    const keyActivity = [...byKey.entries()]
      .map(([key, fileNames]) => ({
        key,
        fileNames,
        last: Math.max(...fileNames.map((n) => mtimes.get(n) ?? 0)),
      }))
      .sort((a, b) => a.last - b.last);
    const toEvict = keyActivity.slice(0, keyActivity.length - maxKeys);
    for (const { key, fileNames } of toEvict) {
      for (const name of fileNames) await unlinkOne(name);
      byKey.delete(key);
    }
  }

  return { deleted, keysRemaining: byKey.size };
}

// Runs the retention sweep once per process, on the first live request —
// there is no dedicated boot hook in the extension pipeline (loadExtensions
// only imports the module; see pipeline.mjs), so "on boot" here means "the
// first time this extension does anything in this process." Fire-and-await
// rather than fire-and-forget: the cost is one readdir + a stat per file,
// paid once per process, not once per request, and awaiting it keeps the
// error handling in one place (onRequest's own try/catch) instead of
// risking an unhandled rejection from a detached promise.
let bootSwept = false;

async function ensureBootSweep(dir, fs) {
  if (bootSwept) return;
  bootSwept = true;
  const result = await sweepSnapshotDir(dir, fs);
  if (result.deleted > 0) {
    debug(`boot sweep: removed ${result.deleted} artifact(s), ${result.keysRemaining} key(s) remain`);
  }
}

/**
 * Snapshot the prefix of `payload` and diff against the prior snapshot.
 *
 * Pure-ish: never throws, never mutates `payload`. All I/O is gated by
 * try/catch; failures are debug-logged when CACHE_FIX_DEBUG=1.
 *
 * @param {object} payload  The request body (system, tools, messages).
 * @param {object} options
 * @param {string} [options.dir] Snapshot directory. Defaults to ~/.claude/cache-fix-snapshots.
 * @param {object} [options.headers] Request headers, used to derive a
 *                               drift-proof storage key from the session id.
 * @param {object} [options.fs]  fs/promises overrides for tests:
 *                               { mkdir, readFile, writeFile, rename, appendFile, stat }.
 *                               Any subset replaces the corresponding default.
 * @returns {Promise<{ key, wroteSnapshot, wroteDiff } | null>} Result for tests; null if no system.
 */
// Serialize per-key so the tenants read-modify-write below cannot interleave.
//
// The read and the write are separated by awaits, so two concurrent requests
// on the SAME session key both read the old map and the second write clobbers
// the first — a classic lost update. Measured: 10 distinct tenants fired via
// Promise.all left 1 of 10 baselines on disk, which defeats per-tenant
// baselines exactly when co-tenants are genuinely concurrent (a main session
// with parallel subagents) rather than merely interleaved.
//
// One promise chain per key. The proxy is a single daemon process, so
// in-process serialization is sufficient; there is no second writer to this
// path. Entries are dropped when their chain drains, so the map cannot grow
// with session count.
const keyLocks = new Map();

function withKeyLock(key, fn) {
  const prev = keyLocks.get(key) ?? Promise.resolve();
  // Never let a rejection poison the chain for later callers.
  const run = prev.then(fn, fn);
  keyLocks.set(
    key,
    run.then(
      () => {
        if (keyLocks.get(key) === run) keyLocks.delete(key);
      },
      () => {
        if (keyLocks.get(key) === run) keyLocks.delete(key);
      },
    ),
  );
  return run;
}

async function snapshotPrefix(payload, options = {}) {
  const headers = options.headers || null;
  // `contentEnabled` in options lets tests exercise both modes without
  // mutating process.env; production leaves it unset and gets the real
  // CACHE_FIX_PREFIXDIFF_CONTENT reading.
  const contentEnabled = options.contentEnabled ?? CONTENT_ENABLED;
  const current = buildSnapshot(payload, headers, contentEnabled);
  if (!current) return null;
  const lockKey = resolveSessionKey(headers, payload.system);
  return withKeyLock(lockKey, () => snapshotPrefixLocked(payload, options, current, headers));
}

async function snapshotPrefixLocked(payload, options, current, headers) {

  const dir = options.dir || getSnapshotDir();
  const fs = { ...DEFAULT_FS, ...(options.fs || {}) };

  const sessionId = headers ? resolveSessionId(headers) : null;
  const sessionKey = resolveSessionKey(headers, payload.system);
  const lastPath = join(dir, `${sessionKey}-last.json`);
  const diffPath = join(dir, `${sessionKey}-diff.json`);
  const eventsPath = join(dir, `${sessionKey}-events.jsonl`);

  // Ensure directory exists. mkdir failure aborts — without dir, nothing
  // else can succeed.
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    debug(`mkdir failed for ${dir}: ${err?.message ?? err}`);
    return { key: sessionKey, wroteSnapshot: false, wroteDiff: false };
  }

  // Read prior snapshot if it exists. Missing file is normal; corrupt
  // file is treated as no prior (skip diff, proceed to overwrite).
  //
  // The file holds one baseline PER TENANT (see tenantId): co-tenants on a
  // shared session id must not diff against each other. Legacy files hold a
  // bare snapshot instead of a `tenants` map; those load as the baseline for
  // whichever tenant reads first, so the upgrade costs no lost diff.
  const tid = tenantId(headers, payload.system);
  let prev = null;
  let stored = null;
  try {
    const txt = await fs.readFile(lastPath, "utf-8");
    stored = JSON.parse(txt);
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      debug(`prior snapshot unreadable at ${lastPath}: ${err?.message ?? err}`);
    }
  }
  // A request whose tenant we have never seen is ambiguous: either a
  // co-tenant's first turn (diffing it against another conversation is
  // exactly the false-cause bug) or the same conversation whose system
  // prompt just changed (refusing to diff it would silently drop a real
  // bust — design note 1's blind spot). Both readings stay available:
  // diff against the last writer so nothing is lost, and mark the record
  // `crossTenant` so a reader can tell a genuine cause from this artifact.
  // Evidence is kept; only its interpretation is labelled.
  let crossTenant = false;
  if (stored && stored.tenants) {
    prev = stored.tenants[tid] || null;
    if (!prev && stored.lastTenant && stored.tenants[stored.lastTenant]) {
      prev = stored.tenants[stored.lastTenant];
      crossTenant = true;
    }
  } else if (stored) {
    prev = stored;
  }

  // Compute and write diff if anything changed.
  let wroteDiff = false;
  if (prev) {
    const diff = computeDiff(prev, current);
    if (diffHasChanges(diff)) {
      // Ledger first: the append is what must survive, and it must not be
      // lost to a failure in the (overwritable) detail file.
      try {
        const record = buildEventRecord(diff, sessionKey, sessionId);
        if (crossTenant) record.crossTenant = true;
        await appendEvent(eventsPath, record, fs);
      } catch (err) {
        debug(`event append failed at ${eventsPath}: ${err?.message ?? err}`);
      }
      try {
        await atomicWriteJson(diffPath, diff, fs);
        wroteDiff = true;
        // Always log the summary line when a diff fires (not just under
        // CACHE_FIX_DEBUG) — this is the diagnostic's whole purpose. The
        // per-window counts (head/markers/tail) tell the reader which
        // window caught the bust; `cause=` names the specific block,
        // tool, param, or message index so the line alone is often the
        // whole answer.
        const totalDiffs =
          diff.prefixDiffs.length + diff.markerDiffs.length + diff.tailDiffs.length;
        const causes = summariseCauses(diff);
        process.stderr.write(
          `[prefix-diff] ${sessionKey} (${TAP_VIEW}): ${totalDiffs} differences ` +
            `(head=${diff.prefixDiffs.length}, markers=${diff.markerDiffs.length}, ` +
            `tail=${diff.tailDiffs.length}), ` +
            `tools=${diff.toolsMatch ? "match" : "DIFFER"}, ` +
            `system=${diff.systemMatch ? "match" : "DIFFER"}, ` +
            `messages=${diff.messageCountPrev}→${diff.messageCountNow}, ` +
            `marker_count=${diff.markerCount}` +
            (causes.length ? `, cause=${causes.join(" | ")}` : "") +
            // Loud, because the unlabelled version of this line is what
            // caused a 93k bust to be misattributed on 2026-07-27.
            (crossTenant
              ? `, CROSS-TENANT=baseline belongs to another conversation on this ` +
                `session id (subagent/background call) — NOT evidence of a bust`
              : "") +
            `\n`,
        );
      } catch (err) {
        debug(`diff write failed at ${diffPath}: ${err?.message ?? err}`);
      }
    }
  }

  // Always write the new snapshot atomically so the next call has a
  // fresh baseline. On failure, prior snapshot is intact.
  //
  // Write back every tenant, replacing only this one: a co-tenant's
  // baseline must survive our turn, or the next request from it diffs
  // against nothing and the churn returns. `lastTenant` drives the
  // fallback on the read side above. Cap the map so a long-lived session
  // that spawns many subagents cannot grow the file without bound —
  // evicting the oldest costs at most one stale baseline.
  let wroteSnapshot = false;
  const tenants = { ...(stored?.tenants || {}), [tid]: current };
  const MAX_TENANTS = 16;
  // Evict by the timestamp each baseline carries, NOT by key order.
  //
  // The previous version sliced `Object.keys()` as if it were insertion
  // order. It is not: ECMA-262 enumerates integer-like keys FIRST, in
  // ascending numeric order, regardless of when they were added. Tenant ids
  // are 8-hex sha slices, so roughly one in 16 is all-digits — such a tenant
  // sorts to the front and gets evicted ahead of genuinely older entries,
  // however recently it was written.
  //
  // `timestamp` is set by buildSnapshot on every write, so oldest-first is
  // well-defined and independent of key shape. The current tenant is never
  // evicted: it was just written and is the one the next request needs.
  const ids = Object.keys(tenants);
  if (ids.length > MAX_TENANTS) {
    const byAge = ids
      .filter((k) => k !== tid)
      .sort((a, b) => String(tenants[a]?.timestamp ?? "").localeCompare(String(tenants[b]?.timestamp ?? "")));
    for (const old of byAge.slice(0, ids.length - MAX_TENANTS)) delete tenants[old];
  }
  try {
    await atomicWriteJson(lastPath, { tenants, lastTenant: tid }, fs);
    wroteSnapshot = true;
  } catch (err) {
    debug(`snapshot write failed at ${lastPath}: ${err?.message ?? err}`);
  }

  return { key: sessionKey, wroteSnapshot, wroteDiff };
}

// The named exports below are internal test seams, not part of the
// proxy extension contract. Pipeline loading consumes only `default`.
// They're exposed so tests can call the helpers directly with their own
// options (tmpdir, failing fs mocks) instead of mutating process env or
// monkey-patching node:fs/promises at module scope.
export {
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
  // Content minimization + retention (2026-08-05) test seams.
  sweepSnapshotDir,
  groupSnapshotFiles,
  SNAPSHOT_MAX_AGE_MS,
  SNAPSHOT_MAX_KEYS,
};

export default {
  name: "prefix-diff",
  description:
    "Snapshot everything the prompt cache keys on (system blocks, full tool " +
    "schemas, top-level params including output_config/speed/betas, the " +
    "anthropic-beta request header, per-message hash chain, head/marker/tail " +
    "windows) and diff against the previous request, naming the exact block, " +
    "tool, param, header, or message index that changed",
  // Always loaded; gated at runtime by CACHE_FIX_PREFIXDIFF=1 inside onRequest.
  // This matches the acceptance criteria (env var alone activates) — the
  // extension is cheap to load (one no-op check per request when disabled).
  enabled: true,
  order: TAP_ORDER,

  async onRequest(ctx) {
    if (!ENABLED) return;
    if (!ctx || !ctx.body) return;
    // snapshotPrefix never throws; double-belt try/catch is defense in depth.
    try {
      // Self-guarded (bootSwept): a no-op after the first call in this
      // process. Same try/catch as everything else here — the sweep is
      // best-effort and must never block a request.
      await ensureBootSweep(getSnapshotDir(), DEFAULT_FS);
      await snapshotPrefix(ctx.body, { headers: ctx.headers });
    } catch (err) {
      debug(`onRequest unexpected: ${err?.message ?? err}`);
    }
  },
};
