#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function defaultInboxDir() {
  const home = os.homedir();
  return path.resolve(home, "MachineTube", "videos");
}

function parseArgs(argv) {
  const result = {
    inboxDir: "",
    writeComposeOverride: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--inbox-dir") {
      result.inboxDir = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--write-compose-override") {
      result.writeComposeOverride = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
  }

  return result;
}

function escapeYamlSingleQuoted(value) {
  return value.replace(/'/g, "''");
}

function detectContainerInboxPath() {
  return "/home/node/MachineTube/videos";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inboxDir = path.resolve(args.inboxDir || defaultInboxDir());
  const containerInboxDir = detectContainerInboxPath();

  mkdirSync(inboxDir, { recursive: true });

  const composeVolumeLine = `      - '${escapeYamlSingleQuoted(inboxDir)}:${containerInboxDir}'`;
  const composeSnippet = [
    "services:",
    "  openclaw-gateway:",
    "    volumes:",
    composeVolumeLine,
  ].join("\n");

  if (args.writeComposeOverride) {
    const overridePath = path.resolve(args.writeComposeOverride);
    writeFileSync(overridePath, `${composeSnippet}\n`, "utf8");
    console.log(`Wrote OpenClaw compose override to: ${overridePath}`);
  }

  console.log("MachineTube inbox setup complete.");
  console.log("");
  console.log(`Host inbox folder: ${inboxDir}`);
  console.log(`Container inbox path: ${containerInboxDir}`);
  console.log("");
  console.log("Drop videos into the host inbox folder, then recreate OpenClaw with this bind mount:");
  console.log("");
  console.log(composeSnippet);
  console.log("");
  console.log("docker run equivalent:");
  console.log(`  -v \"${inboxDir}:${containerInboxDir}\"`);
  console.log("");
  console.log("After recreating the container, the inbox-folder UX will work:");
  console.log("  Publish the latest video from my MachineTube folder.");
  console.log("  Publish demo-run-04.mp4 from my MachineTube folder.");
}

main();