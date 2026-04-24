# Directive: Port `prefix-diff` to proxy extension

**Issue:** #59 item 9
**Branch:** `feature/proxy-prefix-diff`
**Stage:** directive

## Goal

Port the `CACHE_FIX_PREFIXDIFF` diagnostic from `preload.mjs` to a proxy extension. Pure observability — no request modification.

## Why

Users on CC v2.1.113+ (Bun binary) cannot load the Node `--import` preload, so all preload-only diagnostics are invisible to them. Prefix-diff is the most useful tool we have for hunting cache-bust sources at the prefix level (first 5 messages + system + tools), and it deserves to work for proxy users.

## Reference (preload behavior to mirror)

- `preload.mjs` lines ~1656–1742 (`snapshotPrefix(payload)`)
- Env var: `CACHE_FIX_PREFIXDIFF=1` (opt-in, off by default)
- Snapshot dir: `~/.claude/cache-fix-snapshots/`
- Session key: `sha256(JSON.stringify(payload.system).slice(0, 2000)).slice(0, 12)` — stable across restarts for the same project, different per project
- On every call: write current snapshot to `<key>-last.json`
- On the **first call after extension boot only**: read previous `<key>-last.json`, compute diff against current, write to `<key>-diff.json`, log a one-line debug summary

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
- `enabled`: `false` (opt-in via `CACHE_FIX_PREFIXDIFF=1` — extension is always loaded but no-ops unless env var is set, matching the preload pattern)
- `order`: `750` (after `usage-log` at 650, before `request-log` at 700 — actually pick `680` to sit between them; this is observability, not request mutation)
- Hook: `onRequest(ctx)` — read `ctx.body`, compute snapshot/diff, write to disk, never mutate `ctx.body`

**Important:** must not throw on any I/O failure. Wrap snapshot/diff writes in try/catch and silently swallow. The preload version does the same — the diagnostic is best-effort.

## Tests (in `test/proxy-prefix-diff.test.mjs`)

1. Returns silently when `CACHE_FIX_PREFIXDIFF` is unset
2. Writes `<key>-last.json` to a temp snapshot dir on first call when enabled
3. Session key derives from `system` content (same system → same key, different system → different key)
4. Truncates message text >500 chars with `...[N chars]` marker
5. Strips `cache_control` from snapshotted blocks
6. On second call (after temp file exists), produces a `<key>-diff.json` with non-zero `prefixDiffs` when prefix changed
7. `toolsHash` / `systemHash` mismatch flips `toolsMatch` / `systemMatch` flags correctly
8. Diff fires only on the first call per extension lifetime (subsequent calls only update `<key>-last.json`)
9. Does not mutate `ctx.body` (assert structural equality before/after)
10. Swallows write errors (point snapshot dir at `/dev/null/nope` and assert no throw)

Use a per-test temp snapshot dir via `process.env.HOME = tmpdir()` or by exposing the snapshot dir path through env (preferred — add `CACHE_FIX_PREFIXDIFF_DIR` for test override; if unset, default to `~/.claude/cache-fix-snapshots/`).

## Out of scope

- No registration in `extensions.json` (extensions auto-load from `proxy/extensions/`)
- No README changes (the README's "Diagnostic env vars" section will be touched in the deferred-tools-restore PR alongside the #10 update)

## Acceptance

- All new tests pass; full proxy test suite green
- `CACHE_FIX_PREFIXDIFF=1 ANTHROPIC_BASE_URL=http://localhost:9801 claude` produces snapshot and diff files in `~/.claude/cache-fix-snapshots/`
- `ctx.body` is never modified by this extension
- Codex review with no blockers

— AI Team Lead
