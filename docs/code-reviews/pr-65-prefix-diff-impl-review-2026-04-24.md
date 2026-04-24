# Review: prefix-diff proxy extension implementation

Date: 2026-04-24
Reviewed: `proxy/extensions/prefix-diff.mjs`, `test/proxy-prefix-diff.test.mjs`, `docs/directives/proxy-prefix-diff.md`
Label applied: `approved-by-codex-agent`

## What Is Correct

- The core port is faithful to the directive's intended behavior: the extension snapshots only diagnostic state, never mutates `ctx.body`, computes per-call diffs against the prior on-disk snapshot, and keeps failures fail-open inside `onRequest()` and `snapshotPrefix()` ([proxy/extensions/prefix-diff.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/prefix-diff.mjs:175), [proxy/extensions/prefix-diff.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/prefix-diff.mjs:261)).
- The pure helper/test-seam split is functionally correct. The runtime pipeline contract is the `default` export, while the named exports exist to support direct tests of the helper logic. The implementation does not leak those helpers into pipeline loading because the loader only consumes `mod.default` ([proxy/extensions/prefix-diff.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/prefix-diff.mjs:242), [proxy/pipeline.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/pipeline.mjs:20)).
- The atomic-write approach is sound for the problem it needs to solve. Writing to a unique temp path and then renaming prevents torn visibility of `*-last.json` / `*-diff.json` while also avoiding a shared-temp-path collision between concurrent calls. This does not serialize writers, but it does preserve the important invariant: readers either see the old complete file or the new complete file, never a partial JSON blob ([proxy/extensions/prefix-diff.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/prefix-diff.mjs:144)).
- The `enabled: true` deviation is reasonable under the current extension loader. `loadExtensions()` only registers modules whose default export resolves enabled, so `enabled: false` would prevent `CACHE_FIX_PREFIXDIFF=1` from ever taking effect unless `extensions.json` were also changed. Given the directive's acceptance criterion that the env var alone should activate the diagnostic, the code's behavior is the coherent one and the directive text is the part that needs reconciliation ([docs/directives/proxy-prefix-diff.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-prefix-diff.md:71), [proxy/extensions/prefix-diff.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/prefix-diff.mjs:255), [proxy/pipeline.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/pipeline.mjs:24)).
- Test coverage is good on the main acceptance path. The new suite exercises snapshot construction, diffing, corruption tolerance, rename failure, concurrent writes, hot-reload behavior, and no-mutation behavior; the full repository test run is also green.

## Findings

### Blockers

None.

### Nits

- The directive and implementation still disagree on activation semantics. The code's `enabled: true` choice is correct for the current loader, but the directive still says `enabled: false`, so the written spec no longer matches the shipped behavior ([docs/directives/proxy-prefix-diff.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-prefix-diff.md:71), [proxy/extensions/prefix-diff.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/prefix-diff.mjs:258)).
- The debug-log acceptance case is not deterministically asserted. The directive asked for a test that proves swallowed mkdir/write failures log when `CACHE_FIX_DEBUG=1`, but the current test only checks stderr conditionally if that env var happened to be set before module import, so this requirement is effectively unverified in normal CI runs ([docs/directives/proxy-prefix-diff.md](/home/manager/git_repos/claude-code-cache-fix/docs/directives/proxy-prefix-diff.md:100), [test/proxy-prefix-diff.test.mjs](/home/manager/git_repos/claude-code-cache-fix/test/proxy-prefix-diff.test.mjs:380)).
- The temp-file comment slightly overstates cleanup behavior. With unique temp names, a failed rename leaves an orphan `.tmp` that will not be "cleaned up implicitly by overwriting" on a later call; later calls create different temp names. The implementation is still acceptable, but the comment should describe the leak accurately ([proxy/extensions/prefix-diff.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/prefix-diff.mjs:149)).

### Nice-to-haves

- Add a short comment above the named exports clarifying that they are internal test seams and not part of the proxy extension contract. The current distinction is inferable from the loader and from the JSDoc, but not stated plainly at the export site ([proxy/extensions/prefix-diff.mjs](/home/manager/git_repos/claude-code-cache-fix/proxy/extensions/prefix-diff.mjs:242)).
- Strengthen the concurrency test so it asserts the final `*-last.json` matches one of the two candidate snapshots instead of only asserting that the JSON parses. The current test proves no torn write, but not that the final winner is one of the expected payloads ([test/proxy-prefix-diff.test.mjs](/home/manager/git_repos/claude-code-cache-fix/test/proxy-prefix-diff.test.mjs:318)).

## Recommendations

- Update the directive text to match the implementation's `enabled: true` runtime-gated activation model, unless the project wants to change pipeline semantics globally.
- Make the debug-path test deterministic by re-importing the module with `CACHE_FIX_DEBUG=1` set, the same way the hot-reload test already re-imports to validate state-free behavior.
- Tighten the temp-file comment and, if desired later, add best-effort orphan cleanup as a follow-up rather than in this PR.

## Bottom Line

Approve for merge. The implementation is correct, non-mutating, fail-open, and well-covered on the important behavioral paths. The only material mismatch I found is between the written directive and the loader realities around `enabled`; that is a spec/documentation consistency issue, not an implementation blocker.

