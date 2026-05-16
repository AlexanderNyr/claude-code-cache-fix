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
    if daily token cap reached for the account — skip, log "warming paused until UTC rollover"
    else:
      synthesize warming request from stored payload + minimal user message ("ping"), max_tokens: 1
      send to api.anthropic.com with stored auth header + X-Cache-Fix-Warmer: 1 (stripped before forward)
      log result (cost, latency, cache_read tokens, error) to NDJSON
      increment per-account daily cost counter
      reset timer for S
```

Synthetic requests are tagged with the `X-Cache-Fix-Warmer: 1` header internally, used to exclude them from timer-reset accounting and from any other extension that should ignore warming traffic (notably `usage-log` / claude-meter ingest — synthetic pings must not pollute the telemetry stream). The header is stripped before forwarding upstream.

## Account identity

The warmer's quota-pressure skip and daily token cap are scoped **per Anthropic account**. The canonical account key is the `anthropic-organization-id` header value from Anthropic response headers — the same identity already captured by `proxy/extensions/usage-log.mjs:126` and stored in `~/.claude/quota-status/account.json`'s `all_headers` block. This is Anthropic's own billing/quota identity; the warmer does not introduce a new identity layer.

**Capture rule:** every successful real response that carries an `anthropic-organization-id` header binds that header value to the originating session id. The session→org-id binding is memory-only and follows the same eviction / restart rules as the payload retention surface below.

**Fallback if not yet observed:** sessions for which the proxy has not yet seen an `anthropic-organization-id` response header are **not warmed**. The warmer skips with a log line `warming skipped — account identity not yet observed` and waits for the next real response to bind the session. This costs nothing and matches the "no warming wasted on unattributable sessions" intent.

**Multi-account proxy deployments:** a single proxy may serve multiple Anthropic accounts (different sessions binding to different org-ids). The daily token cap and pause-until-rollover state are keyed on the org-id, so one account's saturation does not affect another account's warming.

## Concurrency / process model

The warmer is **single-process**. All state (per-session payload + auth + in-flight flag, per-account daily token counter, per-account pause-until-rollover state) lives in the proxy process's memory. There is no cross-process coordination protocol.

In current deployments cache-fix-proxy is one process behind systemd. If a future deployment ever runs multiple proxy instances behind a load balancer, those instances would each maintain independent warming state — a single session could be re-primed in only one of them at a time (whichever served its last real request), and the daily token cap is enforced per-instance, not globally. That's an explicit limitation of v0; cross-process coordination is out of scope for v3.7.0.

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
| Daily token cap | 30M tokens per account | Hard ceiling against runaway warming traffic. Token-based for determinism (no model→rate table inside the proxy). |
| Idempotency | per-session in-flight flag | If a real request is in flight, skip the synthetic ping that cycle and reset the timer when the real one completes. |
| Synthetic-request tagging | `X-Cache-Fix-Warmer: 1` header (stripped before forwarding upstream) | Internal accounting; exclude synthetic requests from timer-reset and from claude-meter ingest. |

## Daily token cap mechanics

The cap is denominated in **tokens, not USD**. Token-based capping is deterministic and stays in cache-fix-proxy's lane (move bytes, count tokens) rather than claude-meter's (cost analysis, model→rate tables). Anthropic pricing changes do not silently change the effective cap behavior, and there is no model→rate table to maintain inside the proxy.

- **Scope:** per Anthropic account, keyed by `anthropic-organization-id` (see §Account identity).
- **Counter:** in-memory only, sums `cache_read_input_tokens` reported by Anthropic for each warming ping that successfully reaches upstream. Restart resets to zero — graceful, matches the rest of the state surface.
- **Rollover:** UTC midnight. Aligns with Anthropic's quota window.
- **Saturation behavior:** when an account's running total reaches `warmer_daily_cap_tokens`, pause all warming for that account until next UTC rollover. Single NDJSON line announces the pause (`warming paused — daily token cap reached: <N> tokens`); resume automatically on next interval after rollover.

**Default:** `warmer_daily_cap_tokens = 30000000` (30M tokens/day). At current Anthropic Opus cache-read rates this is approximately a $9–10/day guardrail per account; the README documents the rough USD translation for context and notes that the precise USD value drifts when Anthropic adjusts rates. Power users who want a specific USD ceiling recompute the token cap against current rates and override via config.

## TTL detection

Pure Node, in-extension. Reads `~/.claude/quota-status/sessions/<sessionFilename>.json` per real request and per warming cycle.

**Filename contract:** raw-session-id → filename mapping **must** reuse the existing exported `sessionFilename()` helper from `proxy/extensions/cache-telemetry.mjs:44`. That helper maps `null` / `undefined` / empty / whitespace → `"unknown"`, safe IDs (`/^[A-Za-z0-9_-]{1,128}$/`) → raw passthrough, and unsafe IDs → `"inv-" + sha256(raw)[:16]`. The warmer must NOT do direct path interpolation on raw session ids — that would diverge from the writer's contract on the same edge cases the per-session quota-status directive already locked down.

```js
import { sessionFilename } from "../extensions/cache-telemetry.mjs"; // or shared helper module
// ...
const filename = sessionFilename(rawSid);
const state = JSON.parse(readFileSync(`${QUOTA_DIR}/sessions/${filename}.json`));
```

Tier rule:

```js
if (state.five_hour.pct >= 100 || state.overage_status !== "allowed") {
  return { tier: "5min", interval_minutes: 4, gap_threshold_minutes: 6 };
}
return { tier: "1h", interval_minutes: 50, gap_threshold_minutes: 65 };
```

No dependency on `claude-code-meter`'s `cache_analysis.py`. The detection is small enough to live inline.

(If the implementation feels the `sessionFilename` export living in `cache-telemetry.mjs` is awkward to import from a second extension, the right cleanup is to lift it to a shared helper module — both extensions then import from there. Either way, the contract is single-sourced and edge-cases stay aligned.)

## Restart-priming

Memory-only state + no persistence means the warmer has no snapshots or timers after a proxy restart. Each session must make a fresh real request to re-prime the warmer for that session. This is a property of the design, not a bug — documented in the README so users understand the post-restart no-op-until-fresh-real-request behavior.

## Status endpoint

`GET /v1/warmer/status` — extends the existing versioned URL space the proxy already serves. Returns JSON only, no UI.

```json
{
  "enabled": true,
  "proxy_started_at": "2026-05-16T12:00:00Z",
  "config": {
    "warmer_token_ttl_hours": 8,
    "warmer_payload_cap_mb": 8,
    "warmer_session_eviction_hours": 24,
    "warmer_max_idle_hours": 6,
    "warmer_quota_skip_threshold": 0.80,
    "warmer_daily_cap_tokens": 30000000
  },
  "accounts": [
    {
      "org_id": "1a6869d5-283e-43a3-9ba3-4495ceaa239a",
      "daily_tokens": {
        "spent": 4475000,
        "cap": 30000000,
        "rollover_at": "2026-05-17T00:00:00Z",
        "paused": false
      }
    }
  ],
  "sessions": [
    {
      "session_id": "abc12345",
      "org_id": "1a6869d5-283e-43a3-9ba3-4495ceaa239a",
      "last_real_request_at": "2026-05-16T13:25:01Z",
      "last_warming_ping_at": "2026-05-16T14:15:03Z",
      "last_warming_result": {
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

`proxy_started_at` makes restart-priming visible during debugging — if `now - proxy_started_at` is small and many sessions show `last_real_request_at` as null, the warmer is in the "cold-started, awaiting re-priming" state by design rather than misbehaving.

`accounts` is the per-org-id rollup, present because daily token caps are per-account; sessions point back at their bound org via `org_id`. A session that hasn't yet seen an `anthropic-organization-id` response header has `org_id: null` and is not warmed (see §Account identity).

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
    "warmer_daily_cap_tokens": 30000000
  }
}
```

Env vars supported as override-only: `CACHE_FIX_WARMER_ENABLED`, `CACHE_FIX_WARMER_TOKEN_TTL_HOURS`, `CACHE_FIX_WARMER_PAYLOAD_CAP_MB`, `CACHE_FIX_WARMER_SESSION_EVICTION_HOURS`, `CACHE_FIX_WARMER_MAX_IDLE_HOURS`, `CACHE_FIX_WARMER_QUOTA_SKIP_THRESHOLD`, `CACHE_FIX_WARMER_DAILY_CAP_TOKENS`.

**Precedence:** env var > `extensions.json` > built-in default. README documents this explicitly so anyone overriding by env var knows `extensions.json` is being ignored for those keys.

## Migration / coexistence with `/coffee`

- **Proxy users:** the warmer obsoletes `/coffee`. README recommends users running through cache-fix-proxy disable `/coffee` to avoid double-warming. Side-by-side use is not catastrophic — both fire pings, doubling the keep-alive cost — but is wasteful.
- **Non-proxy users (CC ≤ v2.1.112 preload path):** `/coffee` remains the only option; the warmer is unavailable to them by construction.
- **`/coffee` skill itself:** not auto-deprecated by the warmer landing. Whether to deprecate is a separate decision tracked outside this directive.

## Scope (v3.7.0)

- [ ] `proxy/extensions/cache-warmer.mjs` — extension file with the behavior loop above
- [ ] Default-off; opt-in via `extensions.json`
- [ ] Per-session payload + auth capture from real traffic, with retention specs as documented
- [ ] Session→org-id binding from `anthropic-organization-id` response header; skip-if-not-yet-observed semantics
- [ ] Reuse of `sessionFilename()` (currently at `proxy/extensions/cache-telemetry.mjs:44`, or a lifted shared helper) for raw-session-id → quota-status-filename mapping
- [ ] TTL-tier-aware per-session warming timer (in-Node detection)
- [ ] Per-session in-flight flag (idempotency)
- [ ] Q5h pressure skip (default 80%)
- [ ] Max-idle backoff (default 6h)
- [ ] Daily token cap with documented mechanics (per-account via org-id, in-memory, UTC midnight, pause-until-rollover)
- [ ] Session eviction (default 24h no real traffic)
- [ ] Synthetic-request tagging via `X-Cache-Fix-Warmer: 1` (stripped before forwarding)
- [ ] `usage-log` / claude-meter ingest must skip rows tagged as synthetic warming
- [ ] `GET /v1/warmer/status` endpoint, including `proxy_started_at`, per-account daily-token rollup, and per-session org-id binding
- [ ] NDJSON logging of warming events to existing debug log, with `Authorization` redaction
- [ ] Audit existing logging extensions for `Authorization` redaction
- [ ] README section: opt-in pattern, cost expectations (token cap with approximate USD translation), token-TTL ceiling, restart-priming behavior, `/coffee` coexistence, config precedence, single-process limitation
- [ ] Test coverage: synthesize-warming-request logic (mocked upstream)
- [ ] Test coverage: idempotency flag (in-flight blocks ping)
- [ ] Test coverage: token cap (per-org-id, UTC midnight rollover, pause-until-rollover)
- [ ] Test coverage: org-id binding (not-yet-observed → skip; observation binds; multi-org isolation)
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

The cap is in tokens; USD translations below are approximate, based on current Anthropic Opus cache-read rates, and **drift if Anthropic adjusts pricing**.

Single session at 1h tier with 750k context:
- ~750k `cache_read_input_tokens` per warming ping (≈ $0.23 at current rates)
- Ping every 50 min × 28 hours (assuming 6h idle backoff) = 28 pings/day max ⇒ ~21M tokens/day (≈ $6.40)
- Default 30M-token daily cap stops warming at ~40 pings/day (≈ $9–10 at current rates)
- **Realistic daily token consumption: ~10–22M** (≈ $3–7 at current rates) depending on session activity pattern

Cold rebuild on user's return is ~750k `cache_creation_input_tokens` (≈ $5.67 at current rates). If the user returns to the session 2+ times per day after >1h idle, the warmer pays for itself.

The README is explicit that the warmer is **only economical for high-context, frequently-resumed sessions**. Low-context or rarely-resumed sessions should leave warming off. Power users wanting a precise USD ceiling override `warmer_daily_cap_tokens` against current rates.

## Verification plan

Before tagging v3.7.0:

1. Full test suite green (`npm test`) — pipeline + per-extension + integration
2. Manual smoke: enable warmer in a long-running CC session, observe NDJSON warming-event lines, confirm `cache_read_input_tokens` matches expected context size
3. `GET /v1/warmer/status` returns coherent per-session state
4. Disable `/coffee`, run for 8h with warmer enabled, confirm no double-warming visible in NDJSON
5. Trigger quota pressure (simulated via mocked quota-status file) and verify warming skips with appropriate log line
6. Restart proxy mid-window, confirm warmer goes no-op until next real request per session, then resumes
7. Confirm `/v1/warmer/status` reports `proxy_started_at`, per-account daily-token rollup, and per-session `org_id` bindings; check that sessions without an observed `anthropic-organization-id` show `org_id: null` and are not warmed

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

## Open questions resolved during Codex directive review

Following the directive's first Codex pass (`changes-requested` on PR #128), three more items were nailed down:

- **Account identity key** — pinned to `anthropic-organization-id` from response headers, with skip-until-observed fallback. Captured already by `proxy/extensions/usage-log.mjs:126`; the warmer reuses the same identity. No new identity layer introduced.
- **Session-filename contract** — warmer reuses `sessionFilename()` from `proxy/extensions/cache-telemetry.mjs:44` (or a lifted shared helper) for raw-session-id → quota-status-filename mapping. No direct path interpolation; edge cases (`null`, empty, whitespace, unsafe chars) stay aligned with the writer's contract.
- **Daily cap denomination** — switched from USD to tokens (`warmer_daily_cap_tokens`, default 30M). Deterministic, no model→rate table inside the proxy, no silent cap drift when Anthropic adjusts pricing. README documents approximate USD translation for context.

And two non-blocking suggestions adopted:

- **Single-process design** explicitly called out in a new "Concurrency / process model" section. Cross-process coordination is out of v0 scope; future multi-instance deployments would maintain independent warming state per instance.
- **`proxy_started_at`** added to `/v1/warmer/status` so restart-priming is visible during debugging.

— Proxy Builder (directive author)
— AI Team Lead (original proposal in #127)
