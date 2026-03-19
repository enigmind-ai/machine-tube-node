const WEBTORRENT_MODULE = "webtorrent";

export const DEFAULT_WEBTORRENT_TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.webtorrent.dev",
];

type TorrentSeedOptions = {
  name?: string;
  announce?: string[];
};

type TorrentClientConstructor = new (opts?: Record<string, unknown>) => TorrentClient;

type TorrentClient = {
  seed(input: string, opts: TorrentSeedOptions, onSeed: (torrent: TorrentHandle) => void): TorrentHandle;
  destroy(callback?: (error?: Error | null) => void): void;
};

type TorrentHandle = {
  infoHash?: string;
  numPeers?: number;
  on(event: string, listener: (...args: unknown[]) => void): void;
  destroy(callback?: (error?: Error | null) => void): void;
};

type LoadedTorrentClient = {
  Constructor: TorrentClientConstructor;
  browserPeerCompatible: boolean;
};

export type PeerDeliveryMode = "off" | "assist" | "permanent";

export type PersistedTorrentOutput = {
  infoHash: string;
  trackerUrls: string[];
  seededAt: string;
  lastError: string | null;
  lastSeedAttemptAt: string | null;
  lastSeedSuccessAt: string | null;
  announceErrorCount: number;
  lastAnnounceError: string | null;
};

export type TorrentRuntimeSnapshot = {
  status: "disabled" | "pending" | "seeding" | "error";
  engine: "webtorrent" | null;
  browserPeerCompatible: boolean;
  degradedReason: string | null;
  infoHash: string | null;
  magnetUrl: string | null;
  trackerUrls: string[];
  peerCount: number;
  seededAt: string | null;
  seedUptimeSeconds: number | null;
  lastError: string | null;
  lastSeedAttemptAt: string | null;
  lastSeedSuccessAt: string | null;
  announceErrorCount: number;
  lastAnnounceError: string | null;
};

type ActiveSeedState = {
  videoId: string;
  filePath: string;
  fileSignature: string;
  displayName: string;
  trackerUrls: string[];
  seededAt: string | null;
  lastError: string | null;
  lastSeedAttemptAt: string | null;
  lastSeedSuccessAt: string | null;
  announceErrorCount: number;
  lastAnnounceError: string | null;
  torrent: TorrentHandle | null;
  pending: Promise<PersistedTorrentOutput | null> | null;
};

async function loadTorrentClient(): Promise<LoadedTorrentClient> {
  const imported = (await import(WEBTORRENT_MODULE)) as { default?: unknown };
  const constructorCandidate = imported.default ?? imported;
  if (typeof constructorCandidate !== "function") {
    throw new Error(`${WEBTORRENT_MODULE} did not export a client constructor.`);
  }

  return {
    Constructor: constructorCandidate as TorrentClientConstructor,
    browserPeerCompatible: true,
  };
}

export function buildMagnetUrl(input: {
  infoHash: string;
  displayName?: string | null;
  webSeedUrl?: string | null;
  trackers?: string[];
}): string {
  const params = new URLSearchParams();
  params.set("xt", `urn:btih:${input.infoHash}`);

  if (input.displayName) {
    params.set("dn", input.displayName);
  }

  if (input.webSeedUrl) {
    params.append("ws", input.webSeedUrl);
  }

  for (const tracker of input.trackers ?? []) {
    params.append("tr", tracker);
  }

  return `magnet:?${params.toString()}`;
}

export function parseTrackerList(value: string | undefined): string[] {
  if (!value) {
    return [...DEFAULT_WEBTORRENT_TRACKERS];
  }

  const trackers = value
    .split(/[,\r\n]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return trackers.length > 0 ? [...new Set(trackers)] : [...DEFAULT_WEBTORRENT_TRACKERS];
}

function isBrowserCompatibleTracker(tracker: string): boolean {
  return tracker.trim().toLowerCase().startsWith("wss://");
}

export class TorrentManager {
  private readonly mode: PeerDeliveryMode;
  private readonly enabled: boolean;
  private readonly trackers: string[];
  private readonly hasBrowserCompatibleTrackers: boolean;
  private readonly clientLoader: () => Promise<LoadedTorrentClient>;
  private readonly clientOptions: Record<string, unknown>;
  private readonly maxActiveTorrents: number | null;
  private readonly maxConnections: number | null;
  private readonly seeds = new Map<string, ActiveSeedState>();
  private client: TorrentClient | null = null;
  private clientPromise: Promise<TorrentClient> | null = null;
  private runtimeBrowserPeerCompatible = false;
  private browserPeerCompatible = false;
  private runtimeChecked = false;
  private startupError: string | null = null;

  constructor(input: {
    mode: PeerDeliveryMode;
    trackers: string[];
    clientLoader?: () => Promise<LoadedTorrentClient>;
    clientOptions?: Record<string, unknown>;
    maxActiveTorrents?: number | null;
    maxConnections?: number | null;
  }) {
    this.mode = input.mode;
    this.enabled = input.mode !== "off";
    this.trackers = [...new Set(input.trackers)];
    this.hasBrowserCompatibleTrackers = this.trackers.some((tracker) => isBrowserCompatibleTracker(tracker));
    this.clientLoader = input.clientLoader ?? loadTorrentClient;
    this.maxActiveTorrents =
      typeof input.maxActiveTorrents === "number" && Number.isFinite(input.maxActiveTorrents) && input.maxActiveTorrents > 0
        ? Math.floor(input.maxActiveTorrents)
        : null;
    this.maxConnections =
      typeof input.maxConnections === "number" && Number.isFinite(input.maxConnections) && input.maxConnections > 0
        ? Math.floor(input.maxConnections)
        : null;
    this.clientOptions = {
      ...(input.clientOptions ?? {}),
      ...(this.maxConnections ? { maxConns: this.maxConnections } : {}),
    };
  }

  async warmup(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    try {
      await this.getClient();
    } catch {
      // Snapshot methods expose startup failures as degraded state.
    }
  }

  async ensureSeed(input: {
    videoId: string;
    filePath: string;
    fileSignature: string;
    displayName: string;
  }): Promise<PersistedTorrentOutput | null> {
    if (!this.enabled) {
      return null;
    }

    const existing = this.seeds.get(input.videoId);
    if (
      existing &&
      existing.filePath === input.filePath &&
      existing.fileSignature === input.fileSignature &&
      existing.displayName === input.displayName &&
      existing.trackerUrls.join("\n") === this.trackers.join("\n")
    ) {
      if (existing.pending) {
        return existing.pending;
      }

      const persistedExisting = this.toPersistedOutput(existing);
      if (persistedExisting) {
        existing.lastError = null;
        return persistedExisting;
      }
    }

    if (!existing && this.maxActiveTorrents !== null && this.getActiveSeedCount() >= this.maxActiveTorrents) {
      const state: ActiveSeedState = {
        videoId: input.videoId,
        filePath: input.filePath,
        fileSignature: input.fileSignature,
        displayName: input.displayName,
        trackerUrls: [...this.trackers],
        seededAt: null,
        lastError: `Peer delivery skipped because max active torrents (${this.maxActiveTorrents}) has been reached.`,
        lastSeedAttemptAt: new Date().toISOString(),
        lastSeedSuccessAt: null,
        announceErrorCount: 1,
        lastAnnounceError: `Peer delivery skipped because max active torrents (${this.maxActiveTorrents}) has been reached.`,
        torrent: null,
        pending: null,
      };
      this.seeds.set(input.videoId, state);
      return null;
    }

    if (existing?.torrent) {
      existing.torrent.destroy();
    }

    const state: ActiveSeedState = {
      videoId: input.videoId,
      filePath: input.filePath,
      fileSignature: input.fileSignature,
      displayName: input.displayName,
      trackerUrls: [...this.trackers],
      seededAt: existing?.seededAt ?? null,
      lastError: null,
      lastSeedAttemptAt: existing?.lastSeedAttemptAt ?? null,
      lastSeedSuccessAt: existing?.lastSeedSuccessAt ?? null,
      announceErrorCount: existing?.announceErrorCount ?? 0,
      lastAnnounceError: existing?.lastAnnounceError ?? null,
      torrent: null,
      pending: null,
    };
    this.seeds.set(input.videoId, state);

    state.pending = this.createSeed(state);
    return state.pending;
  }

  getSnapshot(input: {
    videoId: string;
    displayName: string;
    playbackUrl: string | null;
    persisted: PersistedTorrentOutput | null;
  }): TorrentRuntimeSnapshot {
    if (!this.enabled) {
      return {
        status: "disabled",
        engine: null,
        browserPeerCompatible: false,
        degradedReason: null,
        infoHash: null,
        magnetUrl: null,
        trackerUrls: [],
        peerCount: 0,
        seededAt: null,
        seedUptimeSeconds: null,
        lastError: null,
        lastSeedAttemptAt: null,
        lastSeedSuccessAt: null,
        announceErrorCount: 0,
        lastAnnounceError: null,
      };
    }

    const state = this.seeds.get(input.videoId);
    const infoHash = state?.torrent?.infoHash ?? input.persisted?.infoHash ?? null;
    const trackerUrls = state?.trackerUrls ?? input.persisted?.trackerUrls ?? this.trackers;
    const peerCount = typeof state?.torrent?.numPeers === "number" ? state.torrent.numPeers : 0;
    const seededAt = state?.seededAt ?? input.persisted?.seededAt ?? null;
    const lastError = state?.lastError ?? input.persisted?.lastError ?? null;
    const lastSeedAttemptAt = state?.lastSeedAttemptAt ?? input.persisted?.lastSeedAttemptAt ?? null;
    const lastSeedSuccessAt = state?.lastSeedSuccessAt ?? input.persisted?.lastSeedSuccessAt ?? null;
    const announceErrorCount = state?.announceErrorCount ?? input.persisted?.announceErrorCount ?? 0;
    const lastAnnounceError = state?.lastAnnounceError ?? input.persisted?.lastAnnounceError ?? null;
    const degradedReason = this.buildDegradedReason() ?? lastAnnounceError;

    return {
      status: lastError ? "error" : infoHash ? "seeding" : "pending",
      engine: this.runtimeChecked ? "webtorrent" : null,
      browserPeerCompatible: this.browserPeerCompatible,
      degradedReason,
      infoHash,
      magnetUrl: infoHash
        ? buildMagnetUrl({
            infoHash,
            displayName: input.displayName,
            webSeedUrl: input.playbackUrl,
            trackers: trackerUrls,
          })
        : null,
      trackerUrls: [...trackerUrls],
      peerCount,
      seededAt,
      seedUptimeSeconds: seededAt ? Math.max(0, Math.floor((Date.now() - new Date(seededAt).getTime()) / 1000)) : null,
      lastError,
      lastSeedAttemptAt,
      lastSeedSuccessAt,
      announceErrorCount,
      lastAnnounceError,
    };
  }

  getEngineSnapshot(): {
    mode: PeerDeliveryMode;
    enabled: boolean;
    runtimeChecked: boolean;
    engine: "webtorrent" | null;
    browserPeerCompatible: boolean;
    hasBrowserCompatibleTrackers: boolean;
    trackerUrls: string[];
    degradedReason: string | null;
    activeSeedCount: number;
    maxActiveTorrents: number | null;
    maxConnections: number | null;
  } {
    return {
      mode: this.mode,
      enabled: this.enabled,
      runtimeChecked: this.runtimeChecked,
      engine: this.runtimeChecked ? "webtorrent" : null,
      browserPeerCompatible: this.browserPeerCompatible,
      hasBrowserCompatibleTrackers: this.hasBrowserCompatibleTrackers,
      trackerUrls: [...this.trackers],
      degradedReason: this.buildDegradedReason(),
      activeSeedCount: this.getActiveSeedCount(),
      maxActiveTorrents: this.maxActiveTorrents,
      maxConnections: this.maxConnections,
    };
  }

  async destroy(): Promise<void> {
    for (const state of this.seeds.values()) {
      state.torrent?.destroy();
    }
    this.seeds.clear();

    if (this.client) {
      await new Promise<void>((resolve) => {
        this.client?.destroy(() => resolve());
      });
      this.client = null;
    }
  }

  private async getClient(): Promise<TorrentClient> {
    if (this.client) {
      return this.client;
    }

    if (!this.clientPromise) {
      this.clientPromise = this.clientLoader()
        .then((loaded) => {
          this.runtimeChecked = true;
          this.runtimeBrowserPeerCompatible = loaded.browserPeerCompatible;
          this.refreshCompatibilityState();
          this.startupError = null;
          this.client = new loaded.Constructor(this.clientOptions);
          return this.client;
        })
        .catch((error) => {
          this.runtimeChecked = true;
          this.startupError = error instanceof Error ? error.message : String(error);
          this.refreshCompatibilityState();
          throw error;
        });
    }

    return this.clientPromise;
  }

  private async createSeed(state: ActiveSeedState): Promise<PersistedTorrentOutput | null> {
    try {
      state.lastSeedAttemptAt = new Date().toISOString();
      const client = await this.getClient();
      const persisted = await new Promise<PersistedTorrentOutput>((resolve, reject) => {
        const torrent = client.seed(
          state.filePath,
          {
            name: state.displayName,
            announce: state.trackerUrls,
          },
          (seededTorrent) => {
            state.torrent = seededTorrent;

            if (!seededTorrent.infoHash) {
              reject(new Error("WebTorrent did not return an info hash for the seeded file."));
              return;
            }

            const now = new Date().toISOString();
            state.seededAt = state.seededAt ?? now;
            state.lastSeedSuccessAt = now;
            state.lastError = null;
            state.lastAnnounceError = null;

            const persistedState = this.toPersistedOutput(state);
            if (!persistedState) {
              reject(new Error("WebTorrent seeded the file but no persisted torrent state could be derived."));
              return;
            }

            resolve(persistedState);
          }
        );

        state.torrent = torrent;
        torrent.on("warning", (error) => {
          const message = error instanceof Error ? error.message : String(error);
          state.lastAnnounceError = message;
          state.lastError = message;
          state.announceErrorCount += 1;
        });
        torrent.on("error", (error) => {
          const message = error instanceof Error ? error.message : String(error);
          state.lastAnnounceError = message;
          state.lastError = message;
          state.announceErrorCount += 1;
        });
      });

      state.pending = null;
      return persisted;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.lastError = message;
      state.lastAnnounceError = message;
      state.announceErrorCount += 1;
      state.pending = null;
      return null;
    }
  }

  private refreshCompatibilityState(): void {
    this.browserPeerCompatible = this.runtimeBrowserPeerCompatible && this.hasBrowserCompatibleTrackers;
  }

  private buildDegradedReason(): string | null {
    if (!this.enabled) {
      return null;
    }

    if (this.startupError) {
      return this.startupError;
    }

    if (!this.hasBrowserCompatibleTrackers) {
      return "Peer delivery requires at least one wss:// tracker for browser viewers.";
    }

    return null;
  }

  private getActiveSeedCount(): number {
    let count = 0;
    for (const state of this.seeds.values()) {
      if (state.torrent || state.pending) {
        count += 1;
      }
    }
    return count;
  }

  private toPersistedOutput(state: ActiveSeedState): PersistedTorrentOutput | null {
    if (!state.torrent?.infoHash || !state.seededAt) {
      return null;
    }

    return {
      infoHash: state.torrent.infoHash,
      trackerUrls: [...state.trackerUrls],
      seededAt: state.seededAt,
      lastError: state.lastError,
      lastSeedAttemptAt: state.lastSeedAttemptAt,
      lastSeedSuccessAt: state.lastSeedSuccessAt,
      announceErrorCount: state.announceErrorCount,
      lastAnnounceError: state.lastAnnounceError,
    };
  }
}
