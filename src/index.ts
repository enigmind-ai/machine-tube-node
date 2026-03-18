import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { generateThumbnail, probeVideo, transcodeToHls, type MediaToolPaths, type VideoProbe } from "./media.js";

type MachineTubeCredentials = {
  baseUrl: string;
  agentId: string;
  apiKey: string;
};

type MtNodeConfig = {
  nodeId: string;
  api: {
    host: string;
    port: number;
  };
  machineTube: MachineTubeCredentials;
  createdAt: string;
};

type RegisteredVideo = {
  id: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  createdAt: string;
  outputs: {
    probe: VideoProbe | null;
    thumbnail: GeneratedAsset | null;
    hls: GeneratedHlsOutput | null;
    lastPreparedAt: string | null;
    lastPreparationError: string | null;
  };
  machineTube: {
    lastPublishedAt: string | null;
    lastSyncedAt: string | null;
    lastSyncError: string | null;
    videoId: string | null;
    watchUrl: string | null;
    status: string | null;
    title: string | null;
    externalPlaybackUrl: string | null;
    externalPlaybackHlsUrl: string | null;
    externalThumbnailUrl: string | null;
    sourceUrl: string | null;
  };
};

type RuntimePaths = {
  projectRoot: string;
  dataDir: string;
  configPath: string;
  videosPath: string;
  binDir: string;
  inboxDir: string;
  outputsDir: string;
  managedCloudflaredPath: string;
};

type JsonRecord = Record<string, unknown>;

type TunnelMode = "off" | "docker" | "binary";

type TunnelSnapshot = {
  mode: TunnelMode;
  status: "disabled" | "starting" | "online" | "error" | "stopped";
  publicBaseUrl: string | null;
  targetUrl: string | null;
  source: "env" | "cloudflared" | null;
  executablePath: string | null;
  lastStartedAt: string | null;
  lastError: string | null;
};

type CloudflaredBootstrapResult = {
  executablePath: string;
  managed: boolean;
  downloadUrl: string | null;
};

type MediaBootstrapResult = {
  ffmpegPath: string;
  ffprobePath: string;
  managed: boolean;
  downloadUrl: string | null;
};

type MediaToolsSnapshot = {
  status: "unknown" | "ready" | "error";
  source: "env" | "managed" | "path" | null;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  managed: boolean;
  lastReadyAt: string | null;
  lastError: string | null;
  downloadUrl: string | null;
};

type PublishRequestBody = {
  filePath?: unknown;
  inboxFileName?: unknown;
  useLatestInboxVideo?: unknown;
  title?: unknown;
  description?: unknown;
  tags?: unknown;
  sourceUrl?: unknown;
  transcript?: unknown;
  externalThumbnailUrl?: unknown;
  publishToMachineTube?: unknown;
  machineTube?: unknown;
};

type GeneratedAsset = {
  localPath: string;
  bytes: number;
  mimeType: string;
  generatedAt: string;
};

type GeneratedHlsFile = {
  localPath: string;
  relativePath: string;
  bytes: number;
  mimeType: string;
};

type GeneratedHlsOutput = {
  rootDirectory: string;
  playlist: GeneratedHlsFile;
  files: GeneratedHlsFile[];
  generatedAt: string;
};

type MachineTubePublishResult = {
  ok: true;
  videoId: string;
  status: string;
  watchUrl: string;
};

type RuntimeEnvironment = {
  platform: NodeJS.Platform;
  dockerLikely: boolean;
};

type InboxAvailability = {
  directory: string;
  mode: "host-local" | "host-bind" | "container-local" | "docker-volume";
  usableForHumanDrop: boolean;
  message: string;
  mountPoint: string | null;
  mountSource: string | null;
};

class MediaToolsManager {
  private readonly managedFfmpegPath: string;
  private readonly managedFfprobePath: string;
  private pendingBootstrap: Promise<MediaBootstrapResult> | null = null;
  private snapshot: MediaToolsSnapshot = {
    status: "unknown",
    source: null,
    ffmpegPath: null,
    ffprobePath: null,
    managed: false,
    lastReadyAt: null,
    lastError: null,
    downloadUrl: null,
  };

  constructor(binDir: string) {
    this.managedFfmpegPath = resolve(binDir, managedMediaToolFileName("ffmpeg", process.platform));
    this.managedFfprobePath = resolve(binDir, managedMediaToolFileName("ffprobe", process.platform));
  }

  getSnapshot(): MediaToolsSnapshot {
    return { ...this.snapshot };
  }

  async ensureReady(): Promise<MediaToolPaths> {
    if (this.snapshot.status === "ready" && this.snapshot.ffmpegPath && this.snapshot.ffprobePath) {
      return {
        ffmpegPath: this.snapshot.ffmpegPath,
        ffprobePath: this.snapshot.ffprobePath,
      };
    }

    const managed = this.tryResolveKnownPair(this.managedFfmpegPath, this.managedFfprobePath, "managed", true, null);
    if (managed) {
      return managed;
    }

    const bootstrapped = await this.bootstrapManaged();
    return {
      ffmpegPath: bootstrapped.ffmpegPath,
      ffprobePath: bootstrapped.ffprobePath,
    };
  }

  async bootstrapManaged(): Promise<MediaBootstrapResult> {
    const managed = this.tryResolveKnownPair(this.managedFfmpegPath, this.managedFfprobePath, "managed", true, null);
    if (managed) {
      return {
        ffmpegPath: managed.ffmpegPath,
        ffprobePath: managed.ffprobePath,
        managed: true,
        downloadUrl: null,
      };
    }

    if (this.pendingBootstrap) {
      return this.pendingBootstrap;
    }

    this.pendingBootstrap = this.bootstrapManagedInternal();
    try {
      return await this.pendingBootstrap;
    } finally {
      this.pendingBootstrap = null;
    }
  }

  private async bootstrapManagedInternal(): Promise<MediaBootstrapResult> {
    const asset = resolveMediaToolsDownloadAsset(process.platform, process.arch);
    const archivePath = resolve(dirname(this.managedFfmpegPath), asset.archiveFileName);
    const extractDir = resolve(dirname(this.managedFfmpegPath), `extract-${Date.now()}`);

    mkdirSync(dirname(this.managedFfmpegPath), { recursive: true });
    mkdirSync(extractDir, { recursive: true });

    try {
      const ffmpegFromPath = resolveExecutableOnPath(managedMediaToolFileName("ffmpeg", process.platform), "ffmpeg");
      const ffprobeFromPath = resolveExecutableOnPath(managedMediaToolFileName("ffprobe", process.platform), "ffprobe");
      if (ffmpegFromPath && ffprobeFromPath) {
        copyFileSync(ffmpegFromPath, this.managedFfmpegPath);
        copyFileSync(ffprobeFromPath, this.managedFfprobePath);
        ensureExecutable(this.managedFfmpegPath);
        ensureExecutable(this.managedFfprobePath);

        const resolved = this.tryResolveKnownPair(
          this.managedFfmpegPath,
          this.managedFfprobePath,
          "managed",
          true,
          null,
        );
        if (!resolved) {
          throw new Error("Managed FFmpeg binaries copied from PATH could not be executed.");
        }

        return {
          ffmpegPath: resolved.ffmpegPath,
          ffprobePath: resolved.ffprobePath,
          managed: true,
          downloadUrl: null,
        };
      }

      const response = await fetch(asset.url);
      if (!response.ok) {
        throw new Error(`Failed to download FFmpeg tools from ${asset.url}: ${response.status} ${response.statusText}`);
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      writeFileSync(archivePath, bytes);
      extractArchive(archivePath, extractDir, asset.archiveType);

      const ffmpegCandidate = findFileRecursive(extractDir, managedMediaToolFileName("ffmpeg", process.platform));
      const ffprobeCandidate = findFileRecursive(extractDir, managedMediaToolFileName("ffprobe", process.platform));
      if (!ffmpegCandidate || !ffprobeCandidate) {
        throw new Error("Downloaded FFmpeg archive did not include both ffmpeg and ffprobe executables.");
      }

      copyFileSync(ffmpegCandidate, this.managedFfmpegPath);
      copyFileSync(ffprobeCandidate, this.managedFfprobePath);
      ensureExecutable(this.managedFfmpegPath);
      ensureExecutable(this.managedFfprobePath);

      const resolved = this.tryResolveKnownPair(
        this.managedFfmpegPath,
        this.managedFfprobePath,
        "managed",
        true,
        asset.url,
      );
      if (!resolved) {
        throw new Error("Managed FFmpeg binaries were downloaded but could not be executed.");
      }

      return {
        ffmpegPath: resolved.ffmpegPath,
        ffprobePath: resolved.ffprobePath,
        managed: true,
        downloadUrl: asset.url,
      };
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        status: "error",
        source: null,
        managed: false,
        ffmpegPath: null,
        ffprobePath: null,
        lastError: formatError(error),
        downloadUrl: asset.url,
      };
      throw error;
    } finally {
      try {
        rmSync(archivePath, { force: true });
      } catch {
        // ignore cleanup failure
      }
      try {
        rmSync(extractDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failure
      }
    }
  }

  private tryResolveKnownPair(
    ffmpegPath: string,
    ffprobePath: string,
    source: "env" | "managed" | "path",
    managed: boolean,
    downloadUrl: string | null,
  ): MediaToolPaths | null {
    if (!canRunExecutable(ffmpegPath, ["-version"]) || !canRunExecutable(ffprobePath, ["-version"])) {
      return null;
    }

    this.snapshot = {
      status: "ready",
      source,
      ffmpegPath,
      ffprobePath,
      managed,
      lastReadyAt: new Date().toISOString(),
      lastError: null,
      downloadUrl,
    };
    return { ffmpegPath, ffprobePath };
  }
}

class TunnelManager {
  private readonly mode: TunnelMode;
  private readonly publicBaseUrlFromEnv: string;
  private readonly cloudflaredBin: string;
  private readonly timeoutMs: number;
  private readonly targetUrl: string;
  private readonly managedCloudflaredPath: string;
  private process: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private snapshot: TunnelSnapshot;
  private pendingStart: Promise<TunnelSnapshot> | null = null;
  private pendingBootstrap: Promise<CloudflaredBootstrapResult> | null = null;

  constructor(localPort: number, managedCloudflaredPath: string) {
    this.mode = parseTunnelMode(process.env.MT_NODE_TUNNEL_MODE);
    this.publicBaseUrlFromEnv = process.env.MT_NODE_PUBLIC_BASE_URL?.trim() || "";
    this.cloudflaredBin = process.env.MT_NODE_TUNNEL_BIN?.trim() || "cloudflared";
    this.timeoutMs = parseNumber(process.env.MT_NODE_TUNNEL_TIMEOUT_MS, 30000);
    this.targetUrl = process.env.MT_NODE_TUNNEL_TARGET_URL?.trim() || defaultTunnelTargetUrl(this.mode, localPort);
    this.managedCloudflaredPath = managedCloudflaredPath;

    this.snapshot = {
      mode: this.mode,
      status: this.publicBaseUrlFromEnv ? "online" : this.mode === "off" ? "disabled" : "stopped",
      publicBaseUrl: this.publicBaseUrlFromEnv || null,
      targetUrl: this.publicBaseUrlFromEnv ? this.targetUrl : this.mode === "off" ? null : this.targetUrl,
      source: this.publicBaseUrlFromEnv ? "env" : null,
      executablePath:
        this.publicBaseUrlFromEnv || this.mode !== "binary"
          ? null
          : resolveCloudflaredCandidatePath(this.cloudflaredBin, this.managedCloudflaredPath),
      lastStartedAt: null,
      lastError: null,
    };
  }

  getSnapshot(): TunnelSnapshot {
    return { ...this.snapshot };
  }

  async bootstrapBinary(): Promise<CloudflaredBootstrapResult> {
    if (this.mode !== "binary") {
      throw new Error("cloudflared bootstrap is only relevant in binary tunnel mode.");
    }

    if (this.pendingBootstrap) {
      return this.pendingBootstrap;
    }

    this.pendingBootstrap = this.bootstrapBinaryInternal();
    try {
      return await this.pendingBootstrap;
    } finally {
      this.pendingBootstrap = null;
    }
  }

  async ensureStarted(): Promise<TunnelSnapshot> {
    if (this.publicBaseUrlFromEnv || this.mode === "off" || this.snapshot.status === "online") {
      return this.getSnapshot();
    }

    if (this.pendingStart) {
      return this.pendingStart;
    }

    this.snapshot = {
      ...this.snapshot,
      status: "starting",
      targetUrl: this.targetUrl,
      executablePath:
        this.mode === "binary" ? resolveCloudflaredCandidatePath(this.cloudflaredBin, this.managedCloudflaredPath) : null,
      lastStartedAt: new Date().toISOString(),
      lastError: null,
    };

    this.pendingStart = this.startCloudflared();
    try {
      return await this.pendingStart;
    } finally {
      this.pendingStart = null;
    }
  }

  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    if (!this.publicBaseUrlFromEnv) {
      this.snapshot = {
        ...this.snapshot,
        status: this.mode === "off" ? "disabled" : "stopped",
        publicBaseUrl: null,
        source: null,
      };
    }
  }

  private async bootstrapBinaryInternal(): Promise<CloudflaredBootstrapResult> {
    const explicitBinary = this.cloudflaredBin !== "cloudflared" ? resolve(this.cloudflaredBin) : "";
    if (explicitBinary && existsSync(explicitBinary)) {
      console.log(`[mt-node] cloudflared: using explicit binary at ${explicitBinary}`);
      this.snapshot = { ...this.snapshot, executablePath: explicitBinary, lastError: null };
      return { executablePath: explicitBinary, managed: false, downloadUrl: null };
    }

    if (existsSync(this.managedCloudflaredPath)) {
      ensureExecutable(this.managedCloudflaredPath);
      console.log(`[mt-node] cloudflared: using managed binary at ${this.managedCloudflaredPath}`);
      this.snapshot = { ...this.snapshot, executablePath: this.managedCloudflaredPath, lastError: null };
      return { executablePath: this.managedCloudflaredPath, managed: true, downloadUrl: null };
    }

    const asset = resolveCloudflaredDownloadAsset(process.platform, process.arch);
    mkdirSync(dirname(this.managedCloudflaredPath), { recursive: true });

    console.log(`[mt-node] cloudflared: downloading binary from ${asset.url}`);
    const response = await fetch(asset.url);
    if (!response.ok) {
      throw new Error(`Failed to download cloudflared from ${asset.url}: ${response.status} ${response.statusText}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(this.managedCloudflaredPath, bytes);
    ensureExecutable(this.managedCloudflaredPath);
    console.log(`[mt-node] cloudflared: binary downloaded to ${this.managedCloudflaredPath}`);
    this.snapshot = { ...this.snapshot, executablePath: this.managedCloudflaredPath, lastError: null };
    return { executablePath: this.managedCloudflaredPath, managed: true, downloadUrl: asset.url };
  }

  private async startCloudflared(): Promise<TunnelSnapshot> {
    const command = this.mode === "binary" ? (await this.bootstrapBinary()).executablePath : "docker";
    const args =
      this.mode === "binary"
        ? ["tunnel", "--no-autoupdate", "--url", this.targetUrl]
        : ["run", "--rm", "cloudflare/cloudflared:latest", "tunnel", "--no-autoupdate", "--url", this.targetUrl];

    console.log(`[mt-node] cloudflared: starting tunnel → ${this.targetUrl} (mode=${this.mode}, timeout=${this.timeoutMs}ms)`);

    return new Promise<TunnelSnapshot>((resolvePromise, rejectPromise) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      this.process = child;
      let settled = false;
      let bufferedLogs = "";

      const settleSuccess = (publicBaseUrl: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.snapshot = {
          ...this.snapshot,
          status: "online",
          publicBaseUrl,
          source: "cloudflared",
          executablePath: this.mode === "binary" ? command : null,
          lastError: null,
        };
        console.log(`[mt-node] cloudflared: tunnel online at ${publicBaseUrl}`);
        resolvePromise(this.getSnapshot());
      };

      const settleFailure = (message: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.snapshot = {
          ...this.snapshot,
          status: "error",
          publicBaseUrl: null,
          source: null,
          lastError: message,
        };
        if (this.process === child) {
          this.process = null;
        }
        console.error(`[mt-node] cloudflared: failed to start — ${message}`);
        rejectPromise(new Error(message));
      };

      const timer = setTimeout(() => {
        settleFailure(`Timed out waiting for cloudflared tunnel URL after ${this.timeoutMs}ms.`);
        child.kill();
      }, this.timeoutMs);

      const onOutput = (chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        bufferedLogs += text;
        const url = extractCloudflareUrl(text) ?? extractCloudflareUrl(bufferedLogs);
        if (url) {
          clearTimeout(timer);
          settleSuccess(url);
        }
      };

      child.stdout.on("data", onOutput);
      child.stderr.on("data", onOutput);
      child.once("error", (error) => {
        clearTimeout(timer);
        settleFailure(`Failed to start cloudflared: ${error.message}`);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (settled) {
          if (this.process === child) {
            this.process = null;
            const exitMsg = `cloudflared exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
            this.snapshot = {
              ...this.snapshot,
              status: "stopped",
              publicBaseUrl: null,
              source: null,
              lastError: exitMsg,
            };
            console.warn(`[mt-node] cloudflared: ${exitMsg} tunnel will restart on next sync.`);
          }
          return;
        }
        settleFailure(`cloudflared exited before a URL was captured (code=${code ?? "null"}, signal=${signal ?? "null"}).`);
      });
    });
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const resolvedDataDir = resolve(process.env.MT_NODE_DATA_DIR ?? resolve(__dirname, "..", "data"));
const paths: RuntimePaths = {
  projectRoot: resolve(__dirname, ".."),
  dataDir: resolvedDataDir,
  configPath: resolve(process.env.MT_NODE_CONFIG_PATH ?? resolve(resolvedDataDir, "config.json")),
  videosPath: resolve(process.env.MT_NODE_VIDEOS_PATH ?? resolve(resolvedDataDir, "videos.json")),
  binDir: resolve(process.env.MT_NODE_BIN_DIR ?? resolve(resolvedDataDir, "bin")),
  inboxDir: resolve(process.env.MT_NODE_INBOX_DIR ?? defaultInboxDir()),
  outputsDir: resolve(resolvedDataDir, "outputs"),
  managedCloudflaredPath: resolve(
    process.env.MT_NODE_MANAGED_CLOUDFLARED_PATH ??
      resolve(process.env.MT_NODE_BIN_DIR ?? resolve(resolvedDataDir, "bin"), managedCloudflaredFileName(process.platform)),
  ),
};

const port = parseNumber(process.env.MT_NODE_PORT, 43110);
const host = process.env.MT_NODE_HOST?.trim() || "0.0.0.0";
const startedAt = new Date();
const runtimeEnvironment = detectRuntimeEnvironment();

mkdirSync(paths.dataDir, { recursive: true });
mkdirSync(paths.binDir, { recursive: true });
mkdirSync(paths.inboxDir, { recursive: true });
mkdirSync(paths.outputsDir, { recursive: true });
const config = loadOrCreateConfig(paths.configPath, {
  nodeId: createId("mtn"),
  api: { host, port },
  machineTube: {
    baseUrl: process.env.MT_MACHINETUBE_BASE_URL?.trim() || "",
    agentId: process.env.MT_MACHINETUBE_AGENT_ID?.trim() || "",
    apiKey: process.env.MT_MACHINETUBE_API_KEY?.trim() || "",
  },
  createdAt: startedAt.toISOString(),
});
const videos = loadOrCreateVideos(paths.videosPath);
const tunnelManager = new TunnelManager(port, paths.managedCloudflaredPath);
const mediaToolsManager = new MediaToolsManager(paths.binDir);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, { ok: true, status: "live" });
    }

    if (req.method === "GET" && url.pathname === "/status") {
      return sendJson(res, 200, {
        ok: true,
        service: "mt-node",
        version: "0.1.0",
        pid: process.pid,
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
        listeningOn: { host, port },
        paths,
        config,
        videoCount: videos.length,
        publishedVideoCount: countPublishedMachineTubeVideos(),
        runtime: runtimeEnvironment,
        tunnel: tunnelManager.getSnapshot(),
        mediaTools: mediaToolsManager.getSnapshot(),
        inbox: {
          availability: evaluateInboxAvailability(paths.inboxDir, runtimeEnvironment),
          files: listInboxFiles(),
        },
        heartbeat: buildHeartbeatPayload(req),
      });
    }

    if (req.method === "GET" && url.pathname === "/heartbeat") {
      return sendJson(res, 200, {
        ok: true,
        heartbeat: buildHeartbeatPayload(req),
      });
    }

    if (req.method === "GET" && url.pathname === "/origin-health") {
      return sendJson(res, 200, {
        ok: true,
        originHealth: buildOriginHealthPayload(req),
      });
    }

    if (req.method === "GET" && url.pathname === "/tunnel/status") {
      return sendJson(res, 200, { ok: true, tunnel: tunnelManager.getSnapshot() });
    }

    if (req.method === "POST" && url.pathname === "/tunnel/start") {
      const tunnel = await tunnelManager.ensureStarted();
      return sendJson(res, 200, { ok: true, tunnel });
    }

    if (req.method === "POST" && url.pathname === "/tunnel/stop") {
      tunnelManager.stop();
      return sendJson(res, 200, { ok: true, tunnel: tunnelManager.getSnapshot() });
    }

    if (req.method === "POST" && url.pathname === "/bootstrap/cloudflared") {
      const result = await tunnelManager.bootstrapBinary();
      return sendJson(res, 200, { ok: true, cloudflared: result });
    }

    if (req.method === "GET" && url.pathname === "/videos") {
      return sendJson(res, 200, {
        ok: true,
        videos: videos.map((video) => toVideoResponse(video, req)),
      });
    }

    if (req.method === "GET" && url.pathname === "/inbox") {
      return sendJson(res, 200, {
        ok: true,
        inbox: {
          availability: evaluateInboxAvailability(paths.inboxDir, runtimeEnvironment),
          files: listInboxFiles(),
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/videos/register") {
      const body = (await readJsonBody(req)) as PublishRequestBody;
      const selection = resolvePublishSourceSelection(body);
      if (!selection.ok) {
        return sendJson(res, selection.status, { ok: false, error: selection.error, ...(selection.details ?? {}) });
      }

      const result = await ensureRegisteredVideo(selection.filePath);
      if (!result.ok) {
        return sendJson(res, result.status, { ok: false, error: result.error, ...(result.details ?? {}) });
      }

      await tunnelManager.ensureStarted().catch(() => undefined);
      return sendJson(res, result.created ? 201 : 200, {
        ok: true,
        selection: selection.selection,
        video: toVideoResponse(result.video, req),
      });
    }

    if (req.method === "POST" && url.pathname === "/publish") {
      const body = (await readJsonBody(req)) as PublishRequestBody;
      const selection = resolvePublishSourceSelection(body);
      if (!selection.ok) {
        return sendJson(res, selection.status, { ok: false, error: selection.error, ...(selection.details ?? {}) });
      }

      const registerResult = await ensureRegisteredVideo(selection.filePath);
      if (!registerResult.ok) {
        return sendJson(res, registerResult.status, { ok: false, error: registerResult.error, ...(registerResult.details ?? {}) });
      }

      const tunnel = await tunnelManager.ensureStarted();
      if (!tunnel.publicBaseUrl) {
        return sendJson(res, 502, { ok: false, error: "No public playback URL is available. Check the tunnel configuration." });
      }

      const video = registerResult.video;
      const videoResponse = toVideoResponse(video, req);
      const externalPlaybackUrl = String(videoResponse.playbackUrl);
      const externalPlaybackHlsUrl =
        typeof videoResponse.hlsPlaybackUrl === "string" ? videoResponse.hlsPlaybackUrl : null;
      const externalThumbnailUrl =
        normalizeOptionalString(body.externalThumbnailUrl) ??
        (typeof videoResponse.thumbnailUrl === "string" ? videoResponse.thumbnailUrl : null);

      // Resolve credentials first so body-supplied creds count for the intent check.
      const credentialsResult = resolveMachineTubeCredentials(body.machineTube, config.machineTube);
      const publishToMachineTube = resolvePublishIntent(
        body.publishToMachineTube,
        credentialsResult.ok ? credentialsResult.credentials : config.machineTube,
      );

      if (!publishToMachineTube) {
        return sendJson(res, registerResult.created ? 201 : 200, {
          ok: true,
          selection: selection.selection,
          video: videoResponse,
          externalPlaybackUrl,
          externalPlaybackHlsUrl,
          externalThumbnailUrl,
          machineTube: {
            published: false,
            reason: "MachineTube publish skipped. Credentials are not configured or publishToMachineTube was disabled.",
          },
        });
      }

      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) {
        return sendJson(res, 400, { ok: false, error: "title is required when publishing to MachineTube." });
      }

      if (!credentialsResult.ok) {
        return sendJson(res, 400, { ok: false, error: credentialsResult.error });
      }

      const publishResult = await publishExternalVideoToMachineTube({
        credentials: credentialsResult.credentials,
        externalPlaybackUrl,
        externalPlaybackHlsUrl,
        externalThumbnailUrl,
        title,
        description: typeof body.description === "string" ? body.description.trim() : "",
        tags: normalizeTags(body.tags),
        sourceUrl: normalizeOptionalString(body.sourceUrl) ?? `${tunnel.publicBaseUrl}/heartbeat`,
        transcript: normalizeOptionalString(body.transcript),
      });

      // If the config didn't have credentials (they came from the request body),
      // save them now so the background sync loop can refresh URLs automatically.
      if (!hasCompleteMachineTubeCredentials(config.machineTube)) {
        config.machineTube = credentialsResult.credentials;
        persistConfig();
        console.log(`[mt-node] credentials saved to config from publish request (agentId=${credentialsResult.credentials.agentId})`);
      }

      video.machineTube = {
        lastPublishedAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: null,
        videoId: publishResult.videoId,
        watchUrl: publishResult.watchUrl,
        status: publishResult.status,
        title,
        externalPlaybackUrl,
        externalPlaybackHlsUrl,
        externalThumbnailUrl,
        sourceUrl: normalizeOptionalString(body.sourceUrl) ?? `${tunnel.publicBaseUrl}/heartbeat`,
      };
      persistVideos();

      return sendJson(res, registerResult.created ? 201 : 200, {
        ok: true,
        selection: selection.selection,
        video: toVideoResponse(video, req),
        externalPlaybackUrl,
        externalPlaybackHlsUrl,
        externalThumbnailUrl,
        machineTube: {
          published: true,
          videoId: publishResult.videoId,
          status: publishResult.status,
          watchUrl: publishResult.watchUrl,
        },
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/videos/")) {
      const videoId = decodeURIComponent(url.pathname.slice("/videos/".length));
      const video = videos.find((item) => item.id === videoId);
      if (!video) {
        return sendJson(res, 404, { ok: false, error: "Video not found.", videoId });
      }
      return sendJson(res, 200, { ok: true, video: toVideoResponse(video, req) });
    }

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/media/")) {
      const resolvedMedia = resolveMediaRequest(url.pathname);
      if (!resolvedMedia) {
        return sendJson(res, 404, {
          ok: false,
          error: "Not found.",
          method: req.method,
          path: url.pathname,
        });
      }

      const video = videos.find((item) => item.id === resolvedMedia.videoId);
      if (!video) {
        return sendJson(res, 404, { ok: false, error: "Video not found.", videoId: resolvedMedia.videoId });
      }

      if (resolvedMedia.kind === "raw") {
        return serveVideo(req, res, video);
      }

      const asset = resolvedMedia.kind === "thumbnail" ? video.outputs.thumbnail : findHlsFile(video, resolvedMedia.relativePath);
      if (!asset) {
        return sendJson(res, 404, { ok: false, error: "Media output not found.", videoId: resolvedMedia.videoId });
      }

      return serveStaticAsset(req, res, asset);
    }

    return sendJson(res, 404, {
      ok: false,
      error: "Not found.",
      method: req.method,
      path: url.pathname,
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: formatError(error) });
  }
});

server.listen(port, host, () => {
  const tunnelSnapshot = tunnelManager.getSnapshot();
  console.log(`[mt-node] listening on http://${host}:${port}`);
  console.log(`[mt-node] data dir: ${paths.dataDir}`);
  console.log(`[mt-node] config path: ${paths.configPath}`);
  console.log(`[mt-node] videos path: ${paths.videosPath}`);
  console.log(`[mt-node] managed cloudflared path: ${paths.managedCloudflaredPath}`);
  console.log(`[mt-node] tunnel mode: ${tunnelSnapshot.mode}${tunnelSnapshot.publicBaseUrl ? ` (env url: ${tunnelSnapshot.publicBaseUrl})` : ""}`);
  console.log(`[mt-node] videos loaded: ${videos.length} (${videos.filter((v) => v.machineTube.videoId).length} published to MachineTube)`);
  if (tunnelSnapshot.mode !== "off") {
    void tunnelManager.ensureStarted().catch((error) => {
      console.error(`[mt-node] tunnel start failed: ${formatError(error)}`);
    });
  }
  void mediaToolsManager.bootstrapManaged().catch((error) => {
    console.error(`[mt-node] media tools bootstrap failed: ${formatError(error)}`);
  });
  void prepareRegisteredVideos().catch((error) => {
    console.error(`[mt-node] initial media preparation failed: ${formatError(error)}`);
  });
  void syncPublishedVideoOrigins().catch((error) => {
    console.error(`[mt-node] initial sync failed: ${formatError(error)}`);
  });
});

const syncIntervalMs = parseNumber(process.env.MT_NODE_SYNC_INTERVAL_MS, 30000);
const syncTimer = setInterval(() => {
  void syncPublishedVideoOrigins().catch((error) => {
    console.error(`[mt-node] sync loop failed: ${formatError(error)}`);
  });
}, syncIntervalMs);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(syncTimer);
    tunnelManager.stop();
    server.close(() => process.exit(0));
  });
}

async function ensureRegisteredVideo(filePath: string):
  Promise<{ ok: true; video: RegisteredVideo; created: boolean } | { ok: false; status: number; error: string; details?: JsonRecord }> {
  const absoluteFilePath = resolve(filePath);
  if (!existsSync(absoluteFilePath)) {
    return { ok: false, status: 404, error: "File does not exist.", details: { filePath: absoluteFilePath } };
  }

  const fileStat = statSync(absoluteFilePath);
  if (!fileStat.isFile()) {
    return { ok: false, status: 400, error: "filePath must point to a file.", details: { filePath: absoluteFilePath } };
  }

  const existing = videos.find((video) => video.filePath === absoluteFilePath);
  if (existing) {
    existing.fileName = absoluteFilePath.split(/[\\/]/).pop() || existing.fileName;
    existing.mimeType = guessMimeType(absoluteFilePath);
    existing.bytes = fileStat.size;
    await ensureVideoOutputs(existing);
    persistVideos();
    return { ok: true, video: existing, created: false };
  }

  const video: RegisteredVideo = {
    id: createId("vid"),
    filePath: absoluteFilePath,
    fileName: absoluteFilePath.split(/[\\/]/).pop() || "video",
    mimeType: guessMimeType(absoluteFilePath),
    bytes: fileStat.size,
    createdAt: new Date().toISOString(),
    outputs: {
      probe: null,
      thumbnail: null,
      hls: null,
      lastPreparedAt: null,
      lastPreparationError: null,
    },
    machineTube: {
      lastPublishedAt: null,
      lastSyncedAt: null,
      lastSyncError: null,
      videoId: null,
      watchUrl: null,
      status: null,
      title: null,
      externalPlaybackUrl: null,
      externalPlaybackHlsUrl: null,
      externalThumbnailUrl: null,
      sourceUrl: null,
    },
  };

  await ensureVideoOutputs(video);
  videos.push(video);
  persistVideos();
  return { ok: true, video, created: true };
}

function resolvePublishSourceSelection(body: PublishRequestBody):
  | { ok: true; filePath: string; selection: JsonRecord }
  | { ok: false; status: number; error: string; details?: JsonRecord } {
  const filePath = normalizeOptionalString(body.filePath);
  if (filePath) {
    return {
      ok: true,
      filePath,
      selection: {
        mode: "filePath",
        filePath: resolve(filePath),
      },
    };
  }

  const inboxAvailability = evaluateInboxAvailability(paths.inboxDir, runtimeEnvironment);
  const inboxGuard = ensureInboxAvailableForHumanDrop(inboxAvailability);
  if (!inboxGuard.ok) {
    return inboxGuard;
  }

  const inboxFileName = normalizeOptionalString(body.inboxFileName);
  if (inboxFileName) {
    const resolved = resolveInboxFilePath(inboxFileName);
    if (!resolved.ok) {
      return resolved;
    }
    return {
      ok: true,
      filePath: resolved.filePath,
      selection: {
        mode: "inboxFileName",
        inbox: inboxAvailability,
        inboxFileName,
        filePath: resolved.filePath,
      },
    };
  }

  if (body.useLatestInboxVideo === true) {
    const latest = findLatestInboxVideo();
    if (!latest.ok) {
      return latest;
    }
    return {
      ok: true,
      filePath: latest.filePath,
      selection: {
        mode: "latestInboxVideo",
        inbox: inboxAvailability,
        inboxFileName: latest.fileName,
        filePath: latest.filePath,
      },
    };
  }

  return {
    ok: false,
    status: 400,
    error: "Provide filePath, inboxFileName, or useLatestInboxVideo=true.",
    details: { inbox: inboxAvailability },
  };
}

function listInboxFiles(): JsonRecord[] {
  return readdirSync(paths.inboxDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = resolve(paths.inboxDir, entry.name);
      const stats = statSync(filePath);
      return {
        fileName: entry.name,
        filePath,
        bytes: stats.size,
        modifiedAt: new Date(stats.mtimeMs).toISOString(),
        mimeType: guessMimeType(filePath),
      };
    })
    .filter((entry) => String(entry.mimeType) !== "application/octet-stream")
    .sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt)));
}

function ensureInboxAvailableForHumanDrop(availability: InboxAvailability):
  | { ok: true }
  | { ok: false; status: number; error: string; details?: JsonRecord } {
  if (availability.usableForHumanDrop) {
    return { ok: true };
  }

  return {
    ok: false,
    status: 409,
    error: availability.message,
    details: { inbox: availability },
  };
}

function resolveInboxFilePath(fileName: string):
  | { ok: true; filePath: string }
  | { ok: false; status: number; error: string; details?: JsonRecord } {
  const resolvedPath = resolve(paths.inboxDir, fileName);
  if (!resolvedPath.startsWith(paths.inboxDir)) {
    return {
      ok: false,
      status: 400,
      error: "inboxFileName must stay within the MachineTube inbox folder.",
      details: { inboxDir: paths.inboxDir, inboxFileName: fileName },
    };
  }

  if (!existsSync(resolvedPath)) {
    return {
      ok: false,
      status: 404,
      error: "Inbox file not found.",
      details: { inboxDir: paths.inboxDir, inboxFileName: fileName, filePath: resolvedPath },
    };
  }

  return { ok: true, filePath: resolvedPath };
}

function findLatestInboxVideo():
  | { ok: true; filePath: string; fileName: string }
  | { ok: false; status: number; error: string; details?: JsonRecord } {
  const files = listInboxFiles();
  if (files.length === 0) {
    return {
      ok: false,
      status: 404,
      error: "No video files were found in the MachineTube inbox folder.",
      details: { inboxDir: paths.inboxDir },
    };
  }

  return {
    ok: true,
    filePath: String(files[0].filePath),
    fileName: String(files[0].fileName),
  };
}

function persistVideos(): void {
  writeFileSync(paths.videosPath, JSON.stringify(videos, null, 2));
}

function persistConfig(): void {
  writeFileSync(paths.configPath, JSON.stringify(config, null, 2));
}

function toVideoResponse(video: RegisteredVideo, req: IncomingMessage): JsonRecord {
  const urls = resolveVideoOutputUrls(video, req);
  const playbackFormats: JsonRecord[] = [
    {
      format: "mp4",
      url: urls.playbackUrl,
      mimeType: video.mimeType,
      preferred: urls.hlsPlaybackUrl === null,
    },
  ];

  if (urls.hlsPlaybackUrl) {
    playbackFormats.unshift({
      format: "hls",
      url: urls.hlsPlaybackUrl,
      mimeType: "application/vnd.apple.mpegurl",
      preferred: true,
    });
  }

  return {
    id: video.id,
    filePath: video.filePath,
    fileName: video.fileName,
    mimeType: video.mimeType,
    bytes: video.bytes,
    createdAt: video.createdAt,
    playbackUrl: urls.playbackUrl,
    preferredPlaybackUrl: urls.preferredPlaybackUrl,
    hlsPlaybackUrl: urls.hlsPlaybackUrl,
    thumbnailUrl: urls.thumbnailUrl,
    playbackFormats,
    metadata: {
      durationSeconds: video.outputs.probe?.durationSeconds ?? null,
      width: video.outputs.probe?.width ?? null,
      height: video.outputs.probe?.height ?? null,
    },
    outputs: {
      thumbnail: video.outputs.thumbnail
        ? {
            url: urls.thumbnailUrl,
            mimeType: video.outputs.thumbnail.mimeType,
            bytes: video.outputs.thumbnail.bytes,
            generatedAt: video.outputs.thumbnail.generatedAt,
          }
        : null,
      hls: video.outputs.hls
        ? {
            playlistUrl: urls.hlsPlaybackUrl,
            mimeType: "application/vnd.apple.mpegurl",
            generatedAt: video.outputs.hls.generatedAt,
          }
        : null,
      lastPreparedAt: video.outputs.lastPreparedAt,
      lastPreparationError: video.outputs.lastPreparationError,
    },
    statusUrl: buildLocalUrl(req, `/videos/${encodeURIComponent(video.id)}`),
    machineTube: video.machineTube,
  };
}

async function ensureVideoOutputs(video: RegisteredVideo): Promise<void> {
  const outputDirectory = resolve(paths.outputsDir, video.id);
  mkdirSync(outputDirectory, { recursive: true });

  const issues: string[] = [];
  let probe = video.outputs.probe;
  let mediaTools: MediaToolPaths | null = null;

  try {
    mediaTools = await mediaToolsManager.ensureReady();
  } catch (error) {
    issues.push(`media tools unavailable: ${formatError(error)}`);
  }

  if (!probe && mediaTools) {
    try {
      probe = await probeVideo(video.filePath, mediaTools);
    } catch (error) {
      issues.push(`ffprobe failed: ${formatError(error)}`);
    }
  }

  let thumbnail = video.outputs.thumbnail;
  if (mediaTools && (!thumbnail || !existsSync(thumbnail.localPath))) {
    const thumbnailPath = resolve(outputDirectory, "thumbnail.jpg");
    try {
      const timestampSeconds = resolveThumbnailTimestamp(probe);
      await generateThumbnail(video.filePath, thumbnailPath, timestampSeconds, mediaTools);
      const fileStat = statSync(thumbnailPath);
      thumbnail = {
        localPath: thumbnailPath,
        bytes: fileStat.size,
        mimeType: "image/jpeg",
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      issues.push(`thumbnail generation failed: ${formatError(error)}`);
    }
  }

  let hls = video.outputs.hls;
  if (mediaTools && (!hls || !existsSync(hls.playlist.localPath))) {
    const hlsDirectory = resolve(outputDirectory, "hls");
    try {
      const generatedFiles = await transcodeToHls(video.filePath, hlsDirectory, mediaTools);
      const files = generatedFiles.map((file) => ({
        localPath: file.localPath,
        relativePath: file.relativePath,
        bytes: file.bytes,
        mimeType: guessMimeType(file.localPath),
      }));
      const playlist = files.find((file) => file.relativePath === "index.m3u8");
      if (!playlist) {
        throw new Error("HLS output did not include index.m3u8.");
      }
      hls = {
        rootDirectory: hlsDirectory,
        playlist,
        files,
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      issues.push(`HLS generation failed: ${formatError(error)}`);
    }
  }

  video.outputs = {
    probe,
    thumbnail,
    hls,
    lastPreparedAt: new Date().toISOString(),
    lastPreparationError: issues.length > 0 ? issues.join(" | ") : null,
  };
}

function resolveThumbnailTimestamp(probe: VideoProbe | null): number {
  if (!probe?.durationSeconds || probe.durationSeconds <= 0) {
    return 1;
  }

  return Math.max(1, Math.min(Math.round(probe.durationSeconds * 0.1), probe.durationSeconds - 1));
}

function resolveVideoOutputUrls(
  video: RegisteredVideo,
  req: IncomingMessage,
): { playbackUrl: string; preferredPlaybackUrl: string; hlsPlaybackUrl: string | null; thumbnailUrl: string | null } {
  const playbackPath = `/media/${encodeURIComponent(video.id)}`;
  const hlsPath = video.outputs.hls ? `/media/${encodeURIComponent(video.id)}/hls/index.m3u8` : null;
  const thumbnailPath = video.outputs.thumbnail ? `/media/${encodeURIComponent(video.id)}/thumbnail.jpg` : null;
  const tunnel = tunnelManager.getSnapshot();

  const playbackUrl = tunnel.publicBaseUrl ? `${tunnel.publicBaseUrl}${playbackPath}` : buildLocalUrl(req, playbackPath);
  const hlsPlaybackUrl = hlsPath ? (tunnel.publicBaseUrl ? `${tunnel.publicBaseUrl}${hlsPath}` : buildLocalUrl(req, hlsPath)) : null;
  const thumbnailUrl = thumbnailPath
    ? tunnel.publicBaseUrl
      ? `${tunnel.publicBaseUrl}${thumbnailPath}`
      : buildLocalUrl(req, thumbnailPath)
    : null;

  return {
    playbackUrl,
    preferredPlaybackUrl: hlsPlaybackUrl ?? playbackUrl,
    hlsPlaybackUrl,
    thumbnailUrl,
  };
}

function resolveMediaRequest(pathname: string):
  | { kind: "raw"; videoId: string }
  | { kind: "thumbnail"; videoId: string }
  | { kind: "hls"; videoId: string; relativePath: string }
  | null {
  const hlsMatch = /^\/media\/([^/]+)\/hls\/(.+)$/.exec(pathname);
  if (hlsMatch) {
    return {
      kind: "hls",
      videoId: decodeURIComponent(hlsMatch[1]),
      relativePath: decodeURIComponent(hlsMatch[2]),
    };
  }

  const thumbnailMatch = /^\/media\/([^/]+)\/thumbnail\.jpg$/.exec(pathname);
  if (thumbnailMatch) {
    return {
      kind: "thumbnail",
      videoId: decodeURIComponent(thumbnailMatch[1]),
    };
  }

  const rawMatch = /^\/media\/([^/]+)$/.exec(pathname);
  if (rawMatch) {
    return {
      kind: "raw",
      videoId: decodeURIComponent(rawMatch[1]),
    };
  }

  return null;
}

function findHlsFile(video: RegisteredVideo, relativePath: string): GeneratedHlsFile | null {
  if (!video.outputs.hls) {
    return null;
  }

  return video.outputs.hls.files.find((file) => file.relativePath === relativePath) ?? null;
}

async function prepareRegisteredVideos(): Promise<void> {
  let changed = false;

  for (const video of videos) {
    const previousOutputs = JSON.stringify(video.outputs);
    await ensureVideoOutputs(video);
    if (JSON.stringify(video.outputs) !== previousOutputs) {
      changed = true;
    }
  }

  if (changed) {
    persistVideos();
  }
}

function buildLocalUrl(req: IncomingMessage, path: string): string {
  const hostHeader = req.headers.host ?? `localhost:${port}`;
  return `http://${hostHeader}${path}`;
}

async function publishExternalVideoToMachineTube(input: {
  credentials: MachineTubeCredentials;
  externalPlaybackUrl: string;
  externalPlaybackHlsUrl: string | null;
  externalThumbnailUrl: string | null;
  title: string;
  description: string;
  tags: string[];
  sourceUrl: string | null;
  transcript: string | null;
}): Promise<MachineTubePublishResult> {
  const baseUrl = normalizeBaseUrl(input.credentials.baseUrl);
  const response = await fetch(`${baseUrl}/api/videos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.credentials.apiKey}`,
      "X-Agent-Id": input.credentials.agentId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      deliveryMode: "external",
      externalPlaybackUrl: input.externalPlaybackUrl,
      externalPlaybackHlsUrl: input.externalPlaybackHlsUrl,
      externalThumbnailUrl: input.externalThumbnailUrl,
      title: input.title,
      description: input.description,
      tags: input.tags,
      sourceUrl: input.sourceUrl,
      transcript: input.transcript,
    }),
  });

  const rawBody = await response.text();
  const parsedBody = rawBody ? tryParseJson(rawBody) : null;

  if (!response.ok) {
    const message =
      parsedBody && typeof parsedBody.error === "string"
        ? parsedBody.error
        : `MachineTube publish failed with ${response.status} ${response.statusText}.`;
    throw new Error(message);
  }

  if (!parsedBody || typeof parsedBody.videoId !== "string" || typeof parsedBody.status !== "string") {
    throw new Error("MachineTube publish response was missing videoId or status.");
  }

  const watchUrl =
    typeof parsedBody.watchUrl === "string" ? new URL(parsedBody.watchUrl, `${baseUrl}/`).toString() : `${baseUrl}/watch/${parsedBody.videoId}`;
  return {
    ok: true,
    videoId: parsedBody.videoId,
    status: parsedBody.status,
    watchUrl,
  };
}

async function refreshExternalVideoOriginInMachineTube(input: {
  credentials: MachineTubeCredentials;
  videoId: string;
  externalPlaybackUrl: string;
  externalPlaybackHlsUrl: string | null;
  externalThumbnailUrl: string | null;
  sourceUrl: string | null;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(input.credentials.baseUrl);
  const response = await fetch(`${baseUrl}/api/videos/${input.videoId}/external-origin`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${input.credentials.apiKey}`,
      "X-Agent-Id": input.credentials.agentId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      externalPlaybackUrl: input.externalPlaybackUrl,
      externalPlaybackHlsUrl: input.externalPlaybackHlsUrl,
      externalThumbnailUrl: input.externalThumbnailUrl,
      sourceUrl: input.sourceUrl,
    }),
  });

  if (!response.ok) {
    const rawBody = await response.text();
    const parsedBody = rawBody ? tryParseJson(rawBody) : null;
    const message =
      parsedBody && typeof parsedBody.error === "string"
        ? parsedBody.error
        : `MachineTube origin refresh failed with ${response.status} ${response.statusText}.`;
    throw new Error(message);
  }
}

async function syncPublishedVideoOrigins(): Promise<void> {
  if (!hasCompleteMachineTubeCredentials(config.machineTube)) {
    console.log("[mt-node] sync: skipping — MachineTube credentials not configured");
    return;
  }

  const publishedVideos = videos.filter((video) => video.machineTube.videoId);
  if (publishedVideos.length === 0) {
    return;
  }

  const tunnel = await tunnelManager.ensureStarted();
  if (!tunnel.publicBaseUrl) {
    console.warn(`[mt-node] sync: skipping — tunnel not online (status=${tunnel.status}${tunnel.lastError ? `, error: ${tunnel.lastError}` : ""})`);
    return;
  }

  console.log(`[mt-node] sync: running for ${publishedVideos.length} published video(s) via ${tunnel.publicBaseUrl}`);
  let changed = false;

  for (const video of videos) {
    if (!video.machineTube.videoId) {
      continue;
    }

    const nextPlaybackUrl = `${tunnel.publicBaseUrl}/media/${encodeURIComponent(video.id)}`;
    const nextPlaybackHlsUrl = video.outputs.hls ? `${tunnel.publicBaseUrl}/media/${encodeURIComponent(video.id)}/hls/index.m3u8` : null;
    const nextSourceUrl = `${tunnel.publicBaseUrl}/heartbeat`;
    const nextThumbnailUrl = video.outputs.thumbnail
      ? `${tunnel.publicBaseUrl}/media/${encodeURIComponent(video.id)}/thumbnail.jpg`
      : video.machineTube.externalThumbnailUrl;

    if (
      video.machineTube.externalPlaybackUrl === nextPlaybackUrl &&
      video.machineTube.externalPlaybackHlsUrl === nextPlaybackHlsUrl &&
      video.machineTube.externalThumbnailUrl === nextThumbnailUrl &&
      video.machineTube.sourceUrl === nextSourceUrl
    ) {
      if (video.machineTube.lastSyncError) {
        video.machineTube.lastSyncError = null;
        video.machineTube.lastSyncedAt = new Date().toISOString();
        changed = true;
      }
      console.log(`[mt-node] sync: video ${video.machineTube.videoId} (${video.fileName}) — urls up to date`);
      continue;
    }

    console.log(`[mt-node] sync: video ${video.machineTube.videoId} (${video.fileName}) — pushing updated urls`);
    console.log(`[mt-node] sync:   sourceUrl  → ${nextSourceUrl}`);
    console.log(`[mt-node] sync:   playbackUrl → ${nextPlaybackUrl}`);

    try {
      await refreshExternalVideoOriginInMachineTube({
        credentials: config.machineTube,
        videoId: video.machineTube.videoId,
        externalPlaybackUrl: nextPlaybackUrl,
        externalPlaybackHlsUrl: nextPlaybackHlsUrl,
        externalThumbnailUrl: nextThumbnailUrl,
        sourceUrl: nextSourceUrl,
      });
      video.machineTube.externalPlaybackUrl = nextPlaybackUrl;
      video.machineTube.externalPlaybackHlsUrl = nextPlaybackHlsUrl;
      video.machineTube.externalThumbnailUrl = nextThumbnailUrl;
      video.machineTube.sourceUrl = nextSourceUrl;
      video.machineTube.lastSyncedAt = new Date().toISOString();
      video.machineTube.lastSyncError = null;
      changed = true;
      console.log(`[mt-node] sync: video ${video.machineTube.videoId} — origin refreshed ok`);
    } catch (error) {
      video.machineTube.lastSyncError = formatError(error);
      changed = true;
      console.error(`[mt-node] sync: video ${video.machineTube.videoId} — origin refresh failed: ${formatError(error)}`);
    }
  }

  if (changed) {
    persistVideos();
  }
}

function resolvePublishIntent(value: unknown, credentials: MachineTubeCredentials): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return hasCompleteMachineTubeCredentials(credentials);
}

function resolveMachineTubeCredentials(
  overrideValue: unknown,
  fallback: MachineTubeCredentials,
): { ok: true; credentials: MachineTubeCredentials } | { ok: false; error: string } {
  const override = parseMachineTubeCredentialOverride(overrideValue);
  const credentials: MachineTubeCredentials = {
    baseUrl: override.baseUrl || fallback.baseUrl,
    agentId: override.agentId || fallback.agentId,
    apiKey: override.apiKey || fallback.apiKey,
  };

  if (!hasCompleteMachineTubeCredentials(credentials)) {
    return {
      ok: false,
      error: "MachineTube credentials are incomplete. Set baseUrl, agentId, and apiKey in mt-node config or the publish request.",
    };
  }

  return {
    ok: true,
    credentials: {
      baseUrl: normalizeBaseUrl(credentials.baseUrl),
      agentId: credentials.agentId.trim(),
      apiKey: credentials.apiKey.trim(),
    },
  };
}

function parseMachineTubeCredentialOverride(value: unknown): MachineTubeCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { baseUrl: "", agentId: "", apiKey: "" };
  }

  const record = value as JsonRecord;
  return {
    baseUrl: normalizeOptionalString(record.baseUrl) ?? "",
    agentId: normalizeOptionalString(record.agentId) ?? "",
    apiKey: normalizeOptionalString(record.apiKey) ?? "",
  };
}

function hasCompleteMachineTubeCredentials(credentials: MachineTubeCredentials): boolean {
  return Boolean(credentials.baseUrl.trim() && credentials.agentId.trim() && credentials.apiKey.trim());
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : "")).filter(Boolean))];
}

function loadOrCreateConfig(path: string, initialValue: MtNodeConfig): MtNodeConfig {
  const parsed = loadOrCreateJson<JsonRecord>(path, initialValue as unknown as JsonRecord);
  const parsedApi = parsed.api as JsonRecord | undefined;
  const parsedMachineTube = parsed.machineTube as JsonRecord | undefined;

  const normalized: MtNodeConfig = {
    nodeId: normalizeOptionalString(parsed.nodeId) ?? initialValue.nodeId,
    api: {
      host: normalizeOptionalString(parsedApi?.host) ?? initialValue.api.host,
      port: parseNumber(String(parsedApi?.port ?? initialValue.api.port), initialValue.api.port),
    },
    machineTube: {
      baseUrl: normalizeOptionalString(parsedMachineTube?.baseUrl) ?? initialValue.machineTube.baseUrl,
      agentId: normalizeOptionalString(parsedMachineTube?.agentId) ?? initialValue.machineTube.agentId,
      apiKey: normalizeOptionalString(parsedMachineTube?.apiKey) ?? initialValue.machineTube.apiKey,
    },
    createdAt: normalizeOptionalString(parsed.createdAt) ?? initialValue.createdAt,
  };

  writeFileSync(path, JSON.stringify(normalized, null, 2));
  return normalized;
}

function loadOrCreateVideos(path: string): RegisteredVideo[] {
  const parsed = loadOrCreateJson<unknown[]>(path, []);
  const videosList = Array.isArray(parsed) ? parsed : [];
  const normalized = videosList.map((entry) => normalizeRegisteredVideo(entry)).filter((entry): entry is RegisteredVideo => entry !== null);
  writeFileSync(path, JSON.stringify(normalized, null, 2));
  return normalized;
}

function normalizeRegisteredVideo(value: unknown): RegisteredVideo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as JsonRecord;
  const filePath = normalizeOptionalString(record.filePath);
  const fileName = normalizeOptionalString(record.fileName);
  const mimeType = normalizeOptionalString(record.mimeType);
  const createdAt = normalizeOptionalString(record.createdAt);
  const bytes = Number(record.bytes);
  if (!filePath || !fileName || !mimeType || !createdAt || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }

  const machineTube = record.machineTube as JsonRecord | undefined;
  const outputs = record.outputs as JsonRecord | undefined;
  const thumbnail = outputs?.thumbnail as JsonRecord | undefined;
  const hls = outputs?.hls as JsonRecord | undefined;
  const hlsPlaylist = hls?.playlist as JsonRecord | undefined;
  const hlsFiles = Array.isArray(hls?.files)
    ? hls.files
        .map((file) => normalizeGeneratedHlsFile(file))
        .filter((file): file is GeneratedHlsFile => file !== null)
    : [];

  return {
    id: normalizeOptionalString(record.id) ?? createId("vid"),
    filePath,
    fileName,
    mimeType,
    bytes,
    createdAt,
    outputs: {
      probe: normalizeVideoProbe(outputs?.probe),
      thumbnail: normalizeGeneratedAsset(thumbnail),
      hls:
        hlsPlaylist && hlsFiles.length > 0
          ? {
              rootDirectory: normalizeOptionalString(hls?.rootDirectory) ?? dirname(normalizeOptionalString(hlsPlaylist.localPath) ?? ""),
              playlist: normalizeGeneratedHlsFile(hlsPlaylist) ?? hlsFiles[0],
              files: hlsFiles,
              generatedAt: normalizeOptionalString(hls?.generatedAt) ?? normalizeOptionalString(outputs?.lastPreparedAt) ?? createdAt,
            }
          : null,
      lastPreparedAt: normalizeOptionalString(outputs?.lastPreparedAt),
      lastPreparationError: normalizeOptionalString(outputs?.lastPreparationError),
    },
    machineTube: {
      lastPublishedAt: normalizeOptionalString(machineTube?.lastPublishedAt),
      lastSyncedAt: normalizeOptionalString(machineTube?.lastSyncedAt),
      lastSyncError: normalizeOptionalString(machineTube?.lastSyncError),
      videoId: normalizeOptionalString(machineTube?.videoId),
      watchUrl: normalizeOptionalString(machineTube?.watchUrl),
      status: normalizeOptionalString(machineTube?.status),
      title: normalizeOptionalString(machineTube?.title),
      externalPlaybackUrl: normalizeOptionalString(machineTube?.externalPlaybackUrl),
      externalPlaybackHlsUrl: normalizeOptionalString(machineTube?.externalPlaybackHlsUrl),
      externalThumbnailUrl: normalizeOptionalString(machineTube?.externalThumbnailUrl),
      sourceUrl: normalizeOptionalString(machineTube?.sourceUrl),
    },
  };
}

function normalizeVideoProbe(value: unknown): VideoProbe | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as JsonRecord;
  const durationSeconds = Number(record.durationSeconds);
  const width = record.width === null || record.width === undefined ? null : Number(record.width);
  const height = record.height === null || record.height === undefined ? null : Number(record.height);

  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    return null;
  }

  return {
    durationSeconds,
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null,
  };
}

function normalizeGeneratedAsset(value: unknown): GeneratedAsset | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as JsonRecord;
  const localPath = normalizeOptionalString(record.localPath);
  const mimeType = normalizeOptionalString(record.mimeType);
  const generatedAt = normalizeOptionalString(record.generatedAt);
  const bytes = Number(record.bytes);
  if (!localPath || !mimeType || !generatedAt || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }

  return {
    localPath,
    mimeType,
    generatedAt,
    bytes,
  };
}

function normalizeGeneratedHlsFile(value: unknown): GeneratedHlsFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as JsonRecord;
  const localPath = normalizeOptionalString(record.localPath);
  const relativePath = normalizeOptionalString(record.relativePath);
  const mimeType = normalizeOptionalString(record.mimeType) ?? (localPath ? guessMimeType(localPath) : null);
  const bytes = Number(record.bytes);
  if (!localPath || !relativePath || !mimeType || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }

  return {
    localPath,
    relativePath,
    mimeType,
    bytes,
  };
}

function countPublishedMachineTubeVideos(): number {
  return videos.filter((video) => Boolean(video.machineTube.videoId)).length;
}

function buildHeartbeatPayload(req: IncomingMessage): JsonRecord {
  const tunnel = tunnelManager.getSnapshot();
  const heartbeatUrl = tunnel.publicBaseUrl ? `${tunnel.publicBaseUrl}/heartbeat` : buildLocalUrl(req, "/heartbeat");
  const originHealthUrl = tunnel.publicBaseUrl ? `${tunnel.publicBaseUrl}/origin-health` : buildLocalUrl(req, "/origin-health");

  return {
    nodeId: config.nodeId,
    status: "live",
    version: "0.1.0",
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    heartbeatUrl,
    originHealthUrl,
    publicBaseUrl: tunnel.publicBaseUrl,
    tunnel,
    inbox: {
      availability: evaluateInboxAvailability(paths.inboxDir, runtimeEnvironment),
      availableFiles: listInboxFiles(),
    },
    machineTube: {
      configured: hasCompleteMachineTubeCredentials(config.machineTube),
      baseUrl: config.machineTube.baseUrl || null,
      agentId: config.machineTube.agentId || null,
    },
    publishedVideos: videos
      .filter((video) => Boolean(video.machineTube.videoId))
      .map((video) => {
        const response = toVideoResponse(video, req);
        return {
          localVideoId: video.id,
          machineTubeVideoId: video.machineTube.videoId,
          machineTubeWatchUrl: video.machineTube.watchUrl,
          playbackUrl: response.playbackUrl,
          hlsPlaybackUrl: response.hlsPlaybackUrl,
          thumbnailUrl: response.thumbnailUrl,
          title: video.machineTube.title ?? video.fileName,
          lastPublishedAt: video.machineTube.lastPublishedAt,
          machineTubeStatus: video.machineTube.status,
        };
      }),
  };
}

function buildOriginHealthPayload(req: IncomingMessage): JsonRecord {
  const tunnel = tunnelManager.getSnapshot();
  const checkedAt = new Date().toISOString();

  return {
    nodeId: config.nodeId,
    checkedAt,
    tunnelStatus: tunnel.status,
    publicBaseUrl: tunnel.publicBaseUrl,
    videos: videos.map((video) => {
      const response = toVideoResponse(video, req);
      const filePresent = existsSync(video.filePath);
      const reachable = filePresent && Boolean(tunnel.publicBaseUrl);

      return {
        localVideoId: video.id,
        machineTubeVideoId: video.machineTube.videoId,
        playbackUrl: response.playbackUrl,
        hlsPlaybackUrl: response.hlsPlaybackUrl,
        thumbnailUrl: response.thumbnailUrl,
        filePresent,
        originStatus: reachable ? "reachable" : "degraded",
        lastPublishedAt: video.machineTube.lastPublishedAt,
        lastPreparationError: video.outputs.lastPreparationError,
      };
    }),
  };
}

function serveVideo(req: IncomingMessage, res: ServerResponse<IncomingMessage>, video: RegisteredVideo): void {
  const fileStat = statSync(video.filePath);
  const totalBytes = fileStat.size;
  const rangeHeader = req.headers.range;
  const etag = `W/\"${totalBytes}-${fileStat.mtimeMs}\"`;

  if (!rangeHeader) {
    res.writeHead(200, {
      "Content-Type": video.mimeType,
      "Content-Length": totalBytes,
      "Accept-Ranges": "bytes",
      ETag: etag,
      "Cache-Control": "public, max-age=60",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(video.filePath).pipe(res);
    return;
  }

  const parsedRange = parseRange(rangeHeader, totalBytes);
  if (!parsedRange) {
    res.writeHead(416, {
      "Content-Range": `bytes */${totalBytes}`,
      "Accept-Ranges": "bytes",
    });
    res.end();
    return;
  }

  const { start, end } = parsedRange;
  const chunkSize = end - start + 1;
  res.writeHead(206, {
    "Content-Type": video.mimeType,
    "Content-Length": chunkSize,
    "Content-Range": `bytes ${start}-${end}/${totalBytes}`,
    "Accept-Ranges": "bytes",
    ETag: etag,
    "Cache-Control": "public, max-age=60",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(video.filePath, { start, end }).pipe(res);
}

function serveStaticAsset(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  asset: GeneratedAsset | GeneratedHlsFile,
): void {
  const fileStat = statSync(asset.localPath);
  res.writeHead(200, {
    "Content-Type": asset.mimeType,
    "Content-Length": fileStat.size,
    "Cache-Control": asset.mimeType === "application/vnd.apple.mpegurl" ? "no-store" : "public, max-age=60",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(asset.localPath).pipe(res);
}

function parseRange(header: string, totalBytes: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) {
    return null;
  }

  const [, startRaw, endRaw] = match;
  let start = startRaw === "" ? Number.NaN : Number.parseInt(startRaw, 10);
  let end = endRaw === "" ? Number.NaN : Number.parseInt(endRaw, 10);

  if (Number.isNaN(start) && Number.isNaN(end)) {
    return null;
  }

  if (Number.isNaN(start)) {
    const suffixLength = end;
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(totalBytes - suffixLength, 0);
    end = totalBytes - 1;
  } else {
    if (start < 0 || start >= totalBytes) {
      return null;
    }
    if (Number.isNaN(end) || end >= totalBytes) {
      end = totalBytes - 1;
    }
    if (end < start) {
      return null;
    }
  }

  return { start, end };
}

function guessMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".m3u8":
      return "application/vnd.apple.mpegurl";
    case ".mp4":
      return "video/mp4";
    case ".m4v":
      return "video/x-m4v";
    case ".ts":
      return "video/mp2t";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    case ".mov":
      return "video/quicktime";
    default:
      return "application/octet-stream";
  }
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function parseTunnelMode(value: string | undefined): TunnelMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "docker" || normalized === "binary") {
    return normalized;
  }
  return "binary";
}

function defaultTunnelTargetUrl(mode: TunnelMode, localPort: number): string {
  if (mode === "docker") {
    return `http://host.docker.internal:${localPort}`;
  }
  return `http://127.0.0.1:${localPort}`;
}

function defaultInboxDir(): string {
  const homeDir = process.env.USERPROFILE?.trim() || process.env.HOME?.trim();
  if (!homeDir) {
    return resolve(process.cwd(), "MachineTube", "videos");
  }
  return resolve(homeDir, "MachineTube", "videos");
}

function detectRuntimeEnvironment(): RuntimeEnvironment {
  const cgroup = process.platform === "linux" ? safeReadText("/proc/1/cgroup") : "";
  return {
    platform: process.platform,
    dockerLikely:
      process.platform === "linux" &&
      (existsSync("/.dockerenv") || cgroup.includes("docker") || cgroup.includes("containerd") || cgroup.includes("kubepods")),
  };
}

function evaluateInboxAvailability(directory: string, environment: RuntimeEnvironment): InboxAvailability {
  if (!environment.dockerLikely) {
    return {
      directory,
      mode: "host-local",
      usableForHumanDrop: true,
      message: "Inbox folder is local to this machine and ready for direct file drop.",
      mountPoint: null,
      mountSource: null,
    };
  }

  const mount = findBestMountInfo(directory);
  if (!mount || mount.fsType === "overlay") {
    return {
      directory,
      mode: "container-local",
      usableForHumanDrop: false,
      message: `mt-node is running in Docker and ${directory} is not backed by a host bind mount. Mount a host folder here so humans can drop videos locally without entering the container.`,
      mountPoint: mount?.mountPoint ?? null,
      mountSource: mount?.mountSource ?? null,
    };
  }

  if (mount.mountSource.startsWith("/var/lib/docker/volumes/")) {
    return {
      directory,
      mode: "docker-volume",
      usableForHumanDrop: false,
      message: `mt-node inbox ${directory} is backed by a Docker volume, not a host bind mount. Use a host folder mount so humans can drop videos locally from the machine.`,
      mountPoint: mount.mountPoint,
      mountSource: mount.mountSource,
    };
  }

  return {
    directory,
    mode: "host-bind",
    usableForHumanDrop: true,
    message: "Inbox folder is Docker-mounted from the host and ready for local file drop.",
    mountPoint: mount.mountPoint,
    mountSource: mount.mountSource,
  };
}

function findBestMountInfo(targetDirectory: string): { mountPoint: string; mountSource: string; fsType: string } | null {
  if (process.platform !== "linux") {
    return null;
  }

  const raw = safeReadText("/proc/self/mountinfo");
  if (!raw) {
    return null;
  }

  const normalizedTarget = normalizeMountPath(targetDirectory);
  let bestMatch: { mountPoint: string; mountSource: string; fsType: string } | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const parts = line.split(" - ");
    if (parts.length !== 2) {
      continue;
    }

    const left = parts[0].split(" ");
    const right = parts[1].split(" ");
    const mountPoint = normalizeMountPath(decodeMountInfoValue(left[4] ?? ""));
    const mountSource = decodeMountInfoValue(right[1] ?? "");
    const fsType = right[0] ?? "";

    if (!pathContains(normalizedTarget, mountPoint)) {
      continue;
    }

    if (!bestMatch || mountPoint.length > bestMatch.mountPoint.length) {
      bestMatch = { mountPoint, mountSource, fsType };
    }
  }

  return bestMatch;
}

function normalizeMountPath(value: string): string {
  return resolve(value).replace(/\\/g, "/");
}

function pathContains(target: string, candidatePrefix: string): boolean {
  return target === candidatePrefix || target.startsWith(`${candidatePrefix}/`);
}

function decodeMountInfoValue(value: string): string {
  return value
    .replace(/\\040/g, " ")
    .replace(/\\011/g, "\t")
    .replace(/\\012/g, "\n")
    .replace(/\\134/g, "\\");
}

function safeReadText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function canRunExecutable(command: string, args: string[]): boolean {
  try {
    const result = spawnSync(command, args, {
      stdio: "ignore",
      shell: false,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function resolveExecutableOnPath(platformFileName: string, fallbackCommand: string): string | null {
  const locator = process.platform === "win32" ? "where" : "which";
  const query = process.platform === "win32" ? platformFileName : fallbackCommand;

  try {
    const result = spawnSync(locator, [query], {
      stdio: "pipe",
      encoding: "utf8",
      shell: false,
    });
    if (result.error || result.status !== 0) {
      return null;
    }

    const firstLine = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    return firstLine ? resolve(firstLine) : null;
  } catch {
    return null;
  }
}

function extractArchive(path: string, destination: string, archiveType: "zip" | "tar.xz"): void {
  const tarResult = spawnSync("tar", ["-xf", path, "-C", destination], {
    stdio: "ignore",
    shell: false,
  });
  if (!tarResult.error && tarResult.status === 0) {
    return;
  }

  if (process.platform === "win32" && archiveType === "zip") {
    const psResult = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${path.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`],
      {
        stdio: "ignore",
        shell: false,
      },
    );
    if (!psResult.error && psResult.status === 0) {
      return;
    }
  }

  throw new Error(`Failed to extract archive ${path}. Ensure tar is available on this system.`);
}

function findFileRecursive(root: string, fileName: string): string | null {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(root, entry.name);
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

function managedMediaToolFileName(tool: "ffmpeg" | "ffprobe", platform: NodeJS.Platform): string {
  return platform === "win32" ? `${tool}.exe` : tool;
}

function resolveMediaToolsDownloadAsset(
  platform: NodeJS.Platform,
  arch: string,
): { url: string; archiveFileName: string; archiveType: "zip" | "tar.xz" } {
  const base = "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download";

  if (platform === "win32") {
    if (arch === "x64") {
      return {
        url: `${base}/ffmpeg-master-latest-win64-gpl.zip`,
        archiveFileName: "ffmpeg-master-latest-win64-gpl.zip",
        archiveType: "zip",
      };
    }
    if (arch === "arm64") {
      return {
        url: `${base}/ffmpeg-master-latest-winarm64-gpl.zip`,
        archiveFileName: "ffmpeg-master-latest-winarm64-gpl.zip",
        archiveType: "zip",
      };
    }
  }

  if (platform === "linux") {
    if (arch === "x64") {
      return {
        url: `${base}/ffmpeg-master-latest-linux64-gpl.tar.xz`,
        archiveFileName: "ffmpeg-master-latest-linux64-gpl.tar.xz",
        archiveType: "tar.xz",
      };
    }
    if (arch === "arm64") {
      return {
        url: `${base}/ffmpeg-master-latest-linuxarm64-gpl.tar.xz`,
        archiveFileName: "ffmpeg-master-latest-linuxarm64-gpl.tar.xz",
        archiveType: "tar.xz",
      };
    }
  }

  throw new Error(`Managed FFmpeg bootstrap is not implemented for ${platform}/${arch}.`);
}

function managedCloudflaredFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function resolveCloudflaredCandidatePath(configuredPath: string, managedPath: string): string {
  if (configuredPath && configuredPath !== "cloudflared") {
    return resolve(configuredPath);
  }
  if (existsSync(managedPath)) {
    return managedPath;
  }
  return configuredPath || "cloudflared";
}

function resolveCloudflaredDownloadAsset(platform: NodeJS.Platform, arch: string): { url: string } {
  const base = "https://github.com/cloudflare/cloudflared/releases/latest/download/";

  if (platform === "win32") {
    if (arch === "x64") {
      return { url: `${base}cloudflared-windows-amd64.exe` };
    }
    if (arch === "ia32") {
      return { url: `${base}cloudflared-windows-386.exe` };
    }
    if (arch === "arm64") {
      return { url: `${base}cloudflared-windows-arm64.exe` };
    }
  }

  if (platform === "linux") {
    if (arch === "x64") {
      return { url: `${base}cloudflared-linux-amd64` };
    }
    if (arch === "ia32") {
      return { url: `${base}cloudflared-linux-386` };
    }
    if (arch === "arm64") {
      return { url: `${base}cloudflared-linux-arm64` };
    }
    if (arch === "arm") {
      return { url: `${base}cloudflared-linux-arm` };
    }
  }

  throw new Error(`Managed cloudflared bootstrap is not implemented for ${platform}/${arch}.`);
}

function ensureExecutable(path: string): void {
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o755);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code !== "EPERM" && code !== "EROFS" && code !== "EINVAL") {
        throw error;
      }
    }
  }
}

function loadOrCreateJson<T>(path: string, initialValue: T): T {
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch (error) {
      throw new Error(`Failed to read file at ${path}: ${formatError(error)}`);
    }
  }

  writeFileSync(path, JSON.stringify(initialValue, null, 2));
  return initialValue;
}

function createId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}

async function readJsonBody(req: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    return {};
  }
  const parsed = JSON.parse(rawBody) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as JsonRecord;
}

function sendJson(res: ServerResponse<IncomingMessage>, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function extractCloudflareUrl(text: string): string | null {
  const match = text.match(/https:\/\/[a-zA-Z0-9.-]+trycloudflare\.com/);
  return match ? match[0] : null;
}

function tryParseJson(raw: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonRecord;
    }
    return null;
  } catch {
    return null;
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
