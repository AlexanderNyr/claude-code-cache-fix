# Directive: Port `deferred-tools-restore` to proxy extension + close out #59

**Issues:** #59 item 6 (deferred-tools-restore), #59 item 10 (git-status strip — closed via README, not ported)
**Branch:** `feature/proxy-deferred-tools-restore`
**Stage:** directive (revised after Codex review — see `docs/code-reviews/`)

This is the **final PR for #59**. It ports the last behavior-bearing item, documents why item 10 is intentionally not ported, and closes #59.

## Goal

Port the `deferred_tools_restore` fix from `preload.mjs` to a proxy extension. This **modifies outgoing requests** by substituting a stale, shrunken deferred-tools attachment block with a previously-snapshotted full-form copy when MCP servers haven't reconnected yet at resume time.

## Why

Observed empirically: on `claude --continue`, if MCP servers haven't finished reconnecting before CC fires the first post-resume request, the `<system-reminder>The following deferred tools are now available via ToolSearch…` block at `msg[0]` (or wherever the attachment lands post-compaction) shrinks dramatically. A full list of ~40 tools collapses to a handful of CC built-ins, and CC injects a trailing `The following deferred tools are no longer available (their MCP server disconnected). Do not search for them — ToolSearch will return no match:` notice.

That block change at the root of the message array busts the cache at the very top — the entire ~940K prompt re-caches. By the time the second post-resume request fires, MCPs are usually reconnected and the block is full again, but the cache is already committed to the shrunk version for this session.

## Adaptation from preload behavior (snapshot key change)

The preload version uses `process.cwd()` as the snapshot key. **This does not translate to the proxy:**

- In preload, `process.cwd()` is the Claude Code process's CWD — different per CC session per project.
- In the proxy, `process.cwd()` is the long-lived proxy daemon's CWD — **shared across all CC sessions on the host**. Two unrelated projects would collide onto the same snapshot file.

A previous revision proposed `sha1(JSON.stringify(payload.system).slice(0, 2000))` as the key. **This is also unsafe** for two competing reasons:

- The first ~500 chars of CC's system prompt are stable across sessions but **identical across all projects** (it's the role boilerplate). Hashing only the leading region produces project-blind keys.
- Going deeper into the slice catches project-distinguishing content (cwd line, CLAUDE.md, skills) but also catches volatile content (git status text, hook output) that drifts between sessions for the same project.

Either failure mode breaks restore reliability or causes cross-project contamination.

### The proxy version parses the cwd directly from the system prompt

CC injects the working directory into the system prompt content as a deterministic marker (e.g., a line like `Working directory: /path/to/project` or an `<env>` block — exact format to be confirmed empirically during implementation against current CC versions). The proxy:

1. Walks `payload.system` text content looking for the cwd marker.
2. If found → key = `sha1("cwd:" + extractedPath).slice(0, 16)`. Stable across CC restarts for same project. Unique per project.
3. If not found → **no-op for this request** (no persist, no restore). Better to do nothing than to fall back to an unsafe heuristic.

This honest no-op is a correctness property: when the proxy can't reliably identify the project, the deferred-tools-restore behavior degrades to the status quo (cache may bust on the next resume), which is identical to the user not having the extension at all. The system never silently corrupts state by restoring the wrong block.

### Why this passes the previous Codex blocker

- `cwd:` derivation is invariant under file edits, hook firings, and git-status changes — none of those rewrite the cwd line.
- Cross-project collision requires two projects with the same cwd string, which is impossible by definition.
- If CC changes its system-prompt format and the marker disappears, the no-op fallback prevents incorrect restores. The implementation should log a debug warning when the marker is missing for >N consecutive requests so we notice format drift.

### Marker-format research (to do during implementation)

Before locking the parser, the implementation must:
- Capture a real CC v2.1.117+ system prompt via `proxy/extensions/request-log.mjs` (or a dedicated short-lived debug extension)
- Identify the actual cwd marker format (line prefix, surrounding tags, position in the content)
- Build a regex that matches the current format and document a fallback if CC introduces multiple variants
- Add a test fixture using the real captured prompt shape (sanitized of any user paths)

If the empirical inspection shows the cwd is NOT reliably present in the system prompt, escalate before shipping — at that point the choice is option (B): drop the extension and document why deferred-tools-restore is preload-only.

## Reference (preload behavior to mirror)

- `preload.mjs` lines ~429–518 (helpers + constants — `findDeferredToolsBlockInBody`, marker constants, `deferredToolsSnapshotPath`)
- `preload.mjs` lines ~2286–2322 (integration block — persist-or-restore decision)
- Env var: `CACHE_FIX_SKIP_DEFERRED_TOOLS_RESTORE=1` to opt out (extension defaults **ON**)
- Snapshot dir: `~/.claude/cache-fix-state/`
- Snapshot file: `deferred-tools-<key>.txt` where `<key>` is `sha1("cwd:" + extractedCwd).slice(0, 16)`
- Markers (unchanged from preload):
  - AVAILABLE: `"The following deferred tools are now available via ToolSearch"`
  - UNAVAILABLE: `"The following deferred tools are no longer available"`

### Algorithm

1. Parse cwd from `payload.system`. If `payload.system` is absent, empty, or no cwd marker is found → **no-op for this request** (skip both persist and restore).
2. Compute snapshot key: `sha1("cwd:" + extractedCwd).slice(0, 16)`.
3. Walk `body.messages` to locate the deferred-tools block — only `role: "user"` messages, only `type: "text"` blocks containing the AVAILABLE marker. Return `{ msgIdx, blockIdx, text }` or `null`. (Skip assistant messages so the agent quoting the marker doesn't trigger a false match.)
4. If no block found → no-op.
5. If block exists and does **not** contain the UNAVAILABLE marker → it's a clean baseline. Persist it (best-effort, atomic write — see below).
6. If block exists and **does** contain the UNAVAILABLE marker → attempt restore:
   - Read snapshot file. If unreadable, malformed, or shorter than a sane minimum (e.g., < length of `AVAILABLE` marker) → skip restore (treat as no snapshot).
   - **Only substitute if the snapshot is strictly longer than the current block.** Never downgrade.
   - Substitute by replacing `messages[msgIdx].content[blockIdx].text` with the snapshotted bytes.

### Atomic write requirement (revised)

A truncated-but-readable snapshot can still pass the length check and corrupt the next session. Persistence MUST use atomic write:

```
write to <path>.tmp
fsync (best-effort; ignore if not supported)
rename <path>.tmp -> <path>
```

`rename` on the same filesystem is atomic; partial writes are confined to the `.tmp` file and never observed by readers. On rename failure, leave the previous snapshot intact (do not delete it).

Snapshot integrity validation on read is also tightened:

- File must exist and be readable
- File length must be at least `AVAILABLE_MARKER.length` bytes
- File content must contain the AVAILABLE marker (sanity check that we're reading what we think we're reading)
- If any check fails → treat as "no snapshot," skip restore

### Trade-off (document in extension header comment, mirroring preload)

The restored block may reference MCP tools that haven't actually reconnected yet. If the agent calls ToolSearch on one of them → no match → one retry. Tiny cost versus a full-prompt cache miss on every resume.

## Extension contract

- File: `proxy/extensions/deferred-tools-restore.mjs`
- `name`: `"deferred-tools-restore"`
- `description`: `"Persist and restore the deferred-tools attachment block across sessions to prevent MCP-reconnect-race cache busts at resume time"`
- `enabled`: `true` (defaults ON, mirroring preload — opt out via `CACHE_FIX_SKIP_DEFERRED_TOOLS_RESTORE=1`)
- `order`: `350` (after `identity-normalization` at 300, before `cache-control-normalize` at 400 — block content must be stable before cache_control marker placement)
- Hook: `onRequest(ctx)` — locates block, persists or restores

### Test seam (no public env var)

Match the prefix-diff revision: **do not** introduce `CACHE_FIX_DEFERRED_TOOLS_DIR` as a runtime env var. Instead, export the underlying pure functions alongside `default`:

- `extractCwdFromSystem(systemPrompt)` — returns the cwd string or `null` if no marker found, exposed for tests
- `deriveSnapshotKey(cwd)` — returns `sha1("cwd:" + cwd).slice(0, 16)`, exposed for tests
- `findDeferredToolsBlockInBody(body)` — returns `{ msgIdx, blockIdx, text } | null`
- `persistDeferredTools(text, options)` — atomic write to `options.dir`
- `restoreDeferredTools(options)` — read + validate; returns `string | null`
- `default.onRequest(ctx)` orchestrates with `options.dir = getSnapshotDir()` (internal, default `~/.claude/cache-fix-state/`)

Tests call the pure functions with their own `tmpdir()`-based options. Same pattern as `image-strip.mjs`.

### Error handling

- Wrap all I/O in try/catch.
- Snapshot write failure → silent in production; `process.stderr.write("[deferred-tools-restore] write failed: <err>\n")` when `CACHE_FIX_DEBUG=1`.
- Snapshot read failure → silent in production; same debug-gated stderr line.
- Never throw out of `onRequest`; never block the request.

### Telemetry

Emit a `process.stderr.write` line on `applied` and `persisted` events, matching the existing extension style:
- `[deferred-tools-restore] persisted N bytes (key=<key>)`
- `[deferred-tools-restore] restored N→M bytes at msg[X].content[Y] (key=<key>)`

Set `ctx.meta.deferredToolsRestoreStats = { action: "persisted"|"restored"|"skipped", bytes: <N>, key: <key> }` for observability.

## Tests (in `test/proxy-deferred-tools-restore.test.mjs`)

1. No-op when `CACHE_FIX_SKIP_DEFERRED_TOOLS_RESTORE=1`
2. No-op when no deferred-tools block exists in `body.messages`
3. No-op when `payload.system` is absent
4. **No-op when cwd marker is not present in `payload.system`** (assert that no file is written and no restore is attempted; assert that `ctx.body` is unchanged)
5. `extractCwdFromSystem` returns the path when the marker is present in any block of the system array; returns `null` otherwise
6. `extractCwdFromSystem` is robust against the marker appearing inside a code-fenced or quoted region of an unrelated block (the implementation should look in expected positions, not just any text containing the marker substring)
7. `deriveSnapshotKey("/foo")` is deterministic across calls; `deriveSnapshotKey("/foo")` ≠ `deriveSnapshotKey("/bar")`
8. Persists snapshot when block is clean (no UNAVAILABLE marker) AND cwd is parseable
9. Restores from snapshot when current block has UNAVAILABLE marker AND snapshot is longer AND cwd is parseable
10. **Downgrade guard — exhaustive boundary tests:**
    - Snapshot exactly 1 byte shorter than current → skip restore
    - Snapshot many bytes shorter than current → skip restore
    - Snapshot exactly equal length to current → skip restore (must be **strictly** longer)
    - Snapshot 1 byte longer → restore
11. Skips restore when no snapshot file exists
12. Skips assistant messages (block in assistant content does not trigger detection)
13. Locates block at `messages[N].content[M]` for arbitrary N, M (not just `[0][0]`)
14. **Atomic write under failure:** simulate `rename` throwing after `.tmp` write succeeds; assert the prior snapshot file is intact and unchanged
15. **Atomic write — temp-write failure:** simulate `writeFile` throwing on the `.tmp` path; assert no `.tmp` orphan, no rename attempted, prior snapshot intact
16. **Truncated snapshot rejection:** write a snapshot file shorter than `AVAILABLE_MARKER.length`; next call must skip restore (never substitute a truncated value)
17. **Missing-marker rejection:** write a same-length snapshot that doesn't contain the AVAILABLE marker; next call must skip restore
18. **Concurrent invocations:** fire two `default.onRequest` calls in parallel against the same key; assert no throw, snapshot file is one of the two valid versions (not partial), and at least one call's stats reflect the persistence
19. Snapshot read failure (point dir at unreadable path) does not throw; debug-logs when `CACHE_FIX_DEBUG=1`
20. Snapshot write failure (point dir at `/dev/null/nope`) does not throw; debug-logs when `CACHE_FIX_DEBUG=1`

## README update (handles #59 item 10)

Edit `README.md`'s "Recommended: disable git-status injection" section (line ~274) to add an explicit note. Phrasing must reflect the **technical reason** (we can't), not just preference (we chose not to):

> **Why we don't ship a proxy extension for this:** the proxy intercepts requests after Claude Code has already composed the system prompt — by then the volatile `git status` text is already part of the prefix that the model conditioned on in the previous turn, and stripping it post-hoc would itself bust the cache. The fix has to happen at the source. `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` prevents the injection before the prompt is composed, which is why the native flag is the right tool. Stripping post-hoc would additionally remove model-visible context that an explicit Bash call can recover, and would risk false-positive matches against assistant-written text.

Closing-out comment on #59 should reference this README addition.

## Out of scope

- No `extensions.json` registration (auto-loaded from `proxy/extensions/`)
- No image-stripping section update (separate cleanup; that section is mislabeled "preload mode" but the proxy now supports it — track separately)
- No CHANGELOG bump (release work)

## Acceptance

- All 20 new tests pass; full proxy test suite green
- The cwd-marker format is verified empirically against current CC v2.1.117+ system prompts (capture via request-log; document the actual marker shape in a code comment)
- README has the "why we don't ship" note in the git-status section, phrased as technical impossibility (not preference)
- `claude --continue` against a project with MCP delay shows `[deferred-tools-restore] restored ...` in proxy stderr and a corresponding cache-creation drop
- Codex implementation-stage review with no blockers
- PR description closes #59 (`Closes #59`)

## #59 close-out comment (for the merger to post when merging)

> Final piece of the port. Item 10 (git-status strip) is intentionally not ported because the proxy can't fix it — by the time a request reaches the proxy, CC has already composed the system prompt and conditioned the prior turn on its contents. The fix has to happen at the source via `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`. README updated in this PR to document the reasoning.
>
> Closing #59. All ten items resolved (eight ported, item 10 deferred to native CC flag with README note).
>
> — AI Team Lead

— AI Team Lead
