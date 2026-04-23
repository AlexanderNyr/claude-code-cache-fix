import https from "node:https";
import http from "node:http";
import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { HttpProxyAgent, HttpsProxyAgent } from "hpagent";
import config from "./config.mjs";

const STRIP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "upgrade",
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

function shouldStripRequestHeader(name) {
  const lower = name.toLowerCase();
  return STRIP_REQUEST_HEADERS.has(lower) || lower.startsWith("proxy-");
}

function shouldStripResponseHeader(name) {
  return STRIP_RESPONSE_HEADERS.has(name.toLowerCase());
}

function buildUpstreamHeaders(incomingHeaders, upstreamHostname) {
  const headers = {};
  for (const [key, value] of Object.entries(incomingHeaders)) {
    if (shouldStripRequestHeader(key)) continue;
    headers[key] = value;
  }
  headers["host"] = upstreamHostname;
  headers["accept-encoding"] = "identity";
  return headers;
}

function filterResponseHeaders(rawHeaders) {
  const headers = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (shouldStripResponseHeader(key)) continue;
    headers[key] = value;
  }
  return headers;
}

// --- HTTP proxy and custom CA support ---

let _httpsAgent = null;
let _httpAgent  = null;
let _agentInitTried = false;

function shouldBypassProxy(hostname) {
  if (!config.noProxy) return false;
  const list = config.noProxy.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const host = hostname.toLowerCase();
  for (const pattern of list) {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) {
      // ".example.com" matches "foo.example.com" and "example.com"
      const bare = pattern.slice(1);
      if (host === bare || host.endsWith(pattern)) return true;
    } else if (host === pattern || host.endsWith("." + pattern)) {
      return true;
    }
  }
  return false;
}

function loadCa() {
  if (!config.caFile) return undefined;
  try {
    return readFileSync(config.caFile);
  } catch (err) {
    process.stderr.write(`[upstream] CACHE_FIX_PROXY_CA_FILE read failed: ${err.message}\n`);
    return undefined;
  }
}

function getAgent(isHTTPS, hostname) {
  if (!_agentInitTried) {
    _agentInitTried = true;

    // Print one-time warning if TLS verification is disabled
    if (!config.rejectUnauthorized) {
      process.stderr.write(`[upstream] WARNING: TLS verification disabled (CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0). This is insecure!\n`);
    }

    if (config.httpProxy) {
      const ca = loadCa();
      const common = {
        keepAlive: true,
        proxy: config.httpProxy,
        rejectUnauthorized: config.rejectUnauthorized,
        ...(ca ? { ca } : {}),
      };
      _httpsAgent = new HttpsProxyAgent(common);
      _httpAgent  = new HttpProxyAgent(common);
      process.stderr.write(`[upstream] using proxy ${config.httpProxy} (rejectUnauthorized=${config.rejectUnauthorized}, ca=${config.caFile || "default"})\n`);
    } else if (config.caFile || !config.rejectUnauthorized) {
      // No HTTP proxy, but custom CA or insecure mode requested: build a plain agent.
      const ca = loadCa();
      _httpsAgent = new https.Agent({
        keepAlive: true,
        rejectUnauthorized: config.rejectUnauthorized,
        ...(ca ? { ca } : {}),
      });
    }
  }
  if (shouldBypassProxy(hostname)) {
    return isHTTPS
      ? new https.Agent({ keepAlive: true, rejectUnauthorized: config.rejectUnauthorized, ca: loadCa() })
      : new http.Agent({ keepAlive: true });
  }
  return isHTTPS ? _httpsAgent : _httpAgent;
}

export function forwardRequest(clientReq, body, signal) {
  return new Promise((resolve, reject) => {
    const upstreamUrl = new URL(clientReq.url, config.upstream);

    const headers = buildUpstreamHeaders(clientReq.headers, upstreamUrl.hostname);
    if (body) {
      headers["content-length"] = Buffer.byteLength(body).toString();
    }

    const isHTTPS = upstreamUrl.protocol === "https:";
    const transport = isHTTPS ? https : http;
    const defaultPort = isHTTPS ? 443 : 80;

    const options = {
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || defaultPort,
      path: upstreamUrl.pathname + upstreamUrl.search,
      method: clientReq.method,
      headers,
      timeout: config.timeout,
      agent: getAgent(isHTTPS, upstreamUrl.hostname),
    };

    const upstreamReq = transport.request(options, (upstreamRes) => {
      const responseHeaders = filterResponseHeaders(upstreamRes.headers);
      resolve({ upstreamRes, responseHeaders, statusCode: upstreamRes.statusCode });
    });

    upstreamReq.on("error", reject);
    upstreamReq.on("timeout", () => {
      upstreamReq.destroy(new Error("Upstream timeout"));
    });

    if (signal) {
      signal.addEventListener("abort", () => {
        upstreamReq.destroy(new Error("Request aborted"));
      }, { once: true });
    }

    if (body) {
      upstreamReq.end(body);
    } else {
      upstreamReq.end();
    }
  });
}
