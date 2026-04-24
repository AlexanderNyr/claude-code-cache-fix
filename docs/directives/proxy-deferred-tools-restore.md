# Directive: Port `deferred-tools-restore` to proxy extension + close out #59

**Issues:** #59 item 6 (deferred-tools-restore), #59 item 10 (git-status strip — closed via README, not ported)
**Branch:** `feature/proxy-deferred-tools-restore`
**Stage:** directive

This is the **final PR for #59**. It ports the last behavior-bearing item, documents why item 10 is intentionally not ported, and closes #59.

## Goal

Port the `deferred_tools_restore` fix from `preload.mjs` to a proxy extension. This **modifies outgoing requests** by substituting a stale, shrunken deferred-tools attachment block with a previously-snapshotted full-form copy when MCP servers haven't reconnected yet at resume time.

## Why

Observed empirically: on `claude --continue`, if MCP servers haven't finished reconnecting before CC fires the first post-resume request, the `<system-reminder>The following deferred tools are now available via ToolSearch…` block at `msg[0]` (or wherever the attachment lands post-compaction) shrinks dramatically. A full list of ~40 tools collapses to a handful of CC built-ins, and CC injects a trailing `The following deferred tools are no longer available (their MCP server disconnected). Do not search for them — ToolSearch will return no match:` notice.

That block change at the root of the message array busts the cache at the very top — the entire ~940K prompt re-caches. By the time the second post-resume request fires, MCPs are usually reconnected and the block is full again, but the cache is already committed to the shrunk version for this session.

## Reference (preload behavior to mirror)

- `preload.mjs` lines ~429–518 (helpers + constants)
- `preload.mjs` lines ~2286–2322 (integration block)
- Env var: `CACHE_FIX_SKIP_DEFERRED_TOOLS_RESTORE=1` to opt out (extension defaults **ON**)
- Snapshot dir: `~/.claude/cache-fix-state/`
- Snapshot file: `deferred-tools-<sha1(key).slice(0,16)>.txt`
- Snapshot key: `process.cwd()` (one snapshot per project)
- Markers:
  - AVAILABLE: `"The following deferred tools are now available via ToolSearch"`
  - UNAVAILABLE: `"The following deferred tools are no longer available"`

### Algorithm

1. Walk `body.messages` to locate the deferred-tools block — only `role: "user"` messages, only `type: "text"` blocks containing the AVAILABLE marker. Return `{ msgIdx, blockIdx, text }` or `null`. (Skip assistant messages so the agent quoting the marker doesn't trigger a false match.)
2. If no block found → no-op, return.
3. If block exists and does **not** contain the UNAVAILABLE marker → it's a clean baseline. Persist it to the snapshot file (best-effort; swallow I/O errors). Done.
4. If block exists and **does** contain the UNAVAILABLE marker → attempt restore:
   - Read snapshot file.
   - **Only substitute if the snapshot is strictly longer than the current block.** Never downgrade to a stale shorter snapshot. (This is the safety guard from the preload version — keep it.)
   - Substitute by replacing `messages[msgIdx].content[blockIdx].text` with the snapshotted bytes.

### Trade-off (document in extension header comment, mirroring preload)

The restored block may reference MCP tools that haven't actually reconnected yet. If the agent calls ToolSearch on one of them → no match → one retry. Tiny cost versus a full-prompt cache miss on every resume.

## Extension contract

- File: `proxy/extensions/deferred-tools-restore.mjs`
- `name`: `"deferred-tools-restore"`
- `description`: `"Persist and restore the deferred-tools attachment block across sessions to prevent MCP-reconnect-race cache busts at resume time"`
- `enabled`: `true` (defaults ON, mirroring preload — opt out via `CACHE_FIX_SKIP_DEFERRED_TOOLS_RESTORE=1`)
- `order`: `350` (after `identity-normalization` at 300, before `cache-control-normalize` at 400 — block content must be stable before cache_control marker placement)
- Hook: `onRequest(ctx)` — locates block, persists or restores
- Snapshot dir override (for tests): `CACHE_FIX_DEFERRED_TOOLS_DIR` env var; default `~/.claude/cache-fix-state/`

**Error handling:** mirror preload — wrap all I/O in try/catch and silently swallow. Snapshot write failure must not block the request. Snapshot read failure is treated as "no snapshot" (skip restore).

**Telemetry:** emit a `process.stderr.write` line on `applied` and `persisted` events, matching the existing extension style:
- `[deferred-tools-restore] persisted N bytes to <path>`
- `[deferred-tools-restore] restored N→M bytes at msg[X].content[Y]`

Set `ctx.meta.deferredToolsRestoreStats = { action: "persisted"|"restored"|"skipped", bytes: <N> }` for observability.

## Tests (in `test/proxy-deferred-tools-restore.test.mjs`)

1. No-op when `CACHE_FIX_SKIP_DEFERRED_TOOLS_RESTORE=1`
2. No-op when no deferred-tools block exists in `body.messages`
3. Persists snapshot when block is clean (no UNAVAILABLE marker)
4. Snapshot path derives correctly from `CACHE_FIX_DEFERRED_TOOLS_DIR` + sha1(cwd) hash
5. Restores from snapshot when current block has UNAVAILABLE marker AND snapshot is longer
6. **Does not** restore when snapshot exists but is shorter than current block (downgrade guard)
7. **Does not** restore when no snapshot file exists
8. Skips assistant messages (block in assistant content does not trigger detection)
9. Locates block at `messages[N].content[M]` for arbitrary N, M (not just `[0][0]`)
10. Snapshot read failure does not throw; results in skipped restore
11. Snapshot write failure (point dir at `/dev/null/nope`) does not throw

Use `CACHE_FIX_DEFERRED_TOOLS_DIR=<tmpdir>` for test isolation.

## README update (handles #59 item 10)

Edit `README.md`'s "Recommended: disable git-status injection" section (line ~274) to add an explicit note:

> **Why we don't ship a proxy extension for this:** `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` is the right tool for the job — it prevents the injection at the source rather than stripping it after the fact. Stripping post-hoc would also remove the agent's ability to see git context that an explicit Bash call can recover, and would risk false-positive matches against assistant-written text. Use the native flag.

This is the substance of why item 10 is intentionally not ported. Closing-out comment on #59 should reference this README addition.

## Out of scope

- No `extensions.json` registration (auto-loaded from `proxy/extensions/`)
- No image-stripping section update (separate cleanup; that section is mislabeled "preload mode" but the proxy now supports it — track separately)
- No CHANGELOG bump (release work)

## Acceptance

- All 11 new tests pass; full proxy test suite green
- README has the "why we don't ship" note in the git-status section
- `claude --continue` with `MCP_DELAY_HACK=true` (or equivalent simulation in a manual test) shows `[deferred-tools-restore] restored ...` in proxy stderr and the corresponding cache-creation drop
- Codex review with no blockers
- PR description closes #59 (`Closes #59`)

## #59 close-out comment (for the merger to post when merging)

> Final piece of the port. Item 10 (git-status strip) is intentionally not ported — `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` already does the right thing at the source, and stripping post-hoc has worse trade-offs than the native flag (false-positive risk against assistant text, removes recoverable Bash-tool context). README updated in this PR to document the reasoning.
>
> Closing #59. All ten items have been resolved (eight ported, item 10 deferred to native CC flag with README note).
>
> — AI Team Lead

— AI Team Lead
