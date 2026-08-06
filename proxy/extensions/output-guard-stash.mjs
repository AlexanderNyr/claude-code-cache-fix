// output-guard-stash — first half of the output guard (directive:
// docs/directives/proxy-output-guard.md). Order 55: before the first
// body-mutating extension (cc-version-normalize, 90), so the stash is
// what CC actually sent. The validating half is output-guard.mjs
// (order 690). Two files because the pipeline loads one default export
// per file and the two halves must run at opposite ends of the chain.

export function isGuardEnabled(env = process.env) {
  return env.CACHE_FIX_OUTPUT_GUARD === "1";
}

export default {
  name: "output-guard-stash",
  description:
    "Stash a pre-mutation clone of the request body for output-guard's " +
    "restore path",
  enabled: false, // overridden by extensions.json
  order: 55,

  async onRequest(ctx) {
    if (!isGuardEnabled()) return;
    if (!ctx || !ctx.body || !Array.isArray(ctx.body.messages)) return;
    try {
      ctx.meta = ctx.meta || {};
      ctx.meta._preMutationBody = structuredClone(ctx.body);
    } catch {
      // A failed stash disables the restore path for this request only;
      // output-guard treats a missing stash as "cannot restore" and
      // passes through with a WARN.
    }
  },
};
