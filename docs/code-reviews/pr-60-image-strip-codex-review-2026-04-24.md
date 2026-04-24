# Review: image-strip proxy extension

Date: 2026-04-24
Reviewed: PR #60 (`feature/proxy-image-strip`)
Label applied: reviewed-by-codex-agent

## What Is Correct
- The stripping helper preserves direct user image blocks and only rewrites `image` items nested inside `tool_result.content`, which matches the stated requirement and the existing `preload.mjs` behavior.
- The cutoff calculation is correct for "keep the last N user messages": it collects user-message indices, selects the earliest index that should remain intact, and strips only earlier user messages.
- Stats accounting matches the preload implementation: `strippedCount` increments per stripped image, `strippedBytes` sums `source.data.length` when present, and `estimatedTokens` is derived as `Math.ceil(strippedBytes * 0.125)`.
- The new extension is disabled by default via `enabled: false`, and the proxy pipeline honors extension defaults unless config enables them.
- Named exports are provided for the stripping helper and placeholder string, which makes the unit tests straightforward and keeps the core logic directly testable.

## Blockers
None

## What Needs Attention
- Test coverage is solid for the main success path and key regressions, but it does not currently exercise mixed old/recent histories where some old user messages have no `content` array or where `tool_result.content` is non-array. The implementation already guards these cases, so this is a coverage gap, not a correctness issue.
- The tests validate `strippedCount` and `strippedBytes` directly, but they only verify the token estimate indirectly. A direct assertion on `estimatedTokens` would make future refactors safer.

## Recommendations
- Approve and merge as-is.
- When convenient, add one small unit test that asserts `estimatedTokens` exactly and one guard-path test for malformed `tool_result.content`.

## Bottom Line
This is a clean proxy port of the preload image-stripping behavior. The logic is correctly scoped to old `tool_result` images, the cutoff math is sound, the metrics match the existing implementation, the extension is testable via named exports, and it remains opt-in by default. I found no blocking issues.
