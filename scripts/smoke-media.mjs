#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const distEntry = path.join(repoRoot, "dist", "index.js");

function runOrThrow(command, args, options = {}) {
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

  return result;
}

async function waitFor(url, timeoutMs) {
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

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const raw = await response.text();
  const body = raw ? JSON.parse(raw) : null;
  if (!response.ok) {
    throw new Error(`Request to ${url} failed: ${response.status} ${response.statusText} ${raw}`);
  }
  return body;
}

async function main() {
  runOrThrow("node", ["--version"]);

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mt-node-smoke-"));
  const dataDir = path.join(tempRoot, "data");
  const samplePath = path.join(tempRoot, "sample.mp4");
  const port = "43119";
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log("Starting mt-node with built-in thumbnail and HLS generation...");
  const server = spawn("node", [distEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MT_NODE_HOST: "127.0.0.1",
      MT_NODE_PORT: port,
      MT_NODE_TUNNEL_MODE: "off",
      MT_NODE_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  server.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await waitFor(`${baseUrl}/healthz`, 15000);

    const bootstrapPayload = await fetchJson(`${baseUrl}/bootstrap/ffmpeg`, {
      method: "POST",
    });
    const ffmpegPath = bootstrapPayload?.mediaTools?.ffmpegPath;
    if (typeof ffmpegPath !== "string" || ffmpegPath.length === 0) {
      throw new Error(`Unexpected FFmpeg bootstrap payload: ${JSON.stringify(bootstrapPayload, null, 2)}`);
    }

    console.log("Generating sample MP4 with managed ffmpeg...");
    runOrThrow(ffmpegPath, [
      "-hide_banner",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=640x360:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000",
      "-t",
      "3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      samplePath,
    ]);

    const registerPayload = await fetchJson(`${baseUrl}/videos/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: samplePath }),
    });

    const video = registerPayload?.video;
    if (!video?.id || !video?.thumbnailUrl || !video?.hlsPlaybackUrl || !video?.playbackUrl) {
      throw new Error(`Unexpected register payload: ${JSON.stringify(registerPayload, null, 2)}`);
    }

    const [thumbnailResponse, playlistResponse, playbackResponse] = await Promise.all([
      fetch(video.thumbnailUrl, { cache: "no-store" }),
      fetch(video.hlsPlaybackUrl, { cache: "no-store" }),
      fetch(video.playbackUrl, { method: "HEAD", cache: "no-store" }),
    ]);

    if (!thumbnailResponse.ok) {
      throw new Error(`Thumbnail fetch failed with ${thumbnailResponse.status}.`);
    }
    if (!playlistResponse.ok) {
      throw new Error(`HLS playlist fetch failed with ${playlistResponse.status}.`);
    }
    if (!playbackResponse.ok) {
      throw new Error(`MP4 playback HEAD failed with ${playbackResponse.status}.`);
    }

    const thumbnailType = thumbnailResponse.headers.get("content-type") || "";
    if (!thumbnailType.includes("image/jpeg")) {
      throw new Error(`Unexpected thumbnail content type: ${thumbnailType || "(missing)"}`);
    }

    const manifest = await playlistResponse.text();
    const segmentMatch = manifest.match(/segment-\d+\.ts/);
    if (!segmentMatch) {
      throw new Error(`HLS manifest did not reference a segment: ${manifest}`);
    }

    const segmentUrl = new URL(`./${segmentMatch[0]}`, video.hlsPlaybackUrl).toString();
    const segmentResponse = await fetch(segmentUrl, { method: "HEAD", cache: "no-store" });
    if (!segmentResponse.ok) {
      throw new Error(`HLS segment HEAD failed with ${segmentResponse.status}.`);
    }

    console.log("");
    console.log("Media smoke test passed.");
    console.log(`Video ID: ${video.id}`);
    console.log(`Managed ffmpeg: ${ffmpegPath}`);
    console.log(`MP4: ${video.playbackUrl}`);
    console.log(`Thumbnail: ${video.thumbnailUrl}`);
    console.log(`HLS: ${video.hlsPlaybackUrl}`);
    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
  } finally {
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`mt-node media smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
