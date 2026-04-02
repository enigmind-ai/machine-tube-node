import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const mtNodeEntry = path.join(repoRoot, "src", "index.ts");
const bootstrapEntry = path.join(repoRoot, "scripts", "bootstrap-media-tools.mjs");

function runOrThrow(command: string, args: string[], options: Parameters<typeof spawnSync>[2] = {}) {
  const result = spawnSync(command, args, {
    stdio: "pipe",
    encoding: "utf8",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "";
    throw new Error(`${command} ${args.join(" ")} failed${stderr ? `: ${stderr}` : "."}`);
  }
}

async function waitFor(url: string, timeoutMs: number) {
  const startedAt = Date.now();
  let lastError = "unknown";

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
        return;
      }
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

async function waitForJsonCondition(
  url: string,
  predicate: (body: any) => boolean,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  let lastBody: any = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastBody = await fetchJson(url);
      if (predicate(lastBody)) {
        return lastBody;
      }
    } catch {
      // ignore until timeout
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for condition on ${url}: ${JSON.stringify(lastBody)}`);
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const raw = await response.text();
  const body = raw ? JSON.parse(raw) : null;
  if (!response.ok) {
    throw new Error(`Request to ${url} failed: ${response.status} ${response.statusText} ${raw}`);
  }
  return body;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve listening port.");
  }

  return address.port;
}

test("mt-node tracks per-video origin traffic for raw, range, and HLS playback and supports reset", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mt-node-origin-traffic-"));
  const dataDir = path.join(tempRoot, "data");
  const samplePath = path.join(tempRoot, "sample.mp4");
  const ffmpegPath = path.join(dataDir, "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

  const machineTubeServer = http.createServer((_, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found." }));
  });

  let mtNode: ReturnType<typeof spawn> | null = null;

  try {
    await listen(machineTubeServer);

    runOrThrow("node", [bootstrapEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MT_NODE_DATA_DIR: dataDir,
      },
    });

    runOrThrow(ffmpegPath, [
      "-hide_banner",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x180:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440",
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      samplePath,
    ]);

    mtNode = spawn("node", ["--import", "tsx", mtNodeEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MT_NODE_HOST: "127.0.0.1",
        MT_NODE_PORT: "0",
        MT_NODE_DATA_DIR: dataDir,
        MT_NODE_PUBLIC_BASE_URL: "https://origin.example.test",
        MT_NODE_PEER_DELIVERY_MODE: "permanent",
        MT_NODE_SYNC_INTERVAL_MS: "3600000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    mtNode.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    await waitFor("http://127.0.0.1:0/healthz", 1000).catch(() => undefined);

    let port = 0;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15000) {
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (match) {
        port = Number.parseInt(match[1], 10);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.ok(port > 0, `mt-node did not report a listening port. Output: ${stdout}`);
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(`${baseUrl}/healthz`, 15000);

    const publishResponse = await fetchJson(`${baseUrl}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: samplePath,
        title: "Origin traffic sample",
        publishToMachineTube: false,
      }),
    });
    const localVideoId = String(publishResponse.video.id);

    await waitForJsonCondition(
      `${baseUrl}/videos/${encodeURIComponent(localVideoId)}`,
      (body) => body?.video?.outputs?.hls?.playlistUrl,
      15000,
    );

    const beforeDiagnostics = await fetchJson(
      `${baseUrl}/diagnostics/origin-traffic?videoId=${encodeURIComponent(localVideoId)}`
    );
    assert.equal(beforeDiagnostics.originTraffic.videos.length, 1);
    assert.equal(beforeDiagnostics.originTraffic.videos[0].counters.totalRequests, 0);

    const rawResponse = await fetch(`${baseUrl}/media/${encodeURIComponent(localVideoId)}`);
    assert.equal(rawResponse.status, 200);
    const rawBytes = (await rawResponse.arrayBuffer()).byteLength;
    assert.ok(rawBytes > 0);

    const rangeResponse = await fetch(`${baseUrl}/media/${encodeURIComponent(localVideoId)}`, {
      headers: {
        Range: "bytes=0-15",
      },
    });
    assert.equal(rangeResponse.status, 206);
    const rangeBytes = (await rangeResponse.arrayBuffer()).byteLength;
    assert.equal(rangeBytes, 16);

    const playlistResponse = await fetch(`${baseUrl}/media/${encodeURIComponent(localVideoId)}/hls/index.m3u8`);
    assert.equal(playlistResponse.status, 200);
    const playlistBody = await playlistResponse.text();
    const playlistBytes = new TextEncoder().encode(playlistBody).byteLength;
    const firstSegmentPath = playlistBody
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#"));
    assert.ok(firstSegmentPath, `Expected an HLS segment path in playlist: ${playlistBody}`);

    const segmentResponse = await fetch(`${baseUrl}/media/${encodeURIComponent(localVideoId)}/hls/${firstSegmentPath}`);
    assert.equal(segmentResponse.status, 200);
    const segmentBytes = (await segmentResponse.arrayBuffer()).byteLength;
    assert.ok(segmentBytes > 0);

    const diagnostics = await fetchJson(
      `${baseUrl}/diagnostics/origin-traffic?videoId=${encodeURIComponent(localVideoId)}`
    );
    const counters = diagnostics.originTraffic.videos[0].counters;
    assert.equal(counters.totalRequests, 4);
    assert.equal(counters.rangeRequests, 1);
    assert.equal(counters.fullRequests, 3);
    assert.equal(counters.rawRequests, 2);
    assert.equal(counters.rawBytes, rawBytes + rangeBytes);
    assert.equal(counters.hlsPlaylistRequests, 1);
    assert.equal(counters.hlsPlaylistBytes, playlistBytes);
    assert.equal(counters.hlsSegmentRequests, 1);
    assert.equal(counters.hlsSegmentBytes, segmentBytes);
    assert.equal(counters.totalBytes, rawBytes + rangeBytes + playlistBytes + segmentBytes);
    assert.equal(counters.lastAssetKind, "hls-segment");

    const videoPayload = await fetchJson(`${baseUrl}/videos/${encodeURIComponent(localVideoId)}`);
    assert.equal(videoPayload.video.originTraffic.totalRequests, 4);
    assert.equal(videoPayload.video.originTraffic.hlsSegmentRequests, 1);

    const statusPayload = await fetchJson(`${baseUrl}/status`);
    assert.equal(statusPayload.originTraffic.totals.totalRequests, 4);
    assert.equal(statusPayload.originTraffic.totals.rawRequests, 2);

    const originHealthPayload = await fetchJson(`${baseUrl}/origin-health`);
    assert.equal(originHealthPayload.originHealth.videos[0].originTraffic.totalRequests, 4);
    assert.equal(originHealthPayload.originHealth.videos[0].originTraffic.hlsPlaylistRequests, 1);

    const resetResponse = await fetchJson(
      `${baseUrl}/diagnostics/origin-traffic/reset?videoId=${encodeURIComponent(localVideoId)}`,
      { method: "POST" }
    );
    assert.equal(resetResponse.resetAll, false);
    assert.equal(resetResponse.reset, 1);

    const afterReset = await fetchJson(
      `${baseUrl}/diagnostics/origin-traffic?videoId=${encodeURIComponent(localVideoId)}`
    );
    assert.equal(afterReset.originTraffic.videos[0].counters.totalRequests, 0);
    assert.equal(afterReset.originTraffic.videos[0].counters.totalBytes, 0);
  } finally {
    mtNode?.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => mtNode?.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    await new Promise((resolve) => machineTubeServer.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  }
});
