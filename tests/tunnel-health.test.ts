import assert from "node:assert/strict";
import test from "node:test";
import { getHealthyTunnelSnapshot, probePublicTunnelHeartbeat } from "../src/tunnel-health.js";

test("restarts a cloudflared tunnel when the public heartbeat probe fails", async () => {
  const initialTunnel = {
    publicBaseUrl: "https://stale.trycloudflare.com",
    source: "cloudflared" as const,
  };
  const restartedTunnel = {
    publicBaseUrl: "https://fresh.trycloudflare.com",
    source: "cloudflared" as const,
  };

  const probedUrls: string[] = [];
  const warnings: string[] = [];
  const restartReasons: string[] = [];

  const tunnel = await getHealthyTunnelSnapshot({
    ensureStarted: async () => initialTunnel,
    restart: async (reason) => {
      restartReasons.push(reason);
      return restartedTunnel;
    },
    probeHeartbeat: async (url) => {
      probedUrls.push(url);
      return { ok: false, reason: "fetch failed" };
    },
    now: () => 12345,
    logWarn: (message) => warnings.push(message),
  });

  assert.deepEqual(tunnel, restartedTunnel);
  assert.deepEqual(probedUrls, ["https://stale.trycloudflare.com/heartbeat?probe=12345"]);
  assert.deepEqual(restartReasons, ["public heartbeat probe failed: fetch failed"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /stale\.trycloudflare\.com/);
});

test("skips restart when the tunnel probe succeeds", async () => {
  const initialTunnel = {
    publicBaseUrl: "https://healthy.trycloudflare.com",
    source: "cloudflared" as const,
  };

  let restarted = false;

  const tunnel = await getHealthyTunnelSnapshot({
    ensureStarted: async () => initialTunnel,
    restart: async () => {
      restarted = true;
      return initialTunnel;
    },
    probeHeartbeat: async () => ({ ok: true }),
  });

  assert.deepEqual(tunnel, initialTunnel);
  assert.equal(restarted, false);
});

test("skips public probing for non-cloudflared tunnels", async () => {
  const envTunnel = {
    publicBaseUrl: "https://fixed-origin.example.com",
    source: "env" as const,
  };

  let probed = false;
  let restarted = false;

  const tunnel = await getHealthyTunnelSnapshot({
    ensureStarted: async () => envTunnel,
    restart: async () => {
      restarted = true;
      return envTunnel;
    },
    probeHeartbeat: async () => {
      probed = true;
      return { ok: true };
    },
  });

  assert.deepEqual(tunnel, envTunnel);
  assert.equal(probed, false);
  assert.equal(restarted, false);
});

test("reports HTTP failures from the public heartbeat probe", async () => {
  const result = await probePublicTunnelHeartbeat("https://broken.trycloudflare.com/heartbeat", {
    fetchFn: async () =>
      new Response(null, {
        status: 502,
        statusText: "Bad Gateway",
      }),
  });

  assert.deepEqual(result, { ok: false, reason: "heartbeat returned 502 Bad Gateway" });
});

test("reports fetch exceptions from the public heartbeat probe", async () => {
  const result = await probePublicTunnelHeartbeat("https://broken.trycloudflare.com/heartbeat", {
    fetchFn: async () => {
      throw new Error("dns lookup failed");
    },
  });

  assert.deepEqual(result, { ok: false, reason: "dns lookup failed" });
});
