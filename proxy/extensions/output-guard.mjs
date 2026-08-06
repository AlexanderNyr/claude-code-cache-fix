// output-guard — last-line invariant check on the outgoing body.
// Directive: docs/directives/proxy-output-guard.md.
//
// Protects against US, not CC: the pipeline mutates bodies (reorder,
// rewrite, inject, and since phase 3 substitute first-seen bytes), and
// the composition of individually-correct extensions is where the one
// real shipped defect lived. On any hard-invariant violation the guard
// forwards CC's ORIGINAL bytes (stashed by output-guard-stash at order
// 55) — valid by definition, they are what the API would have received
// with the proxy absent.
//
// Order 690: after the last body mutator (ttl-management, 500), before
// the pure observers (request-log 700, jsonl-session-mirror 720) so
// what they record is what actually goes out.
//
// Fail-open at the mutation level, fail-safe at the request level: a
// validator crash counts as "cannot verify" and passes the mutated body
// through with a WARN — the guard must never be able to break a request
// or silently disable the pipeline's value.

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { claudeHome } from "../claude-home.mjs";
import { resolveSessionId } from "./cache-telemetry.mjs";
import { validateToolAdjacency } from "./insertion-normalization.mjs";
import { isGuardEnabled } from "./output-guard-stash.mjs";

const MAX_MARKERS = 4;

function isDebug(env = process.env) {
  return env.CACHE_FIX_DEBUG === "1";
}

function getSnapshotDir() {
  return join(claudeHome(), "cache-fix-snapshots");
}

// --- Invariant validators (pure; each returns null or a violation string) ---

function checkToolAdjacency(body) {
  return validateToolAdjacency(body.messages)
    ? null
    : "tool-adjacency: a tool_result user message is not preceded by its matching tool_use assistant message";
}

function countMarkers(body) {
  let n = 0;
  const scan = (blocks) => {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      if (b && typeof b === "object" && b.cache_control) n++;
    }
  };
  scan(body.system);
  for (const m of body.messages) scan(m?.content);
  return n;
}

function checkMarkerBudget(body) {
  const n = countMarkers(body);
  return n <= MAX_MARKERS ? null : `marker-budget: ${n} cache_control markers exceed the API cap of ${MAX_MARKERS}`;
}

// "system" is legal mid-conversation (mid-conversation system messages,
// and deferred-tool-rewrite's injected tool_addition messages) — but never
// as messages[0], per the documented placement constraint.
function checkRoles(body) {
  for (let i = 0; i < body.messages.length; i++) {
    const r = body.messages[i]?.role;
    if (r !== "user" && r !== "assistant" && r !== "system") {
      return `roles: messages[${i}] has invalid role ${JSON.stringify(r)}`;
    }
    if (r === "system" && i === 0) {
      return `roles: messages[0] must not be system (placement constraint)`;
    }
  }
  return null;
}

function checkContentPresent(body) {
  for (let i = 0; i < body.messages.length; i++) {
    const c = body.messages[i]?.content;
    const ok = typeof c === "string" || (Array.isArray(c) && c.length > 0);
    if (!ok) return `content: messages[${i}] has missing or empty content`;
  }
  return null;
}

// Invariant 5 (BACKLOG.md, "suppression can strip a request's FINAL
// message", 2026-07-30): a message-REMOVING mutation shipped (duplicate
// suppression) without a tail-validity check, and three live requests
// ended assistant-role -> upstream "400 must end with a user message".
// The other four invariants are shape-level facts about ONE body; this
// one needs the body CC actually sent, so it takes it as a second
// argument rather than deriving anything from `body` alone.
//
// Conditioned on the INCOMING shape rather than an unconditional "never
// end assistant": if CC itself sent a request already ending in
// assistant role (a prefill-style continuation, however rare in observed
// traffic), that is the client's own intent and not this guard's business
// to overturn — the guard protects against OUR mutations, not against CC.
// `incomingBody` absent (e.g. the pre-mutation stash unavailable, or a
// direct unit-test call) means "cannot verify" for this one check, so it
// yields no violation rather than guessing.
function checkAssistantTerminal(body, incomingBody) {
  if (!incomingBody || !Array.isArray(incomingBody.messages) || incomingBody.messages.length === 0) return null;
  const incomingLast = incomingBody.messages[incomingBody.messages.length - 1];
  if (incomingLast?.role === "assistant") return null;
  const forwardedLast = body.messages[body.messages.length - 1];
  if (forwardedLast?.role === "assistant") {
    return "assistant-terminal: incoming request ended non-assistant but the forwarded body ends assistant — a mutation stripped the trailing message";
  }
  return null;
}

const VALIDATORS = [checkToolAdjacency, checkMarkerBudget, checkRoles, checkContentPresent, checkAssistantTerminal];

// Exported for tests: run all validators, return the first violation or
// null. `incomingBody` is optional — only checkAssistantTerminal reads it;
// every other validator is unaffected by its absence.
export function findViolation(body, incomingBody) {
  for (const v of VALIDATORS) {
    const violation = v(body, incomingBody);
    if (violation) return violation;
  }
  return null;
}

async function appendGuardEvent(dir, key, record) {
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${key}-guard-events.jsonl`), JSON.stringify(record) + "\n");
  } catch {
    // Telemetry loss must not affect the request.
  }
}

export default {
  name: "output-guard",
  description:
    "Validate hard invariants (tool adjacency, marker budget, roles, " +
    "content presence) on the outgoing body; on violation forward the " +
    "pre-mutation original instead",
  enabled: false, // overridden by extensions.json
  order: 690,

  async onRequest(ctx) {
    if (!isGuardEnabled()) return;
    if (!ctx || !ctx.body || !Array.isArray(ctx.body.messages)) return;

    ctx.meta = ctx.meta || {};
    let violation;
    try {
      violation = findViolation(ctx.body, ctx.meta._preMutationBody);
    } catch (err) {
      // Cannot verify -> pass the mutated body through (fail-open); a
      // guard crash must never break the request or the pipeline's value.
      ctx.meta.outputGuardStats = { verified: false, error: String(err?.message ?? err) };
      process.stderr.write(
        `[output-guard] WARN: validator crashed (${err?.message ?? err}) — body passed through UNVERIFIED\n`,
      );
      return;
    }

    if (!violation) {
      ctx.meta.outputGuardStats = { verified: true, fired: false };
      return;
    }

    const stash = ctx.meta._preMutationBody;
    const sid = ctx.headers ? resolveSessionId(ctx.headers) : null;
    const key = sid ? `s-${sid.replace(/[^A-Za-z0-9_-]/g, "_")}` : "nokey";

    if (stash) {
      ctx.body = stash;
      ctx.meta.outputGuardStats = { verified: true, fired: true, violation, restored: true };
      process.stderr.write(
        `[output-guard] CRITICAL: ${violation} — pipeline output DISCARDED, original client body forwarded. An extension (or interaction) produced an invalid body; see ${key}-guard-events.jsonl\n`,
      );
    } else {
      // No stash (stash failed or guard enabled mid-request): nothing safe
      // to restore to; forward the mutated body and say so loudly.
      ctx.meta.outputGuardStats = { verified: true, fired: true, violation, restored: false };
      process.stderr.write(
        `[output-guard] CRITICAL: ${violation} — NO pre-mutation stash available, mutated body forwarded as-is\n`,
      );
    }

    await appendGuardEvent(getSnapshotDir(), key, {
      ts: new Date().toISOString(),
      sid,
      violation,
      restored: Boolean(stash),
      messageCount: Array.isArray(ctx.body?.messages) ? ctx.body.messages.length : 0,
    });

    if (isDebug()) {
      process.stderr.write(`[output-guard] DEBUG: stats=${JSON.stringify(ctx.meta.outputGuardStats)}\n`);
    }
  },
};
