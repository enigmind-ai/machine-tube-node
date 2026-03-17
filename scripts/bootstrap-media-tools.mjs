#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const dataDir = path.resolve(process.env.MT_NODE_DATA_DIR || path.join(repoRoot, "data"));
const binDir = path.resolve(process.env.MT_NODE_BIN_DIR || path.join(dataDir, "bin"));
const ffmpegPath = path.join(binDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const ffprobePath = path.join(binDir, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");

function canRunExecutable(command, args) {
  try {
    const result = spawnSync(command, args, {
      stdio: "ignore",
      shell: false
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function ensureExecutable(filePath) {
  if (process.platform === "win32") {
    return;
  }

  try {
    chmodSync(filePath, 0o755);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code !== "EPERM" && code !== "EROFS" && code !== "EINVAL") {
      throw error;
    }
  }
}

function resolveExecutableOnPath(platformFileName, fallbackCommand) {
  const locator = process.platform === "win32" ? "where" : "which";
  const query = process.platform === "win32" ? platformFileName : fallbackCommand;

  try {
    const result = spawnSync(locator, [query], {
      stdio: "pipe",
      encoding: "utf8",
      shell: false
    });
    if (result.error || result.status !== 0) {
      return null;
    }

    const firstLine = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    return firstLine ? path.resolve(firstLine) : null;
  } catch {
    return null;
  }
}

function extractArchive(archivePath, destination, archiveType) {
  const tarResult = spawnSync("tar", ["-xf", archivePath, "-C", destination], {
    stdio: "ignore",
    shell: false
  });
  if (!tarResult.error && tarResult.status === 0) {
    return;
  }

  if (process.platform === "win32" && archiveType === "zip") {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`
      ],
      {
        stdio: "ignore"
      }
    );
    return;
  }

  throw new Error(`Failed to extract archive ${archivePath}.`);
}

function findFileRecursive(root, fileName) {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.resolve(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findFileRecursive(fullPath, fileName);
      if (nested) {
        return nested;
      }
      continue;
    }
    if (entry.isFile() && entry.name === fileName) {
      return fullPath;
    }
  }
  return null;
}

function resolveMediaToolsDownloadAsset(platformName, arch) {
  const base = "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download";

  if (platformName === "win32") {
    if (arch === "x64") {
      return {
        url: `${base}/ffmpeg-master-latest-win64-gpl.zip`,
        archiveFileName: "ffmpeg-master-latest-win64-gpl.zip",
        archiveType: "zip"
      };
    }
    if (arch === "arm64") {
      return {
        url: `${base}/ffmpeg-master-latest-winarm64-gpl.zip`,
        archiveFileName: "ffmpeg-master-latest-winarm64-gpl.zip",
        archiveType: "zip"
      };
    }
  }

  if (platformName === "linux") {
    if (arch === "x64") {
      return {
        url: `${base}/ffmpeg-master-latest-linux64-gpl.tar.xz`,
        archiveFileName: "ffmpeg-master-latest-linux64-gpl.tar.xz",
        archiveType: "tar.xz"
      };
    }
    if (arch === "arm64") {
      return {
        url: `${base}/ffmpeg-master-latest-linuxarm64-gpl.tar.xz`,
        archiveFileName: "ffmpeg-master-latest-linuxarm64-gpl.tar.xz",
        archiveType: "tar.xz"
      };
    }
  }

  throw new Error(`Managed FFmpeg bootstrap is not implemented for ${platformName}/${arch}.`);
}

async function downloadBytes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  mkdirSync(binDir, { recursive: true });

  if (existsSync(ffmpegPath) && existsSync(ffprobePath) && canRunExecutable(ffmpegPath, ["-version"]) && canRunExecutable(ffprobePath, ["-version"])) {
    console.log(`Media tools already ready in ${binDir}`);
    return;
  }

  const ffmpegFromPath = resolveExecutableOnPath(process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg", "ffmpeg");
  const ffprobeFromPath = resolveExecutableOnPath(process.platform === "win32" ? "ffprobe.exe" : "ffprobe", "ffprobe");
  if (ffmpegFromPath && ffprobeFromPath) {
    copyFileSync(ffmpegFromPath, ffmpegPath);
    copyFileSync(ffprobeFromPath, ffprobePath);
    ensureExecutable(ffmpegPath);
    ensureExecutable(ffprobePath);
    console.log(`Copied ffmpeg and ffprobe into managed bin: ${binDir}`);
    return;
  }

  const asset = resolveMediaToolsDownloadAsset(process.platform, process.arch);
  const archivePath = path.join(binDir, asset.archiveFileName);
  const extractDir = path.join(binDir, `extract-${Date.now()}`);

  mkdirSync(extractDir, { recursive: true });

  try {
    const bytes = await downloadBytes(asset.url);
    writeFileSync(archivePath, bytes);
    extractArchive(archivePath, extractDir, asset.archiveType);

    const ffmpegCandidate = findFileRecursive(extractDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    const ffprobeCandidate = findFileRecursive(extractDir, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
    if (!ffmpegCandidate || !ffprobeCandidate) {
      throw new Error("Downloaded archive did not contain ffmpeg and ffprobe.");
    }

    copyFileSync(ffmpegCandidate, ffmpegPath);
    copyFileSync(ffprobeCandidate, ffprobePath);
    ensureExecutable(ffmpegPath);
    ensureExecutable(ffprobePath);
    console.log(`Downloaded and prepared managed ffmpeg tools in ${binDir}`);
  } finally {
    rmSync(archivePath, { force: true });
    rmSync(extractDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Failed to prepare media tools: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
