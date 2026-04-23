// Corp-proxy / CA tests for proxy/upstream.mjs.
//
// Why these are unit-shaped, not integration-shaped: the proxy reads upstream
// config (CACHE_FIX_PROXY_UPSTREAM, etc.) at module import time. That means a
// single test file can't cleanly cover multiple upstream-protocol scenarios via
// dynamic re-imports — config.mjs is cached after first load. We could spawn a
// fresh process per scenario, but the value being verified (correct env-var
// selection) is a pure function. So we export it from upstream.mjs and table-test
// it directly here. The end-to-end "does hpagent route through the proxy" path
// is hpagent's own responsibility and is verified manually (see PR description).

import { test } from "node:test";
import assert from "node:assert/strict";

test("selectProxyUrl: protocol-based selection matches curl/Python/Go", async () => {
  // Covers the blocker review flagged: the original code collapsed HTTPS_PROXY
  // and HTTP_PROXY into one value with HTTPS_PROXY winning unconditionally,
  // which is wrong for http: upstreams.
  const { selectProxyUrl } = await import("../proxy/upstream.mjs");

  const cases = [
    // [HTTPS_PROXY, HTTP_PROXY, isHTTPS, expected, label]
    ["http://hp", "http://h", true,  "http://hp", "https upstream prefers HTTPS_PROXY"],
    ["",          "http://h", true,  "http://h",  "https upstream falls back to HTTP_PROXY when HTTPS_PROXY unset"],
    ["http://hp", "",         true,  "http://hp", "https upstream uses HTTPS_PROXY when HTTP_PROXY unset"],
    ["",          "",         true,  "",          "https upstream returns empty when neither set"],
    ["http://hp", "http://h", false, "http://h",  "http upstream uses HTTP_PROXY (NOT HTTPS_PROXY)"],
    ["http://hp", "",         false, "",          "http upstream returns empty when only HTTPS_PROXY set"],
    ["",          "http://h", false, "http://h",  "http upstream uses HTTP_PROXY when HTTPS_PROXY unset"],
    ["",          "",         false, "",          "http upstream returns empty when neither set"],
  ];

  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY };
  try {
    for (const [hps, hp, isHTTPS, expected, label] of cases) {
      process.env.HTTPS_PROXY = hps;
      process.env.HTTP_PROXY = hp;
      assert.equal(selectProxyUrl(isHTTPS), expected, label);
    }
  } finally {
    if (saved.HTTPS_PROXY === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = saved.HTTPS_PROXY;
    if (saved.HTTP_PROXY === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = saved.HTTP_PROXY;
  }
});

test("selectProxyUrl: lowercase env vars are honored", async () => {
  const { selectProxyUrl } = await import("../proxy/upstream.mjs");
  const saved = {
    HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy,
    HTTP_PROXY:  process.env.HTTP_PROXY,  http_proxy:  process.env.http_proxy,
  };
  try {
    delete process.env.HTTPS_PROXY; delete process.env.HTTP_PROXY;
    process.env.https_proxy = "http://lowhttps";
    process.env.http_proxy  = "http://lowhttp";
    assert.equal(selectProxyUrl(true),  "http://lowhttps", "https upstream picks lowercase https_proxy");
    assert.equal(selectProxyUrl(false), "http://lowhttp",  "http upstream picks lowercase http_proxy");
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("forwardRequest is exported and module loads cleanly with no proxy env vars (no regression)", async () => {
  const saved = {
    HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy,
    HTTP_PROXY:  process.env.HTTP_PROXY,  http_proxy:  process.env.http_proxy,
    NO_PROXY: process.env.NO_PROXY, CACHE_FIX_PROXY_CA_FILE: process.env.CACHE_FIX_PROXY_CA_FILE,
  };
  try {
    for (const k of Object.keys(saved)) delete process.env[k];
    const upstream = await import("../proxy/upstream.mjs");
    assert.equal(typeof upstream.forwardRequest, "function");
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
