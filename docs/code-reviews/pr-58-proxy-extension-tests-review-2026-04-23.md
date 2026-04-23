# Review: proxy extension test suite

Date: 2026-04-23
Reviewed: PR #58 on commit 2f99293
Label applied: changes-requested

## What Is Correct
- The named-export additions are structurally safe in the six touched extension modules. Each file keeps its `export default` object, and the new tests import the default export alongside named helpers successfully.
- The new suites for `cache-control-normalize`, `cache-telemetry`, `sort-stabilization`, and `ttl-management` mostly assert externally visible behavior rather than internal implementation details.
- Focused local verification passed: `node --test test/proxy-cache-control-normalize.test.mjs test/proxy-cache-telemetry.test.mjs test/proxy-fingerprint-strip.test.mjs test/proxy-identity-normalization.test.mjs test/proxy-sort-stabilization.test.mjs test/proxy-ttl-management.test.mjs`.

## Blockers
- `proxy/extensions/fresh-session-sort.mjs` adds 12 named exports in this PR, but there is no corresponding `test/proxy-fresh-session-sort.test.mjs` and no existing test coverage for its helper paths or `onRequest` relocation flow. One of the six touched extension files is therefore completely untested in the change set. Reviewed file: `proxy/extensions/fresh-session-sort.mjs:89`.
- `test/proxy-identity-normalization.test.mjs` does not cover the extension's main mutating paths. The added tests only exercise no-op cases plus trailer/reminder predicates, but they never verify `stripSessionKnowledge()`, `pinBlockContent()`, or a positive `normalizeSessionStartText()` rewrite, and the integration tests never assert the actual `onRequest()` normalization behavior implemented in `proxy/extensions/identity-normalization.mjs:89-129`. The exported helpers are present, but the key code paths are still effectively unreviewed.
- `test/proxy-fingerprint-strip.test.mjs:11-20` mirrors the production fingerprint algorithm by duplicating the salt, indices, hash function, and truncation logic. That violates the stated "no mirror-logic tests" requirement and weakens the suite's value as a regression check. The same file's `stabilizeFingerprint` test at `:96-120` is also too weak: it conditionally accepts either branch and never asserts the concrete rewrite that `stabilizeFingerprint()` is supposed to produce.

## What Needs Attention
- `test/proxy-ttl-management.test.mjs` misses the message-content injection path and the `subagent` branch, so it does not yet cover all observable `onRequest()` outcomes.
- `test/proxy-sort-stabilization.test.mjs` covers skills sorting but not the `onRequest()` path for deferred-tool system blocks.

## Recommendations
- Add a dedicated `fresh-session-sort` test file that covers block classification helpers, `/clear` artifact stripping, in-place fixing when no scattered blocks exist, and backward relocation/prepend ordering when scattered blocks do exist.
- Rewrite the fingerprint tests around externally observable fixtures. For example, use a fixed known `cc_version` input/output pair or assert that `onRequest()` rewrites the billing header to a specific expected string for a representative payload, without reimplementing `computeFingerprint()` in the test.
- Expand the identity-normalization suite so at least one integration test proves removal of `<session_knowledge>`, one proves stable reminder pinning, and one proves `SessionStart` normalization removes `<session-id>` and `Last active:` text while preserving the rest of the block.

## Bottom Line
This PR is not ready for approval. The named exports themselves are fine, but the test coverage is incomplete for one touched extension, too shallow for another, and one fingerprint test reproduces production logic instead of validating behavior. I would request changes and re-review after those gaps are closed.
