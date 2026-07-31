// Regression coverage for the header-mutation plumbing gap surfaced by the
// deferred-tool-rewrite unit (see that file's header comment, and the prior
// closing report's gap #2): `preForward` (proxy/server.mjs) built
// `reqCtx.headers = { ...clientReq.headers }` for extensions to read/mutate,
// but only `reqCtx.body` was serialized back into the real outbound request
// — header mutations (added, changed, OR deleted keys) never reached
// `forwardRequest`, which still read the ORIGINAL `clientReq.headers`.
//
// This file exercises the fix at the wire level: a real proxy instance,
// through the real extension pipeline, forwarding to a real (local) upstream
// that records exactly what it received. Two cases:
//   1. A synthetic test extension exercising add/change/delete generically.
//   2. auto-1m-guard's existing strip-mode contract, end-to-end — this is
//      the "tighten, don't just re-assert" case: auto-1m-guard.test.mjs
//      already asserted ctx.headers is mutated correctly (not vacuous for
//      what it tests), but nothing previously proved that mutation reached
//      the wire. Before this fix, this exact test would have failed: the
//      upstream would have received the UN-stripped header.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../proxy/server.mjs";

function clientRequest(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/messages",
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

function fakeSseUpstream(onRequest) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      onRequest(req, Buffer.concat(chunks).toString());
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"message_start","message":{"model":"claude-opus-4-20250514","usage":{}}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
}

describe("preForward header propagation (generic add/change/delete via a synthetic extension)", () => {
  let handle, upstream, upstreamPort, extDir, lastUpstreamHeaders;

  before(async () => {
    extDir = await mkdtemp(join(tmpdir(), "header-propagation-ext-"));
    await writeFile(join(extDir, "extensions.json"), JSON.stringify({}));
    // Synthetic extension: adds a new header, changes an existing one, and
    // deletes a third — exercises all three mutation kinds in one pass.
    await writeFile(
      join(extDir, "header-mutator.mjs"),
      `export default {
        name: "header-mutator",
        order: 100,
        onRequest(ctx) {
          ctx.headers["x-added-by-extension"] = "added";
          ctx.headers["x-to-change"] = "changed-value";
          delete ctx.headers["x-to-delete"];
        },
      };`,
    );

    upstream = fakeSseUpstream((req) => {
      lastUpstreamHeaders = req.headers;
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    upstreamPort = upstream.address().port;

    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
    handle = await startProxy({ port: 0, watch: false, extensionsDir: extDir, extensionsConfig: join(extDir, "extensions.json") });
  });

  after(async () => {
    await handle.close();
    await new Promise((r) => upstream.close(r));
    delete process.env.CACHE_FIX_PROXY_UPSTREAM;
    await rm(extDir, { recursive: true, force: true });
  });

  it("an added header reaches the outbound request", async () => {
    await clientRequest(handle.port, { model: "test", messages: [] });
    assert.equal(lastUpstreamHeaders["x-added-by-extension"], "added");
  });

  it("a changed header's new value reaches the outbound request", async () => {
    await clientRequest(handle.port, { model: "test", messages: [] }, { "x-to-change": "original-value" });
    assert.equal(lastUpstreamHeaders["x-to-change"], "changed-value");
  });

  it("a deleted header is ABSENT from the outbound request", async () => {
    await clientRequest(handle.port, { model: "test", messages: [] }, { "x-to-delete": "should-not-survive" });
    assert.equal("x-to-delete" in lastUpstreamHeaders, false);
  });

  it("an untouched header still passes through unchanged (no regression to full-passthrough behavior)", async () => {
    await clientRequest(handle.port, { model: "test", messages: [] }, { "x-untouched": "still-here" });
    assert.equal(lastUpstreamHeaders["x-untouched"], "still-here");
  });
});

describe("preForward header propagation — auto-1m-guard strip mode reaches the wire (tightened, not vacuous)", () => {
  let handle, upstream, upstreamPort, lastUpstreamHeaders;
  const ONEM = "context-1m-2025-08-07";

  before(async () => {
    upstream = fakeSseUpstream((req) => {
      lastUpstreamHeaders = req.headers;
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    upstreamPort = upstream.address().port;

    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
    process.env.CACHE_FIX_AUTO_1M_GUARD = "strip";
    // Real extensionsDir/config (default), so auto-1m-guard runs for real
    // alongside the rest of the always-loaded pipeline.
    handle = await startProxy({ port: 0, watch: false });
  });

  after(async () => {
    await handle.close();
    await new Promise((r) => upstream.close(r));
    delete process.env.CACHE_FIX_PROXY_UPSTREAM;
    delete process.env.CACHE_FIX_AUTO_1M_GUARD;
  });

  it("strip mode: context-1m-2025-08-07 is ABSENT from the outbound anthropic-beta header on the real wire", async () => {
    await clientRequest(
      handle.port,
      { model: "test", messages: [] },
      { "anthropic-beta": `claude-code-20250219, oauth_auth, ${ONEM}, context-management-2025-06-27` },
    );
    const outboundBeta = lastUpstreamHeaders["anthropic-beta"] || "";
    assert.ok(
      !outboundBeta.includes(ONEM),
      `expected ${ONEM} stripped from outbound anthropic-beta, got: ${JSON.stringify(outboundBeta)}`,
    );
    assert.ok(outboundBeta.includes("oauth_auth"), "other beta tokens must survive the strip");
  });
});
