import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

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
  machineTube: {
    lastPublishedAt: string | null;
    videoId: string | null;
    watchUrl: string | null;
    status: string | null;
    title: string | null;
  };
};

type RuntimePaths = {
  projectRoot: string;
  dataDir: string;
  configPath: string;
  videosPath: string;
  binDir: string;
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

type PublishRequestBody = {
  filePath?: unknown;
  title?: unknown;
  description?: unknown;
  tags?: unknown;
  sourceUrl?: unknown;
  transcript?: unknown;
  externalThumbnailUrl?: unknown;
  publishToMachineTube?: unknown;
  machineTube?: unknown;
};

type MachineTubePublishResult = {
  ok: true;
  videoId: string;
  status: string;
  watchUrl: string;
};

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
      this.snapshot = { ...this.snapshot, executablePath: explicitBinary, lastError: null };
      return { executablePath: explicitBinary, managed: false, downloadUrl: null };
    }

    if (existsSync(this.managedCloudflaredPath)) {
      ensureExecutable(this.managedCloudflaredPath);
      this.snapshot = { ...this.snapshot, executablePath: this.managedCloudflaredPath, lastError: null };
      return { executablePath: this.managedCloudflaredPath, managed: true, downloadUrl: null };
    }

    const asset = resolveCloudflaredDownloadAsset(process.platform, process.arch);
    mkdirSync(dirname(this.managedCloudflaredPath), { recursive: true });

    const response = await fetch(asset.url);
    if (!response.ok) {
      throw new Error(`Failed to download cloudflared from ${asset.url}: ${response.status} ${response.statusText}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(this.managedCloudflaredPath, bytes);
    ensureExecutable(this.managedCloudflaredPath);
    this.snapshot = { ...this.snapshot, executablePath: this.managedCloudflaredPath, lastError: null };
    return { executablePath: this.managedCloudflaredPath, managed: true, downloadUrl: asset.url };
  }

  private async startCloudflared(): Promise<TunnelSnapshot> {
    const command = this.mode === "binary" ? (await this.bootstrapBinary()).executablePath : "docker";
    const args =
      this.mode === "binary"
        ? ["tunnel", "--no-autoupdate", "--url", this.targetUrl]
        : ["run", "--rm", "cloudflare/cloudflared:latest", "tunnel", "--no-autoupdate", "--url", this.targetUrl];
 
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
  managedCloudflaredPath: resolve(
    process.env.MT_NODE_MANAGED_CLOUDFLARED_PATH ??
      resolve(process.env.MT_NODE_BIN_DIR ?? resolve(resolvedDataDir, "bin"), managedCloudflaredFileName(process.platform)),
  ),
};

const port = parseNumber(process.env.MT_NODE_PORT, 43110);
const host = process.env.MT_NODE_HOST?.trim() || "0.0.0.0";
const startedAt = new Date();

mkdirSync(paths.dataDir, { recursive: true });
mkdirSync(paths.binDir, { recursive: true });
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
        tunnel: tunnelManager.getSnapshot(),
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

    if (req.method === "POST" && url.pathname === "/videos/register") {
      const body = await readJsonBody(req);
      const filePath = typeof body.filePath === "string" ? body.filePath.trim() : "";
      if (!filePath) {
        return sendJson(res, 400, { ok: false, error: "filePath is required." });
      }

      const result = ensureRegisteredVideo(filePath);
      if (!result.ok) {
        return sendJson(res, result.status, { ok: false, error: result.error, ...(result.details ?? {}) });
      }

      await tunnelManager.ensureStarted().catch(() => undefined);
      return sendJson(res, result.created ? 201 : 200, { ok: true, video: toVideoResponse(result.video, req) });
    }

    if (req.method === "POST" && url.pathname === "/publish") {
      const body = (await readJsonBody(req)) as PublishRequestBody;
      const filePath = typeof body.filePath === "string" ? body.filePath.trim() : "";
      if (!filePath) {
        return sendJson(res, 400, { ok: false, error: "filePath is required." });
      }

      const registerResult = ensureRegisteredVideo(filePath);
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
      const publishToMachineTube = resolvePublishIntent(body.publishToMachineTube, config.machineTube);

      if (!publishToMachineTube) {
        return sendJson(res, registerResult.created ? 201 : 200, {
          ok: true,
          video: videoResponse,
          externalPlaybackUrl,
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

      const credentialsResult = resolveMachineTubeCredentials(body.machineTube, config.machineTube);
      if (!credentialsResult.ok) {
        return sendJson(res, 400, { ok: false, error: credentialsResult.error });
      }

      const publishResult = await publishExternalVideoToMachineTube({
        credentials: credentialsResult.credentials,
        externalPlaybackUrl,
        externalThumbnailUrl: normalizeOptionalString(body.externalThumbnailUrl),
        title,
        description: typeof body.description === "string" ? body.description.trim() : "",
        tags: normalizeTags(body.tags),
        sourceUrl: normalizeOptionalString(body.sourceUrl) ?? `${tunnel.publicBaseUrl}/heartbeat`,
        transcript: normalizeOptionalString(body.transcript),
      });

      video.machineTube = {
        lastPublishedAt: new Date().toISOString(),
        videoId: publishResult.videoId,
        watchUrl: publishResult.watchUrl,
        status: publishResult.status,
        title,
      };
      persistVideos();

      return sendJson(res, registerResult.created ? 201 : 200, {
        ok: true,
        video: toVideoResponse(video, req),
        externalPlaybackUrl,
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
      const videoId = decodeURIComponent(url.pathname.slice("/media/".length));
      const video = videos.find((item) => item.id === videoId);
      if (!video) {
        return sendJson(res, 404, { ok: false, error: "Video not found.", videoId });
      }
      return serveVideo(req, res, video);
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
  console.log(`[mt-node] listening on http://${host}:${port}`);
  console.log(`[mt-node] data dir: ${paths.dataDir}`);
  console.log(`[mt-node] config path: ${paths.configPath}`);
  console.log(`[mt-node] videos path: ${paths.videosPath}`);
  console.log(`[mt-node] managed cloudflared path: ${paths.managedCloudflaredPath}`);
  if (tunnelManager.getSnapshot().mode !== "off") {
    void tunnelManager.ensureStarted().catch((error) => {
      console.error(`[mt-node] tunnel start failed: ${formatError(error)}`);
    });
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    tunnelManager.stop();
    server.close(() => process.exit(0));
  });
}

function ensureRegisteredVideo(filePath: string):
  | { ok: true; video: RegisteredVideo; created: boolean }
  | { ok: false; status: number; error: string; details?: JsonRecord } {
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
    return { ok: true, video: existing, created: false };
  }

  const video: RegisteredVideo = {
    id: createId("vid"),
    filePath: absoluteFilePath,
    fileName: absoluteFilePath.split(/[\\/]/).pop() || "video",
    mimeType: guessMimeType(absoluteFilePath),
    bytes: fileStat.size,
    createdAt: new Date().toISOString(),
    machineTube: {
      lastPublishedAt: null,
      videoId: null,
      watchUrl: null,
      status: null,
      title: null,
    },
  };

  videos.push(video);
  persistVideos();
  return { ok: true, video, created: true };
}

function persistVideos(): void {
  writeFileSync(paths.videosPath, JSON.stringify(videos, null, 2));
}

function toVideoResponse(video: RegisteredVideo, req: IncomingMessage): JsonRecord {
  const publicBaseUrl = tunnelManager.getSnapshot().publicBaseUrl;
  return {
    id: video.id,
    filePath: video.filePath,
    fileName: video.fileName,
    mimeType: video.mimeType,
    bytes: video.bytes,
    createdAt: video.createdAt,
    playbackUrl: publicBaseUrl
      ? `${publicBaseUrl}/media/${encodeURIComponent(video.id)}`
      : buildLocalUrl(req, `/media/${encodeURIComponent(video.id)}`),
    statusUrl: buildLocalUrl(req, `/videos/${encodeURIComponent(video.id)}`),
    machineTube: video.machineTube,
  };
}

function buildLocalUrl(req: IncomingMessage, path: string): string {
  const hostHeader = req.headers.host ?? `localhost:${port}`;
  return `http://${hostHeader}${path}`;
}

async function publishExternalVideoToMachineTube(input: {
  credentials: MachineTubeCredentials;
  externalPlaybackUrl: string;
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
  return {
    id: normalizeOptionalString(record.id) ?? createId("vid"),
    filePath,
    fileName,
    mimeType,
    bytes,
    createdAt,
    machineTube: {
      lastPublishedAt: normalizeOptionalString(machineTube?.lastPublishedAt),
      videoId: normalizeOptionalString(machineTube?.videoId),
      watchUrl: normalizeOptionalString(machineTube?.watchUrl),
      status: normalizeOptionalString(machineTube?.status),
      title: normalizeOptionalString(machineTube?.title),
    },
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
        filePresent,
        originStatus: reachable ? "reachable" : "degraded",
        lastPublishedAt: video.machineTube.lastPublishedAt,
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
    case ".mp4":
      return "video/mp4";
    case ".m4v":
      return "video/x-m4v";
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
    chmodSync(path, 0o755);
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
