#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function defaultInboxDir() {
  return path.resolve(os.homedir(), "MachineTube", "videos");
}

function defaultDataDir() {
  return path.resolve(os.homedir(), ".machine-tube", "mt-node-docker-data");
}

function parseArgs(argv) {
  const result = {
    image: process.env.MT_NODE_IMAGE || "machine-tube-node:local",
    containerName: process.env.MT_NODE_CONTAINER_NAME || "mt-node",
    inboxDir: process.env.MT_NODE_INBOX_DIR || "",
    dataDir: process.env.MT_NODE_DOCKER_DATA_DIR || "",
    hostPort: process.env.MT_NODE_HOST_PORT || "43110",
    skipBuild: false,
    printOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--image") {
      result.image = argv[index + 1] ?? result.image;
      index += 1;
      continue;
    }
    if (arg === "--container-name") {
      result.containerName = argv[index + 1] ?? result.containerName;
      index += 1;
      continue;
    }
    if (arg === "--inbox-dir") {
      result.inboxDir = argv[index + 1] ?? result.inboxDir;
      index += 1;
      continue;
    }
    if (arg === "--data-dir") {
      result.dataDir = argv[index + 1] ?? result.dataDir;
      index += 1;
      continue;
    }
    if (arg === "--host-port") {
      result.hostPort = argv[index + 1] ?? result.hostPort;
      index += 1;
      continue;
    }
    if (arg === "--skip-build") {
      result.skipBuild = true;
      continue;
    }
    if (arg === "--print-only") {
      result.printOnly = true;
      continue;
    }
  }

  return result;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? "pipe" : "inherit",
    cwd: options.cwd,
    shell: false,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function ensureDocker() {
  const result = runCommand("docker", ["--version"], { capture: true });
  if (result.status !== 0) {
    throw new Error("Docker is required to run mt-node in a container.");
  }
}

function buildCommands(config, repoRoot) {
  const inboxDir = path.resolve(config.inboxDir || defaultInboxDir());
  const dataDir = path.resolve(config.dataDir || defaultDataDir());
  const hostPort = String(config.hostPort || "43110");
  const envArgs = [
    "-e", "MT_NODE_PORT=43110",
    "-e", "MT_NODE_DATA_DIR=/data",
    "-e", "MT_NODE_INBOX_DIR=/videos",
  ];

  for (const [key, value] of Object.entries({
    MT_MACHINETUBE_BASE_URL: process.env.MT_MACHINETUBE_BASE_URL,
    MT_MACHINETUBE_AGENT_ID: process.env.MT_MACHINETUBE_AGENT_ID,
    MT_MACHINETUBE_API_KEY: process.env.MT_MACHINETUBE_API_KEY,
    MT_NODE_TUNNEL_MODE: process.env.MT_NODE_TUNNEL_MODE,
    MT_NODE_TUNNEL_BIN: process.env.MT_NODE_TUNNEL_BIN,
    MT_NODE_PUBLIC_BASE_URL: process.env.MT_NODE_PUBLIC_BASE_URL,
    MT_NODE_TUNNEL_TARGET_URL: process.env.MT_NODE_TUNNEL_TARGET_URL,
  })) {
    if (typeof value === "string" && value.trim()) {
      envArgs.push("-e", `${key}=${value.trim()}`);
    }
  }

  const buildArgs = ["build", "-t", config.image, repoRoot];
  const removeArgs = ["rm", "-f", config.containerName];
  const runArgs = [
    "run",
    "-d",
    "--name", config.containerName,
    "-p", `${hostPort}:43110`,
    "-v", `${dataDir}:/data`,
    "-v", `${inboxDir}:/videos`,
    ...envArgs,
    config.image,
  ];

  return { inboxDir, dataDir, hostPort, buildArgs, removeArgs, runArgs };
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const config = parseArgs(process.argv.slice(2));
  const commands = buildCommands(config, repoRoot);

  mkdirSync(commands.inboxDir, { recursive: true });
  mkdirSync(commands.dataDir, { recursive: true });

  console.log("mt-node Docker launcher");
  console.log("");
  console.log(`Image: ${config.image}`);
  console.log(`Container: ${config.containerName}`);
  console.log(`Host inbox: ${commands.inboxDir}`);
  console.log(`Host data: ${commands.dataDir}`);
  console.log(`Host port: ${commands.hostPort}`);
  console.log("");

  if (config.printOnly) {
    console.log("docker build command:");
    console.log(`  docker ${commands.buildArgs.join(" ")}`);
    console.log("");
    console.log("docker run command:");
    console.log(`  docker ${commands.runArgs.join(" ")}`);
    return;
  }

  ensureDocker();

  if (!config.skipBuild) {
    const buildResult = runCommand("docker", commands.buildArgs, { cwd: repoRoot });
    if (buildResult.status !== 0) {
      process.exit(buildResult.status ?? 1);
    }
  }

  runCommand("docker", commands.removeArgs, { capture: true });
  const runResult = runCommand("docker", commands.runArgs, { cwd: repoRoot });
  if (runResult.status !== 0) {
    process.exit(runResult.status ?? 1);
  }

  console.log("");
  console.log("mt-node Docker container is running.");
  console.log(`Drop videos into: ${commands.inboxDir}`);
  console.log("OpenClaw can now use mt-node at:");
  console.log(`  http://host.docker.internal:${commands.hostPort}`);
}

main();
