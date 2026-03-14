import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

type RuntimePaths = {
  projectRoot: string;
  dataDir: string;
  configPath: string;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const paths: RuntimePaths = {
  projectRoot: resolve(__dirname, ".."),
  dataDir: resolve(process.env.MT_NODE_DATA_DIR ?? resolve(__dirname, "..", "data")),
  configPath: resolve(process.env.MT_NODE_CONFIG_PATH ?? resolve(process.env.MT_NODE_DATA_DIR ?? resolve(__dirname, "..", "data"), "config.json")),
};

const port = parsePort(process.env.MT_NODE_PORT, 43110);
const host = process.env.MT_NODE_HOST?.trim() || "0.0.0.0";
const startedAt = new Date();

mkdirSync(paths.dataDir, { recursive: true });
const config = loadOrCreateConfig(paths.configPath, {
  nodeId: createNodeId(),
  api: { host, port },
  machineTube: {
    baseUrl: process.env.MT_MACHINETUBE_BASE_URL?.trim() || "",
    agentId: process.env.MT_MACHINETUBE_AGENT_ID?.trim() || "",
  },
  createdAt: startedAt.toISOString(),
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

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
    });
  }

  return sendJson(res, 404, {
    ok: false,
    error: "Not found.",
    method: req.method,
    path: url.pathname,
  });
});

server.listen(port, host, () => {
  console.log(`[mt-node] listening on http://${host}:${port}`);
  console.log(`[mt-node] data dir: ${paths.dataDir}`);
  console.log(`[mt-node] config path: ${paths.configPath}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
    return parsed;
  }
  return fallback;
}

function loadOrCreateConfig(path: string, initialConfig: MtNodeConfig): MtNodeConfig {
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as MtNodeConfig;
    } catch (error) {
      throw new Error(`Failed to read config at ${path}: ${formatError(error)}`);
    }
  }

  writeFileSync(path, JSON.stringify(initialConfig, null, 2));
  return initialConfig;
}

function createNodeId(): string {
  return `mtn_${Math.random().toString(36).slice(2, 12)}`;
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