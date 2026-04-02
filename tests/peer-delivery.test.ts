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
    const s = result.stderr;
    const stderr =
      s == null ? "" : typeof s === "string" ? s.trim() : Buffer.from(s).toString("utf8").trim();
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

async function reservePort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("mt-node publish exposes peer-assisted delivery metadata to MachineTube and status endpoints", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mt-node-peer-delivery-"));
  const dataDir = path.join(tempRoot, "data");
  const samplePath = path.join(tempRoot, "sample.mp4");
  const ffmpegPath = path.join(dataDir, "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

  const publishRequests: Array<Record<string, unknown>> = [];

  const machineTubeServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "POST" && url.pathname === "/api/videos") {
      let rawBody = "";
      for await (const chunk of req) {
        rawBody += chunk.toString();
      }

      publishRequests.push(JSON.parse(rawBody) as Record<string, unknown>);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ videoId: "vid_peer_delivery", status: "published", watchUrl: "http://127.0.0.1/watch/vid_peer_delivery" }));
      return;
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/videos/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found." }));
  });

  let mtNode: ReturnType<typeof spawn> | null = null;

  try {
    const machineTubePort = await listen(machineTubeServer);
    const mtNodePort = await reservePort();
    const baseUrl = `http://127.0.0.1:${mtNodePort}`;

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
        MT_NODE_PORT: String(mtNodePort),
        MT_NODE_DATA_DIR: dataDir,
        MT_NODE_PUBLIC_BASE_URL: "https://origin.example.test",
        MT_NODE_PEER_DELIVERY_MODE: "permanent",
        MT_NODE_SYNC_INTERVAL_MS: "3600000",
        MT_MACHINETUBE_BASE_URL: `http://127.0.0.1:${machineTubePort}`,
        MT_MACHINETUBE_AGENT_ID: "agt_peer_delivery",
        MT_MACHINETUBE_API_KEY: "mt_test_key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    mtNode.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    await waitFor(`${baseUrl}/healthz`, 15000);

    const publishResponse = await fetchJson(`${baseUrl}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: samplePath,
        title: "Peer delivery sample",
      }),
    });
    const statusPayload = await fetchJson(`${baseUrl}/status`);
    const videosPayload = await fetchJson(`${baseUrl}/videos`);
    const localVideoId = String(publishResponse.video.id);

    assert.equal(publishRequests.length, 1);
    assert.equal(publishRequests[0].deliveryMode, "external");
    assert.equal(publishRequests[0].externalPlaybackUrl, `https://origin.example.test/media/${localVideoId}`);
    assert.equal(publishRequests[0].externalPlaybackHlsUrl, `https://origin.example.test/media/${localVideoId}/hls/index.m3u8`);
    assert.match(String(publishRequests[0].externalPlaybackMagnetUrl ?? ""), /^magnet:\?/);
    assert.match(String(publishRequests[0].externalPlaybackMagnetUrl ?? ""), /xt=urn%3Abtih%3A/i);
    assert.match(
      String(publishRequests[0].externalPlaybackMagnetUrl ?? ""),
      new RegExp(`ws=https%3A%2F%2Forigin\\.example\\.test%2Fmedia%2F${localVideoId}`)
    );

    assert.match(String(publishResponse.externalPlaybackMagnetUrl ?? ""), /^magnet:\?/);
    assert.equal(videosPayload.videos.length, 1);
    assert.equal(videosPayload.videos[0].outputs.torrent.status, "seeding");
    assert.match(String(videosPayload.videos[0].outputs.torrent.infoHash ?? ""), /^[a-f0-9]{40}$/);
    assert.equal(videosPayload.videos[0].outputs.torrent.browserPeerCompatible, true);
    assert.equal(videosPayload.videos[0].peerDelivery.available, true);
    assert.equal(
      videosPayload.videos[0].torrentMagnetUrl,
      publishRequests[0].externalPlaybackMagnetUrl
    );

    assert.equal(statusPayload.peerDelivery.mode, "permanent");
    assert.equal(statusPayload.peerDelivery.status, "available");
    assert.equal(statusPayload.peerDelivery.browserPeerCompatible, true);
    assert.equal(statusPayload.peerDelivery.hasBrowserCompatibleTrackers, true);
    assert.equal(statusPayload.heartbeat.publishedVideos.length, 1);
    assert.equal(
      statusPayload.heartbeat.publishedVideos[0].torrentMagnetUrl,
      publishRequests[0].externalPlaybackMagnetUrl
    );
    assert.equal(statusPayload.heartbeat.publishedVideos[0].peerDelivery.available, true);
    assert.equal(stderr.trim(), "");
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

test("permanent peer delivery restores published torrent seeds after mt-node restart", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mt-node-peer-restore-"));
  const dataDir = path.join(tempRoot, "data");
  const samplePath = path.join(tempRoot, "sample.mp4");
  const ffmpegPath = path.join(dataDir, "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

  let publishCount = 0;
  const machineTubeServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "POST" && url.pathname === "/api/videos") {
      publishCount += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ videoId: "vid_restore_test", status: "published", watchUrl: "http://127.0.0.1/watch/vid_restore_test" }));
      return;
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/videos/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found." }));
  });

  const spawnNode = (port: number) =>
    spawn("node", ["--import", "tsx", mtNodeEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MT_NODE_HOST: "127.0.0.1",
        MT_NODE_PORT: String(port),
        MT_NODE_DATA_DIR: dataDir,
        MT_NODE_PUBLIC_BASE_URL: "https://origin.example.test",
        MT_NODE_PEER_DELIVERY_MODE: "permanent",
        MT_NODE_SYNC_INTERVAL_MS: "3600000",
        MT_MACHINETUBE_BASE_URL: `http://127.0.0.1:${machineTubePort}`,
        MT_MACHINETUBE_AGENT_ID: "agt_peer_restore",
        MT_MACHINETUBE_API_KEY: "mt_test_key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

  let machineTubePort = 0;
  let mtNodePort = 0;
  let mtNode: ReturnType<typeof spawn> | null = null;

  try {
    machineTubePort = await listen(machineTubeServer);
    mtNodePort = await reservePort();

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

    mtNode = spawnNode(mtNodePort);
    await waitFor(`http://127.0.0.1:${mtNodePort}/healthz`, 15000);

    const publishResponse = await fetchJson(`http://127.0.0.1:${mtNodePort}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: samplePath,
        title: "Persistent peer delivery sample",
      }),
    });
    const firstVideos = await fetchJson(`http://127.0.0.1:${mtNodePort}/videos`);

    assert.equal(publishCount, 1);
    assert.equal(firstVideos.videos[0].outputs.torrent.status, "seeding");
    assert.equal(firstVideos.videos[0].machineTube.videoId, "vid_restore_test");

    mtNode.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => mtNode?.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);

    mtNode = spawnNode(mtNodePort);
    await waitFor(`http://127.0.0.1:${mtNodePort}/healthz`, 15000);
    const restoredVideos = await waitForJsonCondition(
      `http://127.0.0.1:${mtNodePort}/videos`,
      (body) => body?.videos?.[0]?.outputs?.torrent?.status === "seeding",
      15000,
    );
    const restoredStatus = await fetchJson(`http://127.0.0.1:${mtNodePort}/status`);

    assert.equal(publishCount, 1);
    assert.equal(restoredVideos.videos[0].machineTube.videoId, "vid_restore_test");
    assert.equal(restoredVideos.videos[0].peerDelivery.available, true);
    assert.equal(restoredVideos.videos[0].outputs.torrent.lastSeedSuccessAt !== null, true);
    assert.equal(restoredStatus.peerDelivery.mode, "permanent");
    assert.equal(restoredStatus.peerDelivery.activeSeedCount, 1);
    assert.equal(String(publishResponse.machineTube.videoId), "vid_restore_test");
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

test("assist peer delivery: MachineTube origin sync does not start extra torrent seeds beyond the active cap", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mt-node-assist-sync-cap-"));
  const dataDir = path.join(tempRoot, "data");
  const samplePathA = path.join(tempRoot, "sample-a.mp4");
  const samplePathB = path.join(tempRoot, "sample-b.mp4");
  const ffmpegPath = path.join(dataDir, "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

  let publishCount = 0;
  const machineTubeServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "POST" && url.pathname === "/api/videos") {
      publishCount += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          videoId: `vid_assist_cap_${publishCount}`,
          status: "published",
          watchUrl: `http://127.0.0.1/watch/vid_assist_cap_${publishCount}`,
        }),
      );
      return;
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/videos/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found." }));
  });

  let mtNode: ReturnType<typeof spawn> | null = null;

  try {
    const machineTubePort = await listen(machineTubeServer);
    const mtNodePort = await reservePort();
    const baseUrl = `http://127.0.0.1:${mtNodePort}`;

    runOrThrow("node", [bootstrapEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MT_NODE_DATA_DIR: dataDir,
      },
    });

    const makeSample = (target: string) =>
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
        target,
      ]);

    makeSample(samplePathA);
    makeSample(samplePathB);

    mtNode = spawn("node", ["--import", "tsx", mtNodeEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MT_NODE_HOST: "127.0.0.1",
        MT_NODE_PORT: String(mtNodePort),
        MT_NODE_DATA_DIR: dataDir,
        MT_NODE_PUBLIC_BASE_URL: "https://origin.example.test",
        MT_NODE_PEER_DELIVERY_MODE: "assist",
        MT_NODE_PEER_DELIVERY_MAX_ACTIVE_TORRENTS: "1",
        MT_NODE_SYNC_INTERVAL_MS: "400",
        MT_MACHINETUBE_BASE_URL: `http://127.0.0.1:${machineTubePort}`,
        MT_MACHINETUBE_AGENT_ID: "agt_assist_sync_cap",
        MT_MACHINETUBE_API_KEY: "mt_test_key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    mtNode.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    await waitFor(`${baseUrl}/healthz`, 15000);

    await fetchJson(`${baseUrl}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: samplePathA,
        title: "Assist cap sample A",
      }),
    });
    await fetchJson(`${baseUrl}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: samplePathB,
        title: "Assist cap sample B",
      }),
    });

    await new Promise((r) => setTimeout(r, 2500));

    const statusPayload = await fetchJson(`${baseUrl}/status`);
    assert.equal(statusPayload.peerDelivery.mode, "assist");
    assert.equal(
      statusPayload.peerDelivery.maxActiveTorrents,
      1,
      "expected max active torrents cap from env",
    );
    assert.ok(
      statusPayload.peerDelivery.activeSeedCount <= 1,
      `sync loop must not raise activeSeedCount above cap (got ${statusPayload.peerDelivery.activeSeedCount})`,
    );
    assert.equal(stderr.trim(), "");
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

test("/videos/register keeps new video eligible for tunnel reseed (schedules reseed after registration)", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mt-node-register-reseed-"));
  const dataDir = path.join(tempRoot, "data");
  const samplePath = path.join(tempRoot, "register-sample.mp4");
  const ffmpegPath = path.join(dataDir, "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const publicOrigin = "https://register-reseed-origin.test";
  let mtNode: ReturnType<typeof spawn> | null = null;

  try {
    runOrThrow("node", [bootstrapEntry], {
      cwd: repoRoot,
      env: { ...process.env, MT_NODE_DATA_DIR: dataDir },
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

    const mtNodePort = await reservePort();
    const baseUrl = `http://127.0.0.1:${mtNodePort}`;

    mtNode = spawn("node", ["--import", "tsx", mtNodeEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MT_NODE_HOST: "127.0.0.1",
        MT_NODE_PORT: String(mtNodePort),
        MT_NODE_DATA_DIR: dataDir,
        MT_NODE_PUBLIC_BASE_URL: publicOrigin,
        MT_NODE_PEER_DELIVERY_MODE: "assist",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitFor(`${baseUrl}/healthz`, 15000);

    await fetchJson(`${baseUrl}/videos/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: samplePath }),
    });

    const list = await waitForJsonCondition(
      `${baseUrl}/videos`,
      (body: { videos: Array<{ torrentMagnetUrl?: string }> }) =>
        Array.isArray(body.videos) &&
        body.videos.length > 0 &&
        typeof body.videos[0].torrentMagnetUrl === "string" &&
        body.videos[0].torrentMagnetUrl!.includes(new URL(publicOrigin).host),
      15000,
    );

    const magnet = list.videos[0].torrentMagnetUrl as string;
    assert.ok(
      magnet.includes("register-reseed-origin.test"),
      "magnet should reference the configured public origin after register + reseed",
    );
  } finally {
    mtNode?.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => mtNode?.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    await rm(tempRoot, { recursive: true, force: true });
  }
});
