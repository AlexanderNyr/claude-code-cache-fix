# Integration with @fgrosswig's Dashboard

This interceptor and [@fgrosswig](https://github.com/fgrosswig)'s
[claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard)
solve strongly complementary problems. The interceptor captures per-call API
data from inside the Node.js process — cache metrics, quota state, TTL tier,
rewrites applied. The dashboard provides the visualization layer — historical
trending, per-day charts, multi-host aggregation, cache-health scoring.

Running both gives you the best of both tools, and the integration is a
one-liner thanks to the dashboard's tolerant NDJSON ingest and our
`usage-to-dashboard-ndjson` translator.

## Quick setup

```bash
# Install both tools
npm install -g claude-code-cache-fix
# (follow fgrosswig's dashboard install: https://github.com/fgrosswig/claude-usage-dashboard)

# One-shot translation (reads ~/.claude/usage.jsonl, writes to
# ~/.claude/anthropic-proxy-logs/proxy-YYYY-MM-DD.ndjson, which his
# dashboard already watches)
node $(npm root -g)/claude-code-cache-fix/tools/usage-to-dashboard-ndjson.mjs

# Or keep it live-updating as the interceptor logs new calls
node $(npm root -g)/claude-code-cache-fix/tools/usage-to-dashboard-ndjson.mjs --follow &
```

No configuration required on the dashboard side — fgrosswig's
`collectProxyNdjsonFiles()` auto-discovers files in
`~/.claude/anthropic-proxy-logs/` (or `$ANTHROPIC_PROXY_LOG_DIR`), and our
translator writes to exactly that path with the expected `proxy-YYYY-MM-DD.ndjson`
filename convention. The dashboard's tolerant ingestion layer ignores unknown
fields, so interceptor-specific extras (`ttl_tier`, `ephemeral_1h_input_tokens`,
`ephemeral_5m_input_tokens`, `peak_hour`, quota state) pass through cleanly
and remain available to downstream consumers that know to read them.

## Schema compatibility

The translator accepts both schemas of `~/.claude/usage.jsonl` transparently
(v3.5.3+):

- **Preload-era schema** — written by the v2.x preload interceptor:
  `entry.timestamp`, `entry.q5h_pct` / `entry.q7d_pct` (int 0–100).
- **MeterRowSchema v:1** — written by the v3.2.0+ proxy `usage-log`
  extension: `entry.ts`, `entry.q5h` / `entry.q7d` (float 0–1).

The same logical request emits the same `req_id` in either schema, so
dashboards that dedup on `req_id` won't see duplicates from a user
upgrading preload → proxy.

> **Affected versions (#112):** users running v3.2.0 through v3.5.2 with
> the proxy `usage-log` extension enabled saw the translator silently drop
> every row — the dashboard received zero data from those sessions. Fixed
> in **v3.5.3**. Upgrade if you're on a v3.5.x earlier than 3.5.3 and
> using the bridge.

## Cost factor metric

The `cost_factor` metric in `tools/cost-report.mjs` comes from
fgrosswig's methodology — the `(input + output + cache_read + cache_creation) / output`
ratio that gives a single-number measure of how much context is being paid
per useful output token. A rising cost factor across a long session is the
measurable signature of cache-efficiency degradation.
