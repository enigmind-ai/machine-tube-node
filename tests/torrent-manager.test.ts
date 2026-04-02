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
  const seedOptsLog: { urlList?: string[] }[] = [];

  const manager = new TorrentManager({
    mode: "assist",
    trackers: ["wss://tracker.example/announce"],
    clientLoader: async () => ({
      browserPeerCompatible: true,
      Constructor: class FakeClient {
        seed(input: string, opts: { urlList?: string[] }, onSeed: (torrent: any) => void) {
          seedCalls += 1;
          seedOptsLog.push(opts);
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

  const playbackUrl = "https://origin.example/media/sample.mp4";
  const persisted = await manager.ensureSeed({
    videoId: "vid_123",
    filePath: "/videos/sample.mp4",
    fileSignature: "1024:123",
    displayName: "sample.mp4",
    playbackUrl,
  });

  assert.equal(seedCalls, 1);
  assert.deepEqual(seedOptsLog[0]?.urlList, [playbackUrl]);
  assert.ok(persisted);
  assert.equal(persisted?.infoHash, "0123456789abcdef0123456789abcdef01234567");

  const snapshot = manager.getSnapshot({
    videoId: "vid_123",
    displayName: "sample.mp4",
    playbackUrl,
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

test("TorrentManager only exposes torrentFileUrl when torrent bytes match advertised web seed", async () => {
  let seedCalls = 0;
  let completeSecondSeed: (() => void) | null = null;

  const manager = new TorrentManager({
    mode: "assist",
    trackers: ["wss://tracker.example/announce"],
    clientLoader: async () => ({
      browserPeerCompatible: true,
      Constructor: class FakeClient {
        seed(_input: string, _opts: { urlList?: string[] }, onSeed: (torrent: any) => void) {
          seedCalls += 1;
          const torrent = {
            infoHash:
              seedCalls === 1
                ? "1111111111111111111111111111111111111111"
                : "2222222222222222222222222222222222222222",
            numPeers: 0,
            torrentFile: new Uint8Array([seedCalls]),
            on() {},
            destroy() {},
          };
          if (seedCalls === 2) {
            completeSecondSeed = () => queueMicrotask(() => onSeed(torrent));
          } else {
            queueMicrotask(() => onSeed(torrent));
          }
          return torrent;
        }

        destroy(callback?: () => void) {
          callback?.();
        }
      },
    }),
  });

  await manager.warmup();

  const publicUrl = "https://origin.example/media/ws.mp4";
  const torrentFileUrl = "https://node.example/torrent/file";

  const persistedNoWs = await manager.ensureSeed({
    videoId: "vid_torrent_url",
    filePath: "/videos/ws.mp4",
    fileSignature: "t:1",
    displayName: "ws.mp4",
    playbackUrl: null,
  });
  assert.ok(persistedNoWs);

  const noWebSeed = manager.getSnapshot({
    videoId: "vid_torrent_url",
    displayName: "ws.mp4",
    playbackUrl: null,
    torrentFileUrl,
    persisted: persistedNoWs,
  });
  assert.equal(noWebSeed.torrentFileUrl, torrentFileUrl);

  const mismatched = manager.getSnapshot({
    videoId: "vid_torrent_url",
    displayName: "ws.mp4",
    playbackUrl: publicUrl,
    torrentFileUrl,
    persisted: persistedNoWs,
  });
  assert.equal(mismatched.torrentFileUrl, null);

  const localHttpPlayback = "http://127.0.0.1:8080/media/vid_torrent_url";
  const localHttpTorrentFile = "http://127.0.0.1:8080/videos/vid_torrent_url/torrent";
  const localHttpSnap = manager.getSnapshot({
    videoId: "vid_torrent_url",
    displayName: "ws.mp4",
    playbackUrl: localHttpPlayback,
    torrentFileUrl: localHttpTorrentFile,
    persisted: persistedNoWs,
  });
  assert.equal(localHttpSnap.torrentFileUrl, localHttpTorrentFile);

  const untrustedLoopbackSnap = manager.getSnapshot({
    videoId: "vid_torrent_url",
    displayName: "ws.mp4",
    playbackUrl: localHttpPlayback,
    torrentFileUrl: localHttpTorrentFile,
    persisted: persistedNoWs,
    trustPlaybackUrlForTrackerOnlyTorrentFile: false,
  });
  assert.equal(
    untrustedLoopbackSnap.torrentFileUrl,
    null,
    "loopback-looking playback URL must not unlock tracker-only torrent when Host trust is denied",
  );

  const lanHttpSnap = manager.getSnapshot({
    videoId: "vid_torrent_url",
    displayName: "ws.mp4",
    playbackUrl: "http://192.168.1.10:8080/media/vid_torrent_url",
    torrentFileUrl: "http://192.168.1.10:8080/videos/vid_torrent_url/torrent",
    persisted: persistedNoWs,
  });
  assert.equal(lanHttpSnap.torrentFileUrl, null, "non-loopback http must not expose tracker-only torrent file URL");

  const pReseed = manager.ensureSeed({
    videoId: "vid_torrent_url",
    filePath: "/videos/ws.mp4",
    fileSignature: "t:1",
    displayName: "ws.mp4",
    playbackUrl: publicUrl,
  });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(seedCalls, 2);
  assert.ok(completeSecondSeed);

  assert.deepEqual(
    manager.getTorrentFile("vid_torrent_url"),
    new Uint8Array([1]),
    "reseed should keep prior .torrent bytes until the seed callback runs",
  );

  const whilePending = manager.getSnapshot({
    videoId: "vid_torrent_url",
    displayName: "ws.mp4",
    playbackUrl: publicUrl,
    torrentFileUrl,
    persisted: persistedNoWs,
  });
  assert.equal(whilePending.torrentFileUrl, null);

  completeSecondSeed();
  const persistedAfter = await pReseed;
  assert.ok(persistedAfter);

  assert.deepEqual(manager.getTorrentFile("vid_torrent_url"), new Uint8Array([2]));

  const matched = manager.getSnapshot({
    videoId: "vid_torrent_url",
    displayName: "ws.mp4",
    playbackUrl: publicUrl,
    torrentFileUrl,
    persisted: persistedAfter,
  });
  assert.equal(matched.torrentFileUrl, torrentFileUrl);

  const snapshotNullInput = manager.getSnapshot({
    videoId: "vid_torrent_url",
    displayName: "ws.mp4",
    playbackUrl: null,
    torrentFileUrl,
    persisted: persistedAfter,
  });
  assert.equal(snapshotNullInput.torrentFileUrl, null);

  await manager.destroy();
});

test("TorrentManager routes announce diagnostics to live seed state during in-place reseed", async () => {
  let seedCalls = 0;
  type Ev = "warning" | "error";
  type Listener = (error: unknown) => void;
  let completeSecondSeed: (() => void) | null = null;
  let firstTorrent: { emit: (event: Ev, err: unknown) => void } | null = null;

  const manager = new TorrentManager({
    mode: "assist",
    trackers: ["wss://tracker.example/announce"],
    clientLoader: async () => ({
      browserPeerCompatible: true,
      Constructor: class FakeClient {
        seed(_input: string, _opts: unknown, onSeed: (torrent: any) => void) {
          seedCalls += 1;
          const buckets: Record<Ev, Listener[]> = { warning: [], error: [] };
          const torrent = {
            infoHash:
              seedCalls === 1
                ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            numPeers: 0,
            torrentFile: new Uint8Array([seedCalls]),
            on(event: string, fn: Listener) {
              if (event === "warning" || event === "error") {
                buckets[event as Ev].push(fn);
              }
            },
            removeAllListeners(event: string) {
              if (event === "warning" || event === "error") {
                buckets[event as Ev] = [];
              }
            },
            emit(event: Ev, err: unknown) {
              for (const fn of [...buckets[event]]) {
                fn(err);
              }
            },
            destroy() {},
          };
          if (seedCalls === 1) {
            firstTorrent = torrent;
            queueMicrotask(() => onSeed(torrent));
          } else {
            completeSecondSeed = () => queueMicrotask(() => onSeed(torrent));
          }
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
    videoId: "vid_reseed_diag",
    filePath: "/videos/reseed-diag.mp4",
    fileSignature: "rd:1",
    displayName: "reseed-diag.mp4",
    playbackUrl: "http://127.0.0.1:9/media/vid_reseed_diag",
  });
  assert.ok(persisted);

  const reseedPromise = manager.ensureSeed({
    videoId: "vid_reseed_diag",
    filePath: "/videos/reseed-diag.mp4",
    fileSignature: "rd:1",
    displayName: "reseed-diag.mp4",
    playbackUrl: "http://127.0.0.1:9/media/vid_reseed_diag2",
  });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(seedCalls, 2);
  assert.ok(completeSecondSeed);
  assert.ok(firstTorrent);

  firstTorrent!.emit("warning", new Error("announce failed during reseed"));

  const snapWhileReseeding = manager.getSnapshot({
    videoId: "vid_reseed_diag",
    displayName: "reseed-diag.mp4",
    playbackUrl: "http://127.0.0.1:9/media/vid_reseed_diag2",
    torrentFileUrl: null,
    persisted,
  });
  assert.match(String(snapWhileReseeding.lastAnnounceError ?? ""), /announce failed during reseed/i);

  completeSecondSeed!();
  await reseedPromise;
  await manager.destroy();
});

test("TorrentManager coalesces concurrent ensureSeed for the same playback target", async () => {
  let seedCalls = 0;

  const manager = new TorrentManager({
    mode: "assist",
    trackers: ["wss://tracker.example/announce"],
    clientLoader: async () => ({
      browserPeerCompatible: true,
      Constructor: class FakeClient {
        seed(_input: string, _opts: unknown, onSeed: (torrent: any) => void) {
          seedCalls += 1;
          const torrent = {
            infoHash: "0123456789abcdef0123456789abcdef01234567",
            numPeers: 0,
            on() {},
            destroy() {},
          };
          queueMicrotask(() => onSeed(torrent));
          return torrent;
        }

        destroy(callback?: () => void) {
          callback?.();
        }
      },
    }),
  });

  await manager.warmup();

  const playbackUrl = "https://origin.example/media/sample.mp4";
  const input = {
    videoId: "vid_coalesce",
    filePath: "/videos/sample.mp4",
    fileSignature: "c:1",
    displayName: "sample.mp4",
    playbackUrl,
  };

  const firstRound = [manager.ensureSeed(input), manager.ensureSeed(input)];
  const [a, b] = await Promise.all(firstRound);
  assert.equal(seedCalls, 1);
  assert.deepEqual(a, b);

  const urlA = "https://origin.example/media/old.mp4";
  const urlB = "https://origin.example/media/new.mp4";
  await manager.ensureSeed({
    videoId: "vid_coalesce_reseed",
    filePath: "/videos/reseed.mp4",
    fileSignature: "c:2",
    displayName: "reseed.mp4",
    playbackUrl: urlA,
  });
  assert.equal(seedCalls, 2);

  const secondRound = [
    manager.ensureSeed({
      videoId: "vid_coalesce_reseed",
      filePath: "/videos/reseed.mp4",
      fileSignature: "c:2",
      displayName: "reseed.mp4",
      playbackUrl: urlB,
    }),
    manager.ensureSeed({
      videoId: "vid_coalesce_reseed",
      filePath: "/videos/reseed.mp4",
      fileSignature: "c:2",
      displayName: "reseed.mp4",
      playbackUrl: urlB,
    }),
  ];
  const [x, y] = await Promise.all(secondRound);
  assert.equal(seedCalls, 3);
  assert.deepEqual(x, y);

  await manager.destroy();
});

test("TorrentManager resolves superseded ensureSeed promises instead of hanging", async () => {
  let seedCalls = 0;

  const manager = new TorrentManager({
    mode: "assist",
    trackers: ["wss://tracker.example/announce"],
    clientLoader: async () => ({
      browserPeerCompatible: true,
      Constructor: class FakeClient {
        seed(_input: string, _opts: unknown, onSeed: (torrent: any) => void) {
          seedCalls += 1;
          const torrent = {
            infoHash:
              seedCalls === 1
                ? "1111111111111111111111111111111111111111"
                : "2222222222222222222222222222222222222222",
            numPeers: 0,
            on() {},
            destroy() {},
          };
          if (seedCalls !== 1) {
            queueMicrotask(() => onSeed(torrent));
          }
          return torrent;
        }

        destroy(callback?: () => void) {
          callback?.();
        }
      },
    }),
  });

  await manager.warmup();

  const first = manager.ensureSeed({
    videoId: "vid_supersede",
    filePath: "/videos/a.mp4",
    fileSignature: "1:1",
    displayName: "a.mp4",
    playbackUrl: null,
  });

  await new Promise<void>((r) => queueMicrotask(r));

  const second = manager.ensureSeed({
    videoId: "vid_supersede",
    filePath: "/videos/a.mp4",
    fileSignature: "1:1",
    displayName: "a.mp4",
    playbackUrl: "https://origin.example/media/a.mp4",
  });

  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1, null);
  assert.ok(r2);
  assert.equal(r2?.infoHash, "2222222222222222222222222222222222222222");
  assert.equal(seedCalls, 2);

  await manager.destroy();
});

test("TorrentManager reseed uses new playback URL in seed urlList", async () => {
  let seedCalls = 0;
  const seedOptsLog: { urlList?: string[] }[] = [];

  const manager = new TorrentManager({
    mode: "assist",
    trackers: ["wss://tracker.example/announce"],
    clientLoader: async () => ({
      browserPeerCompatible: true,
      Constructor: class FakeClient {
        seed(_input: string, opts: { urlList?: string[] }, onSeed: (torrent: any) => void) {
          seedCalls += 1;
          seedOptsLog.push(opts);
          const infoHash =
            seedCalls === 1
              ? "1111111111111111111111111111111111111111"
              : "2222222222222222222222222222222222222222";
          const torrent = {
            infoHash,
            numPeers: 0,
            on() {},
            destroy() {},
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

  const urlA = "https://origin.example/media/old.mp4";
  const urlB = "https://origin.example/media/new.mp4";

  await manager.ensureSeed({
    videoId: "vid_reseed",
    filePath: "/videos/reseed.mp4",
    fileSignature: "s:1",
    displayName: "reseed.mp4",
    playbackUrl: urlA,
  });
  await manager.ensureSeed({
    videoId: "vid_reseed",
    filePath: "/videos/reseed.mp4",
    fileSignature: "s:1",
    displayName: "reseed.mp4",
    playbackUrl: urlB,
  });

  assert.equal(seedCalls, 2);
  assert.deepEqual(seedOptsLog[0]?.urlList, [urlA]);
  assert.deepEqual(seedOptsLog[1]?.urlList, [urlB]);

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

  const retryAfterTunnel = await manager.ensureSeed({
    videoId: "vid_limit_2",
    filePath: "/videos/two.mp4",
    fileSignature: "2:b",
    displayName: "two.mp4",
    playbackUrl: "https://origin.example/media/two.mp4",
  });
  assert.equal(retryAfterTunnel, null);
  assert.equal(seedCalls, 1, "capped placeholder retry must not start another client.seed");

  await manager.destroy();
});

test("TorrentManager counts pending seeds against max active torrents when client loads slowly", async () => {
  let unblockClient: () => void = () => {
    throw new Error("clientLoader was not invoked");
  };
  let seedCalls = 0;

  const manager = new TorrentManager({
    mode: "permanent",
    trackers: ["wss://tracker.example/announce"],
    maxActiveTorrents: 1,
    clientLoader: () =>
      new Promise((resolve) => {
        unblockClient = () => {
          resolve({
            browserPeerCompatible: true,
            Constructor: class FakeClient {
              seed(_input: string, _opts: unknown, onSeed: (torrent: any) => void) {
                seedCalls += 1;
                const torrent = {
                  infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  numPeers: 0,
                  on() {},
                  destroy() {},
                };
                queueMicrotask(() => onSeed(torrent));
                return torrent;
              }

              destroy(callback?: () => void) {
                callback?.();
              }
            },
          });
        };
      }),
  });

  const firstPromise = manager.ensureSeed({
    videoId: "vid_slow_cap_a",
    filePath: "/videos/slow-a.mp4",
    fileSignature: "s:1",
    displayName: "slow-a.mp4",
  });

  const secondResult = await manager.ensureSeed({
    videoId: "vid_slow_cap_b",
    filePath: "/videos/slow-b.mp4",
    fileSignature: "s:2",
    displayName: "slow-b.mp4",
  });

  assert.equal(secondResult, null);
  assert.equal(manager.getEngineSnapshot().activeSeedCount, 1, "pending start must count toward the cap before reseedHandle exists");

  unblockClient();
  const first = await firstPromise;
  assert.ok(first);
  assert.equal(seedCalls, 1);

  await manager.destroy();
});

test("TorrentManager skips client.seed when superseded while awaiting getClient", async () => {
  let unblockLoader: () => void = () => {
    throw new Error("clientLoader was not invoked");
  };
  let seedCalls = 0;

  const manager = new TorrentManager({
    mode: "permanent",
    trackers: ["wss://tracker.example/announce"],
    clientLoader: () =>
      new Promise((resolve) => {
        unblockLoader = () => {
          resolve({
            browserPeerCompatible: true,
            Constructor: class FakeClient {
              seed(_input: string, _opts: unknown, onSeed: (torrent: any) => void) {
                seedCalls += 1;
                const torrent = {
                  infoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                  numPeers: 0,
                  on() {},
                  destroy() {},
                };
                queueMicrotask(() => onSeed(torrent));
                return torrent;
              }

              destroy(callback?: () => void) {
                callback?.();
              }
            },
          });
        };
      }),
  });

  const firstPromise = manager.ensureSeed({
    videoId: "vid_sup_gc",
    filePath: "/videos/sup-gc.mp4",
    fileSignature: "g:1",
    displayName: "sup-gc.mp4",
    playbackUrl: null,
  });

  const secondPromise = manager.ensureSeed({
    videoId: "vid_sup_gc",
    filePath: "/videos/sup-gc.mp4",
    fileSignature: "g:1",
    displayName: "sup-gc.mp4",
    playbackUrl: "https://origin.example/media/sup-gc.mp4",
  });

  assert.equal(seedCalls, 0, "superseded createSeed must not run client.seed after getClient()");
  unblockLoader();
  const [firstOut, secondOut] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(seedCalls, 1);
  assert.equal(firstOut, null);
  assert.ok(secondOut);

  await manager.destroy();
});

test("TorrentManager blocks in-place reseed when it would exceed max active torrent handles", async () => {
  let seedCalls = 0;
  const manager = new TorrentManager({
    mode: "permanent",
    trackers: ["wss://tracker.example/announce"],
    maxActiveTorrents: 2,
    clientLoader: async () => ({
      browserPeerCompatible: true,
      Constructor: class FakeClient {
        seed(_input: string, _opts: unknown, onSeed: (torrent: any) => void) {
          seedCalls += 1;
          const torrent = {
            infoHash:
              seedCalls === 1
                ? "1111111111111111111111111111111111111111"
                : "2222222222222222222222222222222222222222",
            numPeers: 0,
            on() {},
            destroy() {},
          };
          queueMicrotask(() => onSeed(torrent));
          return torrent;
        }

        destroy(callback?: () => void) {
          callback?.();
        }
      },
    }),
  });

  await manager.warmup();

  await manager.ensureSeed({
    videoId: "vid_rs1",
    filePath: "/videos/rs1.mp4",
    fileSignature: "r:1",
    displayName: "rs1.mp4",
    playbackUrl: null,
  });
  await manager.ensureSeed({
    videoId: "vid_rs2",
    filePath: "/videos/rs2.mp4",
    fileSignature: "r:2",
    displayName: "rs2.mp4",
    playbackUrl: null,
  });
  assert.equal(seedCalls, 2);
  assert.equal(manager.getEngineSnapshot().activeSeedCount, 2);

  const beforeReseed = await manager.ensureSeed({
    videoId: "vid_rs1",
    filePath: "/videos/rs1.mp4",
    fileSignature: "r:1",
    displayName: "rs1.mp4",
    playbackUrl: null,
  });
  assert.ok(beforeReseed);

  const blockedReseed = await manager.ensureSeed({
    videoId: "vid_rs1",
    filePath: "/videos/rs1.mp4",
    fileSignature: "r:1",
    displayName: "rs1.mp4",
    playbackUrl: "https://origin.example/media/rs1.mp4",
  });
  assert.ok(blockedReseed);
  assert.equal(seedCalls, 2, "reseed must not start a second torrent handle while at the handle cap");

  const stillHealthy = manager.getSnapshot({
    videoId: "vid_rs1",
    displayName: "rs1.mp4",
    playbackUrl: null,
    torrentFileUrl: null,
    persisted: blockedReseed,
  });
  assert.equal(stillHealthy.status, "seeding");
  assert.equal(stillHealthy.lastError, null);

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
