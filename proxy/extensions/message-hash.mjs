// message-hash — content identity for a message, shared by every extension
// that needs to recognise "the same message" across requests.
//
// Hash everything EXCEPT cache_control, because cache_control is what the
// proxy itself mutates: including it would make a message look changed the
// instant we mark it, which is the opposite of an identity.
//
// Not an extension — a primitive. It lived in mid-history-breakpoint-ladder
// until that extension was removed (it manufactured the mid-history
// divergences it was meant to bound); insertion-normalization and
// deferred-tool-rewrite both depend on this function and never depended on
// rung placement, so it moved here rather than dying with its old host.

import { createHash } from "node:crypto";

export function hashMessageContent(msg) {
  if (!msg || !Array.isArray(msg.content)) return null;
  const stripped = msg.content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const { cache_control, ...rest } = block;
    return rest;
  });
  return createHash("sha256").update(JSON.stringify(stripped)).digest("hex").slice(0, 16);
}

// Conversation identity: the hash of msgs[0], the one entry nothing appends
// past. Lives here, not in one extension, because BOTH stateful extensions
// need it and the second one learning it late is what this file exists to
// prevent.
//
// History (2026-07-28, one day, twice). insertion-normalization keyed its
// canonical on (session-id, system-prompt) and thrashed: every subagent of a
// session runs the same agent prompt, so one bucket held 39 distinct
// conversations and 100% of conversation switches within a bucket reset
// (60/60) against 1% of same-conversation continuations. Adding this sub-key
// took it to 0 resets across 940 requests.
//
// deferred-tool-rewrite had the IDENTICAL key and did not get the fix, and it
// cost real cache: its tool_addition announcement is anchored to a message
// identity, so under a shared key the anchor belongs to somebody else's
// history, fails to match, and re-anchors to "after the last user message" —
// a different index every request. Measured: output diverging at index 4
// while CC's own history was identical through index 23, twice in one corpus.
//
// The general rule this keeps re-teaching: an identity computed more cheaply
// than the thing it identifies will collide, and the collision presents as
// churn rather than as a bug.
export function conversationSubKey(messages) {
  const first = Array.isArray(messages) ? messages[0] : null;
  if (!first) return "empty";
  const h = hashMessageContent(first);
  if (h) return h;
  // hashMessageContent covers block-array content only and returns null for
  // STRING content — correct for its own callers, but as a bucket key that
  // null collapsed every string-content conversation into one shared "empty"
  // bucket (56 of 602 requests in the measured capture). A message carrying
  // no content at all is the only remaining "empty".
  if (first.content === undefined || first.content === null) return "empty";
  return createHash("sha256")
    .update(JSON.stringify({ role: first.role ?? null, content: first.content }))
    .digest("hex")
    .slice(0, 16);
}
