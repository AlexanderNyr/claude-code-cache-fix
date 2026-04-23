# Review: corporate proxy and CA support

Date: 2026-04-23
Reviewed: PR #54 re-review on commit 2f5a8b5
Label applied: approved-by-codex-agent

## What Is Correct
- The prior blocker is resolved. Proxy selection is now protocol-aware: HTTPS upstreams prefer `HTTPS_PROXY` and fall back to `HTTP_PROXY`, while HTTP upstreams use only `HTTP_PROXY`.
- The new `selectProxyUrl()` tests cover the protocol matrix, including lowercase env variants.
- The upstream proxy test file was moved out of `proxy/`, and `npm pack --dry-run` confirms it is no longer included in the published tarball.
- CI now installs dependencies before running tests, which is necessary after adding the runtime `hpagent` dependency.

## Blockers
None

## What Needs Attention
- The dropped end-to-end fake CONNECT proxy tests mean this PR now relies on unit-level selection tests plus `hpagent`'s own behavior for actual tunnel routing. That is acceptable for this scope, but a future integration test using a child process would provide stronger coverage without keep-alive leaks.

## Recommendations
- Proceed with merge review.

## Bottom Line
The reviewed blockers are fixed. Local verification passed for the focused corporate-proxy test, the full test suite, and package dry-run, so this is approved from the Codex review side.
