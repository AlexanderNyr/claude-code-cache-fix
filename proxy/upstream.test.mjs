import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// IMPORTANT: env vars must be set BEFORE importing config / upstream because
// config is read at module load. Reset modules between tests via a child process
// in real CI; for this single-file demo we set up before each import.

function runWithEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return fn().finally(() => {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

// Reusable: spin up a tiny HTTP "fake corp proxy" that just records the
// CONNECT or absolute-URL it receives, then closes the socket.
function startFakeHttpProxy() {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push({ method: req.method, url: req.url, host: req.headers.host });
      res.statusCode = 502;
      res.end("fake proxy intercept");
    });
    server.on("connect", (req, socket) => {
      hits.push({ method: "CONNECT", url: req.url, host: req.headers.host });
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ port, hits, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test("forwardRequest routes through HTTPS_PROXY when set", async () => {
  const fake = await startFakeHttpProxy();
  try {
    await runWithEnv(
      { HTTPS_PROXY: `http://127.0.0.1:${fake.port}`, NO_PROXY: "" },
      async () => {
        // Fresh import to pick up env-driven config.
        const { forwardRequest } = await import(`./upstream.mjs?bust=${Date.now()}`);
        const fakeClientReq = {
          url: "/v1/messages",
          method: "POST",
          headers: { "content-type": "application/json", "x-test": "1" },
        };
        const body = Buffer.from('{"model":"x","messages":[]}');
        await forwardRequest(fakeClientReq, body, null).catch(() => {}); // expect failure (502)
      }
    );
    assert.ok(fake.hits.length > 0, "fake proxy should have received a CONNECT or request");
    const first = fake.hits[0];
    // For HTTPS upstream, an HTTP proxy receives a CONNECT to host:443.
    assert.equal(first.method, "CONNECT");
    assert.match(first.url, /^api\.anthropic\.com:443$/);
  } finally {
    await fake.close();
  }
});

test("forwardRequest bypasses proxy when host is in NO_PROXY", async () => {
  const fake = await startFakeHttpProxy();
  try {
    await runWithEnv(
      {
        HTTPS_PROXY: `http://127.0.0.1:${fake.port}`,
        NO_PROXY: "api.anthropic.com",
      },
      async () => {
        const { forwardRequest } = await import(`./upstream.mjs?bust=${Date.now()}`);
        await forwardRequest(
          { url: "/v1/messages", method: "POST", headers: {} },
          Buffer.from("{}"),
          null
        ).catch(() => {});
      }
    );
    assert.equal(fake.hits.length, 0, "fake proxy should NOT have been hit when NO_PROXY matches");
  } finally {
    await fake.close();
  }
});

test("forwardRequest with no proxy env vars uses default agent (no regression)", async () => {
  await runWithEnv(
    {
      HTTPS_PROXY: "",
      HTTP_PROXY: "",
      https_proxy: "",
      http_proxy: "",
      NO_PROXY: "",
      CACHE_FIX_PROXY_CA_FILE: "",
    },
    async () => {
      const upstream = await import(`./upstream.mjs?bust=${Date.now()}`);
      // Smoke: just verify the module exports and the function doesn't throw at import time.
      assert.equal(typeof upstream.forwardRequest, "function");
    }
  );
});
