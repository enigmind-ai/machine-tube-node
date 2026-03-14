import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type MtNodeConfig = {
  nodeId: string;
  api: {
    host: string;
    port: number;
  };
  machineTube: {
    baseUrl: string;
    agentId: string;
  };
  createdAt: string;
};

type RegisteredVideo = {
  id: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  createdAt: string;
};

type RuntimePaths = {
  projectRoot: string;
  dataDir: string;
  configPath: string;
  videosPath: string;
};

type JsonRecord = Record<string, unknown>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const resolvedDataDir = resolve(process.env.MT_NODE_DATA_DIR ?? resolve(__dirname, "..", "data"));
const paths: RuntimePaths = {
  projectRoot: resolve(__dirname, ".."),
  dataDir: resolvedDataDir,
  configPath: resolve(process.env.MT_NODE_CONFIG_PATH ?? resolve(resolvedDataDir, "config.json")),
  videosPath: resolve(process.env.MT_NODE_VIDEOS_PATH ?? resolve(resolvedDataDir, "videos.json")),
};

const port = parsePort(process.env.MT_NODE_PORT, 43110);
const host = process.env.MT_NODE_HOST?.trim() || "0.0.0.0";
const startedAt = new Date();

mkdirSync(paths.dataDir, { recursive: true });
const config = loadOrCreateJson<MtNodeConfig>(paths.configPath, {
  nodeId: createId("mtn"),
  api: { host, port },
  machineTube: {
    baseUrl: process.env.MT_MACHINETUBE_BASE_URL?.trim() || "",
    agentId: process.env.MT_MACHINETUBE_AGENT_ID?.trim() || "",
  },
  createdAt: startedAt.toISOString(),
});
const videos = loadOrCreateJson<RegisteredVideo[]>(paths.videosPath, []);

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
      });
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

      const absoluteFilePath = resolve(filePath);
      if (!existsSync(absoluteFilePath)) {
        return sendJson(res, 404, { ok: false, error: "File does not exist.", filePath: absoluteFilePath });
      }

      const fileStat = statSync(absoluteFilePath);
      if (!fileStat.isFile()) {
        return sendJson(res, 400, { ok: false, error: "filePath must point to a file.", filePath: absoluteFilePath });
      }

      const existing = videos.find((video) => video.filePath === absoluteFilePath);
      if (existing) {
        return sendJson(res, 200, { ok: true, video: toVideoResponse(existing, req) });
      }

      const video: RegisteredVideo = {
        id: createId("vid"),
        filePath: absoluteFilePath,
        fileName: absoluteFilePath.split(/[\\/]/).pop() || "video",
        mimeType: guessMimeType(absoluteFilePath),
        bytes: fileStat.size,
        createdAt: new Date().toISOString(),
      };

      videos.push(video);
      persistVideos();
      return sendJson(res, 201, { ok: true, video: toVideoResponse(video, req) });
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
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

function persistVideos(): void {
  writeFileSync(paths.videosPath, JSON.stringify(videos, null, 2));
}

function toVideoResponse(video: RegisteredVideo, req: IncomingMessage): JsonRecord {
  return {
    id: video.id,
    filePath: video.filePath,
    fileName: video.fileName,
    mimeType: video.mimeType,
    bytes: video.bytes,
    createdAt: video.createdAt,
    playbackUrl: buildAbsoluteUrl(req, `/media/${encodeURIComponent(video.id)}`),
    statusUrl: buildAbsoluteUrl(req, `/videos/${encodeURIComponent(video.id)}`),
  };
}

function buildAbsoluteUrl(req: IncomingMessage, path: string): string {
  const hostHeader = req.headers.host ?? `localhost:${port}`;
  return `http://${hostHeader}${path}`;
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
  let start = startRaw === "" ? NaN : Number.parseInt(startRaw, 10);
  let end = endRaw === "" ? NaN : Number.parseInt(endRaw, 10);

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

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
    return parsed;
  }
  return fallback;
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

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}