// thinking-display extension
//
// Restores Opus 4.7 thinking summaries in non-interactive CC surfaces
// (VS Code chat panel, SDK, `claude --print`, anything spawned with
// `--input-format stream-json`).
//
// Background: Anthropic flipped the `thinking.display` default to `"omitted"`
// on Opus 4.7. CC's CLI propagates `display: "summarized"` only when the
// session is interactive (the `!getIsNonInteractiveSession()` gate); every
// non-interactive subprocess gets the API default of omitted thinking, which
// renders as an empty stub in the IDE. Upstream root cause and patch proposed
// in anthropics/claude-code#59844 (credit: @ojura).
//
// This extension is the proxy-side workaround. When a request has thinking
// enabled but `display` unset, inject the configured mode at the API
// boundary. Works on any CC version routed through cache-fix-proxy without
// waiting for Anthropic to ship the CLI fix.
//
// Config (env var; built-in default is "disabled"):
//   CACHE_FIX_THINKING_DISPLAY=summarized — inject display: "summarized"
//     (main case; restores summaries in IDE/SDK/--print)
//   CACHE_FIX_THINKING_DISPLAY=omitted    — inject display: "omitted"
//     (force-suppress override; for agent runtimes that don't want thinking
//     blocks at all, regardless of what their CLI sends)
//   CACHE_FIX_THINKING_DISPLAY=disabled   — no injection; extension is a no-op
//
// Default is "disabled" until the cache-prefix impact of injecting the field
// is verified empirically. See README and the PR landing this extension for
// the cache-prefix test result and the rationale for the eventual default.

const MODEL_REGEX = /^claude-opus-4-7/;

function resolveMode() {
  const v = process.env.CACHE_FIX_THINKING_DISPLAY;
  if (v === "summarized" || v === "omitted" || v === "disabled") return v;
  return "disabled";
}

// Thinking types that produce thinking blocks. CC v2.1.131+ ships
// `type: "adaptive"` (dynamic-budget mode) by default for the Bun binary's
// non-interactive paths; older versions and explicit-budget configs may
// still send `"enabled"`. Both produce the same empty-thinking symptom
// when `display` is unset on Opus 4.7, so both are in scope.
const ACTIVE_THINKING_TYPES = new Set(["enabled", "adaptive"]);

function shouldInject(body) {
  if (!body || typeof body !== "object") return false;
  if (typeof body.model !== "string") return false;
  if (!MODEL_REGEX.test(body.model)) return false;
  if (!body.thinking || typeof body.thinking !== "object") return false;
  if (!ACTIVE_THINKING_TYPES.has(body.thinking.type)) return false;
  // Only inject when display is unset. Preserve any explicit user choice
  // (including explicit "omitted" for compliance opt-out).
  return body.thinking.display === undefined;
}

export { MODEL_REGEX, ACTIVE_THINKING_TYPES, resolveMode, shouldInject };

export default {
  name: "thinking-display",
  description:
    "Inject thinking.display on Opus 4.7 requests when unset, to restore " +
    "thinking summaries lost to CC's non-interactive CLI gate (claude-code#59844)",
  enabled: false,
  order: 360,

  async onRequest(ctx) {
    const mode = resolveMode();
    if (mode === "disabled") return;
    if (!shouldInject(ctx.body)) return;

    ctx.body.thinking.display = mode;

    if (ctx.meta) {
      ctx.meta.thinkingDisplayInjected = mode;
    }
  },
};
