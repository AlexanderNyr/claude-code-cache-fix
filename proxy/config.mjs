import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const config = {
  port: envInt("CACHE_FIX_PROXY_PORT", 9801),
  bind: process.env.CACHE_FIX_PROXY_BIND || "127.0.0.1",
  upstream: process.env.CACHE_FIX_PROXY_UPSTREAM || "https://api.anthropic.com",
  timeout: envInt("CACHE_FIX_PROXY_TIMEOUT", 600_000),
  extensionsDir: process.env.CACHE_FIX_EXTENSIONS_DIR || join(__dirname, "extensions"),
  extensionsConfig: process.env.CACHE_FIX_EXTENSIONS_CONFIG || join(__dirname, "extensions.json"),
  debug: process.env.CACHE_FIX_DEBUG === "1",
  httpProxy:       process.env.HTTPS_PROXY || process.env.https_proxy ||
                   process.env.HTTP_PROXY  || process.env.http_proxy  || "",
  noProxy:         process.env.NO_PROXY    || process.env.no_proxy    || "",
  caFile:          process.env.CACHE_FIX_PROXY_CA_FILE || "",
  rejectUnauthorized: envFlag("CACHE_FIX_PROXY_REJECT_UNAUTHORIZED", true),
};

export default config;
