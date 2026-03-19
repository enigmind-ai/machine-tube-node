import assert from "node:assert/strict";
import test from "node:test";
import { TorrentManager, buildMagnetUrl } from "../src/torrent.js";

test("buildMagnetUrl includes xt, dn, ws, and trackers", () => {
  assert.equal(
    buildMagnetUrl({
      infoHash: "0123456789abcdef0123456789abcdef01234567",
      displayName: "sample.mp4",
      webSeedUrl: "https://origin.example/media/sample.mp4",
      trackers: ["wss://tracker.example/announce"],
    }),
    "magnet:?xt=urn%3Abtih%3A0123456789abcdef0123456789abcdef01234567&dn=sample.mp4&ws=https%3A%2F%2Forigin.example%2Fmedia%2Fsample.mp4&tr=wss%3A%2F%2Ftracker.example%2Fannounce"
  );
});

test("TorrentManager seeds once and derives a runtime snapshot", async () => {
  let seedCalls = 0;

  const manager = new TorrentManager({
    mode: "assist",
    trackers: ["wss://tracker.example/announce"],
    clientLoader: async () => ({
      browserPeerCompatible: true,
      Constructor: class FakeClient {
        seed(input: string, _opts: unknown, onSeed: (torrent: any) => void) {
          seedCalls += 1;
          const torrent = {
            infoHash: "0123456789abcdef0123456789abcdef01234567",
            numPeers: 3,
            on() {
              // no-op
            },
            destroy() {
              // no-op
            },
          };

          queueMicrotask(() => {
            onSeed(torrent);
          });

          return torrent;
        }

        destroy(callback?: () => void) {
          callback?.();
        }
      },
    }),
  });

  const persisted = await manager.ensureSeed({
    videoId: "vid_123",
    filePath: "/videos/sample.mp4",
    fileSignature: "1024:123",
    displayName: "sample.mp4",
  });

  assert.equal(seedCalls, 1);
  assert.ok(persisted);
  assert.equal(persisted?.infoHash, "0123456789abcdef0123456789abcdef01234567");

  const snapshot = manager.getSnapshot({
    videoId: "vid_123",
    displayName: "sample.mp4",
    playbackUrl: "https://origin.example/media/sample.mp4",
    persisted,
  });

  assert.equal(snapshot.status, "seeding");
  assert.equal(snapshot.engine, "webtorrent");
  assert.equal(snapshot.browserPeerCompatible, true);
  assert.equal(snapshot.degradedReason, null);
  assert.equal(manager.getEngineSnapshot().mode, "assist");
  assert.equal(snapshot.lastSeedAttemptAt !== null, true);
  assert.equal(snapshot.lastSeedSuccessAt !== null, true);
  assert.equal(snapshot.announceErrorCount, 0);
  assert.equal(snapshot.peerCount, 3);
  assert.equal(snapshot.infoHash, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(
    snapshot.magnetUrl,
    "magnet:?xt=urn%3Abtih%3A0123456789abcdef0123456789abcdef01234567&dn=sample.mp4&ws=https%3A%2F%2Forigin.example%2Fmedia%2Fsample.mp4&tr=wss%3A%2F%2Ftracker.example%2Fannounce"
  );

  await manager.destroy();
});

test("TorrentManager enforces max active torrent guardrails", async () => {
  let seedCalls = 0;
  const manager = new TorrentManager({
    mode: "permanent",
    trackers: ["wss://tracker.example/announce"],
    maxActiveTorrents: 1,
    clientLoader: async () => ({
      browserPeerCompatible: true,
      Constructor: class FakeClient {
        seed(_input: string, _opts: unknown, onSeed: (torrent: any) => void) {
          seedCalls += 1;
          const torrent = {
            infoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            numPeers: 0,
            on() {
              // no-op
            },
            destroy() {
              // no-op
            },
          };

          queueMicrotask(() => {
            onSeed(torrent);
          });

          return torrent;
        }

        destroy(callback?: () => void) {
          callback?.();
        }
      },
    }),
  });

  const first = await manager.ensureSeed({
    videoId: "vid_limit_1",
    filePath: "/videos/one.mp4",
    fileSignature: "1:a",
    displayName: "one.mp4",
  });
  const second = await manager.ensureSeed({
    videoId: "vid_limit_2",
    filePath: "/videos/two.mp4",
    fileSignature: "2:b",
    displayName: "two.mp4",
  });

  const blocked = manager.getSnapshot({
    videoId: "vid_limit_2",
    displayName: "two.mp4",
    playbackUrl: "https://origin.example/media/two.mp4",
    persisted: second,
  });
  const engine = manager.getEngineSnapshot();

  assert.ok(first);
  assert.equal(second, null);
  assert.equal(seedCalls, 1);
  assert.match(String(blocked.lastError ?? ""), /max active torrents/i);
  assert.equal(engine.activeSeedCount, 1);
  assert.equal(engine.maxActiveTorrents, 1);

  await manager.destroy();
});

test("TorrentManager reports degraded browser delivery when trackers are not browser-compatible", async () => {
  const manager = new TorrentManager({
    mode: "permanent",
    trackers: ["udp://tracker.example:1337/announce"],
    clientLoader: async () => ({
      browserPeerCompatible: true,
      Constructor: class FakeClient {
        seed(_input: string, _opts: unknown, onSeed: (torrent: any) => void) {
          const torrent = {
            infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            numPeers: 0,
            on() {
              // no-op
            },
            destroy() {
              // no-op
            },
          };

          queueMicrotask(() => {
            onSeed(torrent);
          });

          return torrent;
        }

        destroy(callback?: () => void) {
          callback?.();
        }
      },
    }),
  });

  await manager.warmup();

  const persisted = await manager.ensureSeed({
    videoId: "vid_udp",
    filePath: "/videos/udp.mp4",
    fileSignature: "512:udp",
    displayName: "udp.mp4",
  });
  const snapshot = manager.getSnapshot({
    videoId: "vid_udp",
    displayName: "udp.mp4",
    playbackUrl: "https://origin.example/media/udp.mp4",
    persisted,
  });
  const engine = manager.getEngineSnapshot();

  assert.equal(engine.mode, "permanent");
  assert.equal(engine.runtimeChecked, true);
  assert.equal(engine.hasBrowserCompatibleTrackers, false);
  assert.equal(snapshot.engine, "webtorrent");
  assert.equal(snapshot.browserPeerCompatible, false);
  assert.match(String(snapshot.degradedReason ?? ""), /wss:\/\//i);
  assert.match(String(engine.degradedReason ?? ""), /wss:\/\//i);

  await manager.destroy();
});
