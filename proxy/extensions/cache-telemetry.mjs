import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const QUOTA_PATH = join(homedir(), ".claude", "quota-status.json");

function parseHeaders(headers) {
  const get = (key) => headers[key] || "";
  const num = (key) => parseFloat(get(key)) || 0;

  const q5h_util = num("anthropic-ratelimit-unified-5h-utilization");
  const q7d_util = num("anthropic-ratelimit-unified-7d-utilization");
  const q5h_reset = parseInt(get("anthropic-ratelimit-unified-5h-reset")) || 0;
  const q7d_reset = parseInt(get("anthropic-ratelimit-unified-7d-reset")) || 0;
  const status = get("anthropic-ratelimit-unified-status") || get("anthropic-ratelimit-unified-5h-status");
  const overage_status = get("anthropic-ratelimit-unified-overage-status");
  const overage_util = num("anthropic-ratelimit-unified-overage-utilization");
  const overage_reset = parseInt(get("anthropic-ratelimit-unified-overage-reset")) || 0;
  const fallback_pct = get("anthropic-ratelimit-unified-fallback-percentage");
  const representative = get("anthropic-ratelimit-unified-representative-claim");
  const surpassed = get("anthropic-ratelimit-unified-7d-surpassed-threshold");

  if (!q5h_reset && !q7d_reset) return null;

  const now = new Date();
  const hour = now.getUTCHours();
  const day = now.getUTCDay();
  const peak = day >= 1 && day <= 5 && hour >= 13 && hour < 19;

  const allHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith("anthropic-") || k === "cf-ray" || k === "request-id") {
      allHeaders[k] = v;
    }
  }

  return {
    five_hour: { utilization: q5h_util, pct: Math.round(q5h_util * 100), resets_at: q5h_reset },
    seven_day: { utilization: q7d_util, pct: Math.round(q7d_util * 100), resets_at: q7d_reset },
    status: status || "unknown",
    overage_status: overage_status || "unknown",
    peak_hour: peak,
    all_headers: allHeaders,
  };
}

export default {
  name: "cache-telemetry",
  description: "Extract cache stats from response stream, persist quota state to ~/.claude/quota-status.json",
  order: 600,

  async onResponseStart(ctx) {
    if (!ctx.headers) return;

    const quota = parseHeaders(ctx.headers);
    if (!quota) return;

    ctx.meta._quotaData = quota;
  },

  async onStreamEvent(ctx) {
    const { event, telemetry } = ctx;
    if (!event || !telemetry) return;

    if (event.type === "message_start" && event.message?.usage) {
      const usage = event.message.usage;
      ctx.meta.cacheStats = {
        cacheRead: usage.cache_read_input_tokens || 0,
        cacheCreation: usage.cache_creation_input_tokens || 0,
        inputTokens: usage.input_tokens || 0,
      };
    }

    if (event.type === "message_delta" && event.usage) {
      if (!ctx.meta.cacheStats) ctx.meta.cacheStats = {};
      ctx.meta.cacheStats.outputTokens = event.usage.output_tokens || 0;

      const stats = ctx.meta.cacheStats;
      const quota = ctx.meta._quotaData;
      if (!quota) return;

      const cr = stats.cacheRead || 0;
      const cc = stats.cacheCreation || 0;
      const total = cr + cc;
      const hitRate = total > 0 ? ((cr / total) * 100).toFixed(1) : "N/A";

      const ephemeral1h = cc;
      const ephemeral5m = 0;

      const ttl = cr > 0 ? "1h" : (cc > 0 ? "5m" : "unknown");

      const output = {
        cache: {
          ttl_tier: ttl,
          cache_creation: cc,
          cache_read: cr,
          ephemeral_1h: ephemeral1h,
          ephemeral_5m: ephemeral5m,
          hit_rate: hitRate,
          timestamp: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
        ...quota,
      };

      try {
        mkdirSync(join(homedir(), ".claude"), { recursive: true });
        writeFileSync(QUOTA_PATH, JSON.stringify(output, null, 2));
      } catch {}
    }
  },
};
