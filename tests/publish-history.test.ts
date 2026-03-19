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

test("tracks publish history when the same file is published to MachineTube multiple times", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mt-node-publish-history-"));
  const dataDir = path.join(tempRoot, "data");
  const samplePath = path.join(tempRoot, "sample.mp4");
  const ffmpegPath = path.join(dataDir, "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

  const publishRequests: Array<{ title: string; videoId: string }> = [];
  let publishCounter = 0;

  const machineTubeServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "POST" && url.pathname === "/api/videos") {
      let rawBody = "";
      for await (const chunk of req) {
        rawBody += chunk.toString();
      }
      const body = JSON.parse(rawBody) as { title?: string };
      publishCounter += 1;
      const videoId = `vid_test_publish_${publishCounter}`;
      publishRequests.push({ title: body.title ?? "", videoId });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ videoId, status: "published", watchUrl: `http://127.0.0.1/watch/${videoId}` }));
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
        MT_NODE_SYNC_INTERVAL_MS: "3600000",
        MT_MACHINETUBE_BASE_URL: `http://127.0.0.1:${machineTubePort}`,
        MT_MACHINETUBE_AGENT_ID: "agt_test_publish_history",
        MT_MACHINETUBE_API_KEY: "mt_test_key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    mtNode.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    await waitFor(`${baseUrl}/healthz`, 15000);

    const firstPublish = await fetchJson(`${baseUrl}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: samplePath,
        title: "Publish history sample",
      }),
    });
    const secondPublish = await fetchJson(`${baseUrl}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: samplePath,
        title: "Publish history sample",
      }),
    });

    const statusPayload = await fetchJson(`${baseUrl}/status`);
    const videosPayload = await fetchJson(`${baseUrl}/videos`);

    assert.equal(firstPublish.machineTube.videoId, "vid_test_publish_1");
    assert.equal(secondPublish.machineTube.videoId, "vid_test_publish_2");
    assert.equal(statusPayload.videoCount, 1);
    assert.equal(statusPayload.publishedVideoCount, 2);
    assert.equal(statusPayload.heartbeat.publishedVideos.length, 2);
    assert.deepEqual(
      statusPayload.heartbeat.publishedVideos.map((entry: { machineTubeVideoId: string }) => entry.machineTubeVideoId),
      ["vid_test_publish_1", "vid_test_publish_2"]
    );

    assert.equal(videosPayload.videos.length, 1);
    assert.equal(videosPayload.videos[0].machineTube.videoId, "vid_test_publish_2");
    assert.equal(videosPayload.videos[0].machineTube.publishHistory.length, 2);
    assert.deepEqual(
      videosPayload.videos[0].machineTube.publishHistory.map((entry: { videoId: string }) => entry.videoId),
      ["vid_test_publish_1", "vid_test_publish_2"]
    );
    assert.equal(publishRequests.length, 2);
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
