import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";

// A supervised stop must exit 0 whichever path it takes. server.close() waits
// for in-flight requests, and a live session always has one (the streaming
// /v1/messages response), so the 5s watchdog is the NORMAL exit under systemd.
// It used to exit(1) there, which made `systemctl stop` log status=1/FAILURE —
// a clean stop and a crash became indistinguishable, and Restart=on-failure
// fired on deliberate stops.

function startProxy() {
  const proc = spawn(process.execPath, ["proxy/server.mjs"], {
    env: { ...process.env, CACHE_FIX_PROXY_PORT: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const port = new Promise((resolve, reject) => {
    let out = "";
    proc.stdout.on("data", (c) => {
      out += c.toString();
      const m = out.match(/listening on [\d.]+:(\d+)/);
      if (m) resolve(parseInt(m[1], 10));
    });
    proc.on("exit", (code) => reject(new Error(`Proxy exited ${code}`)));
    setTimeout(() => reject(new Error("Proxy start timeout")), 5000);
  });
  let stderr = "";
  proc.stderr.on("data", (c) => (stderr += c.toString()));
  return { proc, port, stderr: () => stderr };
}

function exitOf(proc) {
  return new Promise((resolve) => {
    proc.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

describe("SIGTERM exit code", () => {
  it("exits 0 when nothing is in flight", async () => {
    const { proc, port } = startProxy();
    await port;
    const exited = exitOf(proc);
    proc.kill("SIGTERM");
    const { code } = await exited;
    assert.equal(code, 0, "clean shutdown must exit 0");
  });

  it("exits 0 via the watchdog when a request is still in flight", async () => {
    const { proc, port, stderr } = startProxy();
    const p = await port;

    // Announce a body we never finish sending: the request stays in flight,
    // so server.close() cannot resolve and the watchdog path is taken.
    const sock = net.createConnection(p, "127.0.0.1");
    await new Promise((resolve) => sock.on("connect", resolve));
    sock.write(
      "POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
        "Content-Length: 5000\r\n\r\npartial",
    );
    await new Promise((r) => setTimeout(r, 300));

    const exited = exitOf(proc);
    const started = Date.now();
    proc.kill("SIGTERM");
    const { code } = await exited;
    const elapsed = Date.now() - started;

    assert.equal(code, 0, "watchdog shutdown must exit 0, not 1");
    assert.ok(
      elapsed >= 4500,
      `expected the 5s watchdog path, exited after ${elapsed}ms`,
    );
    assert.match(
      stderr(),
      /forcing close/,
      "the forced path must stay visible on stderr",
    );
    sock.destroy();
  });
});
