# Review: proxy extension tests

Date: 2026-04-23
Reviewed: PR #58 (`feature/proxy-extension-tests`, head `020fc46`)
Label applied: changes-requested

## What Is Correct
- `test/proxy-fresh-session-sort.test.mjs` now exists and covers the previously missing `fresh-session-sort` surface, including relocation to the first user message, deterministic relocation order, and stripping `cache_control` on relocated blocks.
- `test/proxy-identity-normalization.test.mjs` now exercises real mutating paths in `identity-normalization.mjs`, including `session_knowledge` removal and `SessionStart` normalization in message content.
- `test/proxy-fingerprint-strip.test.mjs` no longer mirrors the production hash implementation with duplicated salt/index logic; the fixture-based `computeFingerprint` checks are an improvement.

## Blockers
- `test/proxy-fingerprint-strip.test.mjs:126` still does not assert the concrete correction path it claims to cover. The test named `stabilizeFingerprint: produces correction with known fixture values` computes `result` and then performs no assertion at all. Its inline comment also explains a no-op case, so it does not verify `stableFingerprint`, `newText`, or `onRequest` rewriting the billing header. That leaves the original blocker unresolved: the suite still lacks a behavior assertion for the actual fingerprint rewrite path.

## What Needs Attention
- None beyond the blocking gap above.

## Recommendations
- Replace the current no-op `stabilizeFingerprint` case with one that provably passes legacy verification and produces a different stable fingerprint, then assert the returned `oldFingerprint`, `stableFingerprint`, and rewritten `cc_version`.
- Add an `onRequest` integration test that starts with a drifted billing header and asserts the system block text is rewritten to the expected stable fingerprint.

## Bottom Line
This rereview clears two of the three prior blockers. The new `fresh-session-sort` coverage is substantive, and the identity-normalization suite now hits real mutating paths. The PR should remain blocked until the fingerprint suite asserts the actual rewrite behavior instead of only fixture outputs and no-op cases.
