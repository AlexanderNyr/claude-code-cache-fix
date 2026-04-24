# Directive: Port `prefix-diff` to proxy extension

**Issue:** #59 item 9
**Branch:** `feature/proxy-prefix-diff`
**Stage:** directive (revised after Codex review — see `docs/code-reviews/`)

## Goal

Port the `CACHE_FIX_PREFIXDIFF` diagnostic from `preload.mjs` to a proxy extension. Pure observability — no request modification.

## Why

Users on CC v2.1.113+ (Bun binary) cannot load the Node `--import` preload, so all preload-only diagnostics are invisible to them. Prefix-diff is the most useful tool we have for hunting cache-bust sources at the prefix level (first 5 messages + system + tools), and it deserves to work for proxy users.

## Adaptation from preload behavior

The preload version's "diff fires once on the first API call after process restart" semantics do not translate cleanly to a long-lived proxy that supports hot-reload. The "first call" gate would either fire on every reload (false signal) or never fire after the initial boot (silent diagnostic). **The proxy version drops the first-call flag entirely and runs the diff comparison on every call**, writing a diff file only when there are actual differences.

Trade-off: more disk writes, but the writes are tiny (one small JSON per call when something changed) and the diagnostic value is higher — drift can be observed across every turn, not just at startup. There is no concurrency race because each call's snapshot/diff is independent of the previous call's success.

### Reference (preload behavior to mirror in spirit, not literally)

- `preload.mjs` lines ~1656–1742 (`snapshotPrefix(payload)`)
- Env var: `CACHE_FIX_PREFIXDIFF=1` (opt-in, off by default)
- Snapshot dir: `~/.claude/cache-fix-snapshots/`
- Session key: `sha256(JSON.stringify(payload.system).slice(0, 2000)).slice(0, 12)` — stable across restarts for the same project, different per project

### Per-call algorithm (revised)

1. Build current snapshot from `ctx.body` (system hash, tools hash, first-5 messages with `cache_control` stripped and text >500 chars truncated).
2. Read prior `<key>-last.json` if it exists. Treat unreadable/corrupt JSON as "no prior snapshot" (skip diff, proceed to write).
3. If a prior snapshot existed and content differs from current → compute and write `<key>-diff.json`. Emit one-line debug log via `[prefix-diff] <key>: N differences, tools=match/DIFFER, system=match/DIFFER`.
4. Atomically write the new `<key>-last.json` (write to `<key>-last.json.tmp`, then `rename` to final path) so a partial write never leaves a corrupt snapshot for the next call.
5. Never throw. Wrap I/O in try/catch. **When `CACHE_FIX_DEBUG=1` is set, debug-log the swallowed error** so silent failures are still observable to users diagnosing the diagnostic.

### Snapshot shape

```json
{
  "timestamp": "<ISO>",
  "messageCount": <int>,
  "toolsHash": "<sha256(tool names).slice(0,16)>",
  "systemHash": "<sha256(system).slice(0,16)>",
  "prefixMessages": [
    { "role": "...", "content": [/* first 5 msgs, cache_control stripped, text >500 chars truncated with `...[N chars]` marker */] }
  ]
}
```

### Diff shape

```json
{
  "timestamp": "<ISO>",
  "prevTimestamp": "<ISO>",
  "toolsMatch": <bool>,
  "systemMatch": <bool>,
  "messageCountPrev": <int>,
  "messageCountNow": <int>,
  "prefixDiffs": [
    { "index": <int>, "prev": <msg|null>, "now": <msg|null> }
  ]
}
```

## Extension contract

- File: `proxy/extensions/prefix-diff.mjs`
- `name`: `"prefix-diff"`
- `description`: `"Snapshot prefix (first 5 msgs + system + tools) and diff against previous run for cache-bust hunting"`
- `enabled`: `false` (opt-in via `CACHE_FIX_PREFIXDIFF=1`)
- `order`: `680` (sits between `usage-log` at 650 and `request-log` at 700 — observability, not request mutation)
- Hook: `onRequest(ctx)` — read `ctx.body`, compute snapshot/diff, write to disk, never mutate `ctx.body`

### Test seam (no public env var)

The previous draft proposed `CACHE_FIX_PREFIXDIFF_DIR` for test isolation. **Drop it** — it's a test-only seam and shouldn't be a public runtime config knob. Instead:

- The snapshot directory is computed by an internal helper `getSnapshotDir()` (not exported in `default`). The extension's `default` export is the production-shaped pipeline interface.
- For tests, **export the underlying `snapshotPrefix(payload, options)` pure function** alongside `default`, where `options.dir` overrides the snapshot directory. Tests call this directly with a per-test `tmpdir()`. The default export's `onRequest` calls `snapshotPrefix(ctx.body, { dir: getSnapshotDir() })` internally.
- This is the same pattern `image-strip.mjs` uses (exports `stripOldToolResultImages` alongside `default`).

## Tests (in `test/proxy-prefix-diff.test.mjs`)

Unit tests on the exported `snapshotPrefix(payload, options)`:

1. No-op when env var unset (asserts via `default.onRequest` with env clean)
2. Writes `<key>-last.json` to `options.dir` on first invocation
3. Session key derives from `system` content (same system → same key; different system → different key)
4. Truncates message text >500 chars with `...[N chars]` marker
5. Strips `cache_control` from snapshotted blocks
6. On second call when snapshot is unchanged → no diff file written; `<key>-last.json` is still rewritten (atomic)
7. On second call when snapshot differs → `<key>-diff.json` written with non-zero `prefixDiffs`
8. `toolsHash` / `systemHash` mismatch flips `toolsMatch` / `systemMatch` flags
9. Atomic write: simulate a write that fails after `.tmp` exists (e.g., monkey-patch `rename` to throw); assert the prior `<key>-last.json` is still intact
10. Corrupt prior snapshot (write `{not json` to `<key>-last.json`); next call must skip the diff and overwrite the snapshot, never throw
11. Concurrent invocations on the same `payload`/`options.dir` — fire two `snapshotPrefix` calls in parallel, await both; assert no throw and final snapshot is consistent (one of the two, not corrupted)
12. Hot-reload semantics — after writing snapshot N, simulate a fresh extension load (re-import) and call `snapshotPrefix` with N+1; assert diff fires correctly (no module-level state required)
13. Does not mutate `ctx.body` (assert structural equality before/after `default.onRequest`)
14. mkdir/write failure with `CACHE_FIX_DEBUG=1` set: capture stderr, assert error logged but no throw and request flow uninterrupted

## Out of scope

- No registration in `extensions.json` (extensions auto-load from `proxy/extensions/`)
- No README changes in this PR (the README's diagnostic section will be touched in PR #66 alongside the #10 update)

## Acceptance

- All new tests pass; full proxy test suite green
- `CACHE_FIX_PREFIXDIFF=1 CACHE_FIX_DEBUG=1 ANTHROPIC_BASE_URL=http://localhost:9801 claude` produces snapshot and (when prefix changes) diff files in `~/.claude/cache-fix-snapshots/`
- `ctx.body` is never modified
- Codex re-review with no blockers

— AI Team Lead
