# Directive: cache-warmer extension (v3.7.0)

**Issue:** #127
**Branch:** `feat/proxy-cache-warmer-directive` (this directive), implementation branch TBD post-approval
**Stage:** directive
**Milestone:** v3.7.0

## Goal

Add a `cache-warmer` extension to `cache-fix-proxy` that keeps idle sessions' Anthropic prompt caches warm by synthesizing minimal keepalive requests when a session goes quiet. Replaces CC's session-only `/coffee` skill with a proxy-layer substrate that survives CC session restarts and box reboots, and works for any client routed through cache-fix.

## Why

`/coffee` works but is bounded by three structural limits: CC's internal cron is session-only (the documented `durable: true` flag silently fails); one warmer per CC session doesn't scale to multi-agent hosts running 5–6 concurrent sessions; and the skill is CC-only, helping no other Anthropic consumer.

MCP-based alternatives (server-initiated `sampling/createMessage`) were ruled out: CC does not implement the MCP sampling client capability, confirmed via binary inspection. No path forward there until Anthropic adds it.

cache-fix-proxy is the right layer: long-lived systemd-managed service, sees every API request, has per-session attribution, has an extensions architecture for adding opt-in behavior. The state surfaces required (latest payload + auth header per session) are already in the proxy's request path; capturing them is incremental, not a new collection mechanism.

## Behavior

```
on every real request from session S:
  inflight[S] = true
  store latest payload snapshot for S
  store latest auth header for S
  on completion: inflight[S] = false; reset warming timer for S

every <ping_interval> minutes (TTL-tier-aware):
  for each session S with stored payload, idle for >= ping_interval, not inflight:
    if Q5h ≥ skip_threshold for the account — skip, log "warming skipped — quota pressure"
    if inactivity > max_idle_hours — skip, log "warming skipped — session dormant"
    if daily cost cap reached — skip, log "warming paused until UTC rollover"
    else:
      synthesize warming request from stored payload + minimal user message ("ping"), max_tokens: 1
      send to api.anthropic.com with stored auth header + X-Cache-Fix-Warmer: 1 (stripped before forward)
      log result (cost, latency, cache_read tokens, error) to NDJSON
      increment per-account daily cost counter
      reset timer for S
```

Synthetic requests are tagged with the `X-Cache-Fix-Warmer: 1` header internally, used to exclude them from timer-reset accounting and from any other extension that should ignore warming traffic (notably `usage-log` / claude-meter ingest — synthetic pings must not pollute the telemetry stream). The header is stripped before forwarding upstream.

## State surfaces (new state introduced by this extension)

Two new in-memory state surfaces in the proxy. Both are explicit, bounded, and memory-only.

### Auth-token retention

| Property | Spec |
|---|---|
| Storage | In-memory only. No NDJSON entry, no file write. |
| Capture | Latest `Authorization` header value from each successful real request, keyed by session id. |
| Expiry | After `warmer_token_ttl_hours` (default: **8**, aligned with realistic Anthropic token lifetimes). |
| 401 handling | On 401 during a warming ping, drop the entry silently; wait for next real request to refresh. |
| Log redaction | Any NDJSON log line that touches an auth-bearing request redacts the `Authorization` header value before write. |
| Restart | Storage map is process-local; cleared on proxy restart. No persistence file. |

### Payload retention

| Property | Spec |
|---|---|
| Storage | In-memory only. No disk persistence. |
| Capture | Most recent request body that was successfully forwarded upstream (excludes malformed bodies and synthetic warming requests). Last-snapshot-wins; overwritten on every successful real request. |
| Size cap | `warmer_payload_cap_mb` (default: **8** MB — covers ~2M-token sessions with headroom). Sessions exceeding the cap fall back to "skip warming for this session" rather than retaining partial state. |
| Eviction | Sessions with no real traffic for > `warmer_session_eviction_hours` (default: **24**) drop their snapshot entirely. |
| Restart | Same as auth-token: process-local, cleared on proxy restart. |

## Lifecycle decisions

| Choice | Default | Rationale |
|---|---|---|
| Default state | **off** | Opt-in via `extensions.json`. Don't surprise users with billing. |
| Ping interval | tier-aware: 50 min (1h tier), 4 min (5min tier) | Matches Anthropic's cache TTL windows. |
| Max idle before backoff | 6 hours | After 6h silence the user is probably away; warming is unlikely to pay back. |
| Q5h pressure skip threshold | 80% | If quota is approaching saturation, warming is the lower-priority consumer. |
| Daily cost cap | $10 per account | Hard ceiling against runaway billing. |
| Idempotency | per-session in-flight flag | If a real request is in flight, skip the synthetic ping that cycle and reset the timer when the real one completes. |
| Synthetic-request tagging | `X-Cache-Fix-Warmer: 1` header (stripped before forwarding upstream) | Internal accounting; exclude synthetic requests from timer-reset and from claude-meter ingest. |

## Daily cost cap mechanics

- **Scope:** per-account. The proxy may serve multiple sessions sharing one Anthropic account; the cap applies to the sum.
- **Bookkeeping:** in-memory counter only. Restart resets to zero — graceful, matches the rest of the state surface.
- **Rollover:** UTC midnight. Aligns with Anthropic's quota window.
- **Saturation behavior:** pause warming until next UTC rollover. Single NDJSON line announces the pause; resume automatically on next interval after rollover.

The cost-per-ping is computed from the response's `cache_read_input_tokens` × Anthropic's published cache-read rate (10% of base). Approximate but sufficient for cap enforcement; the README is explicit that the cap is a guardrail, not a precise budget.

## TTL detection

Pure Node, in-extension. Reads `~/.claude/quota-status/sessions/<session>.json` directly per real request and per warming cycle. Inline rule:

```js
if (state.five_hour.pct >= 100 || state.overage_status !== "allowed") {
  return { tier: "5min", interval_minutes: 4, gap_threshold_minutes: 6 };
}
return { tier: "1h", interval_minutes: 50, gap_threshold_minutes: 65 };
```

No dependency on `claude-code-meter`'s `cache_analysis.py`. The detection is small enough to live inline.

## Restart-priming

Memory-only state + no persistence means the warmer has no snapshots or timers after a proxy restart. Each session must make a fresh real request to re-prime the warmer for that session. This is a property of the design, not a bug — documented in the README so users understand the post-restart no-op-until-fresh-real-request behavior.

## Status endpoint

`GET /v1/warmer/status` — extends the existing versioned URL space the proxy already serves. Returns JSON only, no UI.

```json
{
  "enabled": true,
  "config": {
    "warmer_token_ttl_hours": 8,
    "warmer_payload_cap_mb": 8,
    "warmer_session_eviction_hours": 24,
    "warmer_max_idle_hours": 6,
    "warmer_quota_skip_threshold": 0.80,
    "warmer_daily_cap_usd": 10.0
  },
  "daily_cost": {
    "spent_usd": 1.42,
    "cap_usd": 10.0,
    "rollover_at": "2026-05-17T00:00:00Z",
    "paused": false
  },
  "sessions": [
    {
      "session_id": "abc12345",
      "last_real_request_at": "2026-05-16T13:25:01Z",
      "last_warming_ping_at": "2026-05-16T14:15:03Z",
      "last_warming_result": {
        "cost_usd": 0.23,
        "cache_read_input_tokens": 745000,
        "error": null
      },
      "next_warming_at": "2026-05-16T15:05:03Z",
      "inflight": false,
      "snapshot_age_seconds": 4920
    }
  ]
}
```

Pretty per-session dashboard / visualization remains out of v0 scope.

## Token-TTL effectiveness ceiling

Anthropic auth tokens last considerably longer than the prompt cache, but they DO expire. For a >48h idle session the token expires before the cache, and the warmer becomes a no-op until a real request refreshes the token — at which point a cold rebuild has likely already happened on return. **This is a structural limit, not a bug.** The README documents the expectation accordingly so users don't expect "infinite warm" behavior.

## Configuration

Canonical config lives in `extensions.json` under the `cache-warmer` entry.

```json
{
  "cache-warmer": {
    "enabled": false,
    "warmer_token_ttl_hours": 8,
    "warmer_payload_cap_mb": 8,
    "warmer_session_eviction_hours": 24,
    "warmer_max_idle_hours": 6,
    "warmer_quota_skip_threshold": 0.80,
    "warmer_daily_cap_usd": 10.0
  }
}
```

Env vars supported as override-only: `CACHE_FIX_WARMER_ENABLED`, `CACHE_FIX_WARMER_TOKEN_TTL_HOURS`, `CACHE_FIX_WARMER_PAYLOAD_CAP_MB`, `CACHE_FIX_WARMER_SESSION_EVICTION_HOURS`, `CACHE_FIX_WARMER_MAX_IDLE_HOURS`, `CACHE_FIX_WARMER_QUOTA_SKIP_THRESHOLD`, `CACHE_FIX_WARMER_DAILY_CAP_USD`.

**Precedence:** env var > `extensions.json` > built-in default. README documents this explicitly so anyone overriding by env var knows `extensions.json` is being ignored for those keys.

## Migration / coexistence with `/coffee`

- **Proxy users:** the warmer obsoletes `/coffee`. README recommends users running through cache-fix-proxy disable `/coffee` to avoid double-warming. Side-by-side use is not catastrophic — both fire pings, doubling the keep-alive cost — but is wasteful.
- **Non-proxy users (CC ≤ v2.1.112 preload path):** `/coffee` remains the only option; the warmer is unavailable to them by construction.
- **`/coffee` skill itself:** not auto-deprecated by the warmer landing. Whether to deprecate is a separate decision tracked outside this directive.

## Scope (v3.7.0)

- [ ] `proxy/extensions/cache-warmer.mjs` — extension file with the behavior loop above
- [ ] Default-off; opt-in via `extensions.json`
- [ ] Per-session payload + auth capture from real traffic, with retention specs as documented
- [ ] TTL-tier-aware per-session warming timer (in-Node detection)
- [ ] Per-session in-flight flag (idempotency)
- [ ] Q5h pressure skip (default 80%)
- [ ] Max-idle backoff (default 6h)
- [ ] Daily cost cap with documented mechanics (per-account, in-memory, UTC midnight, pause-until-rollover)
- [ ] Session eviction (default 24h no real traffic)
- [ ] Synthetic-request tagging via `X-Cache-Fix-Warmer: 1` (stripped before forwarding)
- [ ] `usage-log` / claude-meter ingest must skip rows tagged as synthetic warming
- [ ] `GET /v1/warmer/status` endpoint
- [ ] NDJSON logging of warming events to existing debug log, with `Authorization` redaction
- [ ] Audit existing logging extensions for `Authorization` redaction
- [ ] README section: opt-in pattern, cost expectations, token-TTL ceiling, restart-priming behavior, `/coffee` coexistence, config precedence
- [ ] Test coverage: synthesize-warming-request logic (mocked upstream)
- [ ] Test coverage: idempotency flag (in-flight blocks ping)
- [ ] Test coverage: cost cap (per-account, UTC midnight rollover, pause-until-rollover)
- [ ] Test coverage: session eviction (24h+ idle drops snapshot)
- [ ] Test coverage: TTL-tier transition (1h ↔ 5min when quota crosses thresholds)
- [ ] CHANGELOG entry for v3.7.0

## Out of scope (v3.8.0+)

- Pretty per-session dashboard / visualization (JSON status endpoint covers v0)
- Sophisticated activity-prediction heuristics
- Cross-session priority / fairness logic beyond simple skip-on-saturation
- Auto-recovery if many tokens expire simultaneously
- Cross-account warming budgets

## Cost model (for README)

Single session at 1h tier with 750k context:
- ~$0.23 per warming ping
- Ping every 50 min × 28 hours (assuming 6h idle backoff) = 28 pings/day max
- Default $10 daily cap would stop warming after ~43 pings/day
- **Realistic daily cost: $3–7** depending on session activity pattern

Cold rebuild on user's return is ~$5.67. If the user returns to the session 2+ times per day after >1h idle, the warmer pays for itself.

The README is explicit that the warmer is **only economical for high-context, frequently-resumed sessions**. Low-context or rarely-resumed sessions should leave warming off.

## Verification plan

Before tagging v3.7.0:

1. Full test suite green (`npm test`) — pipeline + per-extension + integration
2. Manual smoke: enable warmer in a long-running CC session, observe NDJSON warming-event lines, confirm `cache_read_input_tokens` matches expected context size
3. `GET /v1/warmer/status` returns coherent per-session state
4. Disable `/coffee`, run for 8h with warmer enabled, confirm no double-warming visible in NDJSON
5. Trigger quota pressure (simulated via mocked quota-status file) and verify warming skips with appropriate log line
6. Restart proxy mid-window, confirm warmer goes no-op until next real request per session, then resumes

## Open questions resolved during spec convergence

The following were raised by Proxy Builder during issue #127 thread review and resolved in the spec above:

- Auth-token + payload retention surfaces specified (memory-only, redacted, bounded, evicted) — was missing from original proposal
- Idempotency in-flight flag added — original proposal had concurrent-real-and-synthetic double-billing edge case
- Token-TTL effectiveness ceiling documented as a structural limit, not a bug
- TTL detection corrected to pure Node (original referenced `cache_analysis.py` from claude-code-meter)
- `extensions.json` canonical / env vars override-only / explicit precedence — was ambiguous
- `/coffee` migration story explicit — was implicit
- Status endpoint elevated to v3.7.0 scope (originally deferred) and pinned to `/v1/warmer/status` — debuggability win
- Payload cap default raised from 2 MB → 8 MB — 2 MB would have silently excluded the target audience
- Token TTL default raised from 1h → 8h — matches actual Anthropic token lifetimes
- Daily cost cap mechanics specified (per-account, in-memory, UTC midnight, pause-until-rollover)
- Log-redaction audit pulled into v3.7.0 scope — the warmer creates the urgency for it

— Proxy Builder (directive author)
— AI Team Lead (original proposal in #127)
