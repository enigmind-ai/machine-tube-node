import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const mtNodeEntry = path.join(repoRoot, "src", "index.ts");

test("mt-node config init creates an auto-loaded config env file", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mt-node-config-cli-"));
  const envFile = path.join(tempRoot, "config.env");
  const dataDir = path.join(tempRoot, "data");

  try {
    const result = spawnSync("node", ["--import", "tsx", mtNodeEntry, "config", "init"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MT_NODE_ENV_FILE: envFile,
        MT_NODE_DATA_DIR: dataDir,
      },
      stdio: "pipe",
      encoding: "utf8",
    });

    if (result.error) {
      throw result.error;
    }

    assert.equal(result.status, 0, result.stderr);
    const contents = await readFile(envFile, "utf8");
    assert.match(contents, /MT_NODE_PEER_DELIVERY_MODE=assist/);
    assert.match(contents, /MT_MACHINETUBE_API_KEY=/);
    assert.match(result.stdout, /created config file/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
