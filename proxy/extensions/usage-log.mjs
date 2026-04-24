import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_PATH = process.env.CACHE_FIX_USAGE_LOG || join(homedir(), ".claude", "usage.jsonl");

function buildRecord(meta, telemetry, responseHeaders) {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcDay = now.getUTCDay();

  const stats = meta.cacheStats || {};
  const quota = meta._quotaData || {};

  return {
    timestamp: now.toISOString(),
    model: telemetry.model || "unknown",
    input_tokens: stats.inputTokens || 0,
    output_tokens: stats.outputTokens || 0,
    cache_read_input_tokens: stats.cacheRead || 0,
    cache_creation_input_tokens: stats.cacheCreation || 0,
    q5h_pct: quota.five_hour ? quota.five_hour.pct : null,
    q7d_pct: quota.seven_day ? quota.seven_day.pct : null,
    peak_hour: utcDay >= 1 && utcDay <= 5 && utcHour >= 13 && utcHour < 19,
  };
}

export { buildRecord, LOG_PATH };

export default {
  name: "usage-log",
  description: "Append per-call usage record to ~/.claude/usage.jsonl",
  enabled: false,
  order: 650,

  async onStreamEvent(ctx) {
    if (!ctx.event || ctx.event.type !== "message_delta" || !ctx.event.usage) return;

    const record = buildRecord(ctx.meta, ctx.telemetry || {}, ctx.responseHeaders);

    try {
      await mkdir(join(homedir(), ".claude"), { recursive: true });
      await appendFile(LOG_PATH, JSON.stringify(record) + "\n");
    } catch {}
  },
};
