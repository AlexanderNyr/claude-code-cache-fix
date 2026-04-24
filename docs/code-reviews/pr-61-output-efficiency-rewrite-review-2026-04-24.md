# Review: output-efficiency-rewrite proxy extension

Date: 2026-04-24
Reviewed: PR #61 (`feature/proxy-output-efficiency`)
Label applied: reviewed-by-codex-agent

## What Is Correct
- The proxy port preserves the preload implementation's narrow rewrite scope: it searches for `# Output efficiency`, replaces only that section, and leaves the rest of the system block intact.
- Section boundary handling is correct for the documented prompt shapes. `replaceSection()` stops at the next top-level `# ...` heading when present, or rewrites through end-of-text when the section is last.
- Header normalization is correct. `normalizeReplacement()` trims input and prepends `# Output efficiency` when the caller supplies only body text.
- `cache_control` preservation is correct. The rewrite returns `{ ...block, text: nextText }`, so existing marker objects survive unchanged on rewritten system blocks.
- No-op behavior is correct in the implemented paths: `onRequest()` exits when no replacement is configured or `ctx.body.system` is absent, and `rewriteOutputEfficiency()` returns `null` when the target section is not found.
- Test coverage is solid for the feature itself. The new suite covers normalization, section replacement through next heading and end-of-text, cache marker preservation, no-match/no-replacement behavior, and `onRequest()` integration. The disabled-path invariant is already covered at the pipeline layer by `test/proxy-pipeline.test.mjs`, which verifies `enabled: false` extensions are not loaded.

## Blockers
None

## What Needs Attention
- The section boundary matcher remains intentionally narrow: it only stops on the next top-level `# ...` heading, not `## ...` or other markdown constructs. That matches the existing preload behavior and the documented prompt variants, so this is not a regression, but it remains coupled to current prompt formatting.

## Recommendations
- Ship this as-is.
- If Claude Code starts emitting subsection headings inside or after the output-efficiency block, add one regression test first and then widen the boundary matcher deliberately rather than changing it preemptively now.

## Bottom Line
Approve. The proxy extension is a faithful port of the preload rewrite, preserves cache markers, no-ops safely when inactive or unmatched, and has adequate targeted tests for the current prompt contract.
