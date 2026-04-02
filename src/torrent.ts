const WEBTORRENT_MODULE = "webtorrent";

export const DEFAULT_WEBTORRENT_TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.webtorrent.dev",
];

type TorrentSeedOptions = {
  name?: string;
  announce?: string[];
  urlList?: string[];
};

type TorrentClientConstructor = new (opts?: Record<string, unknown>) => TorrentClient;

type TorrentClient = {
  seed(input: string, opts: TorrentSeedOptions, onSeed: (torrent: TorrentHandle) => void): TorrentHandle;
  destroy(callback?: (error?: Error | null) => void): void;
};

type TorrentHandle = {
  infoHash?: string;
  numPeers?: number;
  torrentFile?: Uint8Array | null;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeAllListeners?(event: string): void;
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
  torrentFileUrl: string | null;
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
  playbackUrl: string | null;
  /** Target playbackUrl for an in-flight reseed (state.playbackUrl stays at the previous URL until success). */
  pendingPlaybackUrl: string | null;
  trackerUrls: string[];
  seededAt: string | null;
  lastError: string | null;
  lastSeedAttemptAt: string | null;
  lastSeedSuccessAt: string | null;
  announceErrorCount: number;
  lastAnnounceError: string | null;
  torrent: TorrentHandle | null;
  /** In-flight replacement handle during reseed; always destroyed on completion, error, or supersede. */
  reseedHandle: TorrentHandle | null;
  pending: Promise<PersistedTorrentOutput | null> | null;
  resolvePending: ((value: PersistedTorrentOutput | null) => void) | null;
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

/** Tracker-only .torrent download URL is safe to advertise only for loopback HTTP (local dev), not arbitrary http origins. */
function isLoopbackHttpPlaybackUrl(playbackUrl: string | null): boolean {
  if (playbackUrl === null) {
    return true;
  }
  try {
    const parsed = new URL(playbackUrl);
    if (parsed.protocol !== "http:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
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
    playbackUrl?: string | null;
  }): Promise<PersistedTorrentOutput | null> {
    if (!this.enabled) {
      return null;
    }

    const playbackUrl = input.playbackUrl ?? null;
    const coalescedImmediate = this.tryCoalesceSeed(this.seeds.get(input.videoId), input, playbackUrl);
    if (coalescedImmediate !== undefined) {
      return coalescedImmediate;
    }

    let existing = this.seeds.get(input.videoId);

    if (!existing && this.maxActiveTorrents !== null && this.getActiveTorrentHandleCount() >= this.maxActiveTorrents) {
      const state: ActiveSeedState = {
        videoId: input.videoId,
        filePath: input.filePath,
        fileSignature: input.fileSignature,
        displayName: input.displayName,
        playbackUrl,
        pendingPlaybackUrl: null,
        trackerUrls: [...this.trackers],
        seededAt: null,
        lastError: `Peer delivery skipped because max active torrents (${this.maxActiveTorrents}) has been reached.`,
        lastSeedAttemptAt: new Date().toISOString(),
        lastSeedSuccessAt: null,
        announceErrorCount: 1,
        lastAnnounceError: `Peer delivery skipped because max active torrents (${this.maxActiveTorrents}) has been reached.`,
        torrent: null,
        reseedHandle: null,
        pending: null,
        resolvePending: null,
      };
      this.seeds.set(input.videoId, state);
      return null;
    }

    const coalescedAfterRace = this.tryCoalesceSeed(this.seeds.get(input.videoId), input, playbackUrl);
    if (coalescedAfterRace !== undefined) {
      return coalescedAfterRace;
    }

    existing = this.seeds.get(input.videoId);

    const entryOccupiesActiveSlot = Boolean(existing?.torrent || existing?.reseedHandle || existing?.pending);
    if (
      !entryOccupiesActiveSlot &&
      this.maxActiveTorrents !== null &&
      this.getActiveTorrentHandleCount() >= this.maxActiveTorrents
    ) {
      if (existing) {
        const message = `Peer delivery skipped because max active torrents (${this.maxActiveTorrents}) has been reached.`;
        existing.lastError = message;
        existing.lastAnnounceError = message;
        existing.lastSeedAttemptAt = new Date().toISOString();
        existing.announceErrorCount += 1;
      }
      return null;
    }

    // Capture old state but don't destroy yet — keep seeding until the
    // replacement is confirmed healthy so a transient reseed failure doesn't
    // cause an availability gap.
    const previousTorrent = existing?.torrent ?? null;
    const previousPlaybackUrl = existing?.playbackUrl ?? null;

    if (existing) {
      const handlesNow = this.getActiveTorrentHandleCount();
      const loseFromDestroy = existing.reseedHandle ? 1 : 0;
      const projectedAfterReseedStart = handlesNow - loseFromDestroy + 1;
      if (this.maxActiveTorrents !== null && projectedAfterReseedStart > this.maxActiveTorrents) {
        // Still seeding the previous torrent — do not set lastError or peers will
        // see status:"error" and persist degraded metadata while the seed is healthy.
        return existing.pending ?? Promise.resolve(this.toPersistedOutput(existing) ?? null);
      }
    }

    if (existing?.resolvePending) {
      const supersededResult = this.toPersistedOutput(existing) ?? null;
      existing.resolvePending(supersededResult);
      existing.resolvePending = null;
    }

    if (existing?.reseedHandle) {
      this.clearTorrentDiagnosticsListeners(existing.reseedHandle);
      existing.reseedHandle.destroy();
      existing.reseedHandle = null;
    }

    const state: ActiveSeedState = {
      videoId: input.videoId,
      filePath: input.filePath,
      fileSignature: input.fileSignature,
      displayName: input.displayName,
      // Snapshot/torrent-file URL gating only — must stay on the URL embedded
      // in the current torrent bytes until reseed succeeds. createSeed() gets
      // the requested URL separately so urlList matches this request.
      playbackUrl: previousPlaybackUrl,
      pendingPlaybackUrl: null,
      trackerUrls: [...this.trackers],
      seededAt: existing?.seededAt ?? null,
      lastError: null,
      lastSeedAttemptAt: existing?.lastSeedAttemptAt ?? null,
      lastSeedSuccessAt: existing?.lastSeedSuccessAt ?? null,
      announceErrorCount: existing?.announceErrorCount ?? 0,
      lastAnnounceError: existing?.lastAnnounceError ?? null,
      // Pre-populate with the previous torrent so getTorrentFile() keeps serving
      // those bytes until createSeed's callback assigns the replacement. The new
      // handle is tracked separately in reseedHandle so it is never orphaned.
      torrent: previousTorrent,
      reseedHandle: null,
      pending: null,
      resolvePending: null,
    };
    this.seeds.set(input.videoId, state);

    if (previousTorrent) {
      this.clearTorrentDiagnosticsListeners(previousTorrent);
      this.attachTorrentDiagnosticsListeners(previousTorrent, input.videoId);
    }

    state.pendingPlaybackUrl = playbackUrl;
    state.pending = new Promise<PersistedTorrentOutput | null>((resolve) => {
      state.resolvePending = resolve;
    });

    const settlePending = (result: PersistedTorrentOutput | null): void => {
      state.resolvePending?.(result);
      state.resolvePending = null;
    };

    void this.createSeed(state, playbackUrl)
      .then((result) => {
        if (this.seeds.get(state.videoId) !== state) {
          return result;
        }
        state.pendingPlaybackUrl = null;
        if (result !== null) {
          // New bytes are ready — advance the URL so getSnapshot() treats them
          // as current and clients can download the updated torrent file.
          state.playbackUrl = playbackUrl;
          if (previousTorrent) {
            this.clearTorrentDiagnosticsListeners(previousTorrent);
            previousTorrent.destroy();
          }
        } else if (previousTorrent) {
          // Reseed failed — restore the old torrent and the URL it was built
          // with so getSnapshot() doesn't advertise a stale torrentFileUrl.
          // Also clear the replacement error so the snapshot doesn't report
          // status:"error" while the old torrent is still serving.
          state.torrent = previousTorrent;
          state.playbackUrl = previousPlaybackUrl;
          state.lastError = null;
          state.lastAnnounceError = null;
        }
        return result;
      })
      .then((result) => settlePending(result ?? null))
      .catch(() => settlePending(null));

    return state.pending;
  }

  getSnapshot(input: {
    videoId: string;
    displayName: string;
    playbackUrl: string | null;
    torrentFileUrl: string | null;
    persisted: PersistedTorrentOutput | null;
    /**
     * When false, tracker-only `.torrent` files are never advertised via `torrentFileUrl`,
     * even if `playbackUrl` looks like loopback HTTP (untrusted `Host` from remote clients).
     */
    trustPlaybackUrlForTrackerOnlyTorrentFile?: boolean;
  }): TorrentRuntimeSnapshot {
    if (!this.enabled) {
      return {
        status: "disabled",
        engine: null,
        browserPeerCompatible: false,
        degradedReason: null,
        infoHash: null,
        magnetUrl: null,
        torrentFileUrl: null,
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
      torrentFileUrl: (() => {
        if (!state || !(state.torrent?.torrentFile instanceof Uint8Array) || input.torrentFileUrl == null) {
          return null;
        }
        const webSeedMatchesAdvertised = state.playbackUrl === input.playbackUrl;
        const stableTrackerOnlyIdle =
          state.playbackUrl === null &&
          state.pendingPlaybackUrl === null &&
          state.pending === null;
        // Tracker-only .torrent bytes: expose a download URL only for loopback HTTP or
        // null playback (internal snapshot). Non-loopback http/https would disagree with
        // bytes that embed no matching web seed.
        const trackerOnlyTorrentFileOk =
          (input.trustPlaybackUrlForTrackerOnlyTorrentFile !== false &&
            isLoopbackHttpPlaybackUrl(input.playbackUrl)) &&
          stableTrackerOnlyIdle;
        return webSeedMatchesAdvertised || trackerOnlyTorrentFileOk ? input.torrentFileUrl : null;
      })(),
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
      activeSeedCount: this.getActiveTorrentHandleCount(),
      maxActiveTorrents: this.maxActiveTorrents,
      maxConnections: this.maxConnections,
    };
  }

  getTorrentFile(videoId: string): Uint8Array | null {
    const torrentFile = this.seeds.get(videoId)?.torrent?.torrentFile;
    return torrentFile instanceof Uint8Array ? torrentFile : null;
  }

  async destroy(): Promise<void> {
    for (const state of this.seeds.values()) {
      state.torrent?.destroy();
      state.reseedHandle?.destroy();
      state.resolvePending?.(null);
      state.resolvePending = null;
    }
    this.seeds.clear();

    if (this.client) {
      await new Promise<void>((resolve) => {
        this.client?.destroy(() => resolve());
      });
      this.client = null;
    }
  }

  private tryCoalesceSeed(
    existing: ActiveSeedState | undefined,
    input: {
      videoId: string;
      filePath: string;
      fileSignature: string;
      displayName: string;
    },
    playbackUrl: string | null,
  ): Promise<PersistedTorrentOutput | null> | PersistedTorrentOutput | undefined {
    if (!existing) {
      return undefined;
    }
    if (
      existing.filePath !== input.filePath ||
      existing.fileSignature !== input.fileSignature ||
      existing.displayName !== input.displayName
    ) {
      return undefined;
    }
    const playbackMatches =
      existing.pending != null
        ? existing.pendingPlaybackUrl === playbackUrl
        : existing.playbackUrl === playbackUrl;
    if (!playbackMatches || existing.trackerUrls.join("\n") !== this.trackers.join("\n")) {
      return undefined;
    }
    if (existing.pending) {
      return existing.pending;
    }
    const persistedExisting = this.toPersistedOutput(existing);
    if (persistedExisting) {
      existing.lastError = null;
      return persistedExisting;
    }
    return undefined;
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

  private async createSeed(
    state: ActiveSeedState,
    webSeedUrlForTorrent: string | null,
  ): Promise<PersistedTorrentOutput | null> {
    try {
      state.lastSeedAttemptAt = new Date().toISOString();
      const client = await this.getClient();
      if (this.seeds.get(state.videoId) !== state) {
        return null;
      }
      const persisted = await new Promise<PersistedTorrentOutput>((resolve, reject) => {
        const torrent = client.seed(
          state.filePath,
          {
            name: state.displayName,
            announce: state.trackerUrls,
            ...(webSeedUrlForTorrent ? { urlList: [webSeedUrlForTorrent] } : {}),
          },
          (seededTorrent) => {
            if (this.seeds.get(state.videoId) !== state) {
              this.clearTorrentDiagnosticsListeners(seededTorrent);
              seededTorrent.destroy();
              state.reseedHandle = null;
              reject(new Error("Seeding superseded by a newer ensureSeed for this video."));
              return;
            }

            state.reseedHandle = null;
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

        state.reseedHandle = torrent;
        this.attachTorrentDiagnosticsListeners(torrent, state.videoId);
      });

      state.pending = null;
      return persisted;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (state.reseedHandle) {
        this.clearTorrentDiagnosticsListeners(state.reseedHandle);
        state.reseedHandle.destroy();
      }
      state.reseedHandle = null;
      state.lastError = message;
      state.lastAnnounceError = message;
      state.announceErrorCount += 1;
      state.pending = null;
      return null;
    }
  }

  private clearTorrentDiagnosticsListeners(torrent: TorrentHandle): void {
    torrent.removeAllListeners?.("warning");
    torrent.removeAllListeners?.("error");
  }

  /**
   * Attach announce/seed diagnostics to a handle using the live map entry for `videoId`
   * so in-place reseeds keep reporting on the current {@link ActiveSeedState}.
   */
  private attachTorrentDiagnosticsListeners(torrent: TorrentHandle, videoId: string): void {
    const onIssue = (error: unknown): void => {
      const live = this.seeds.get(videoId);
      if (!live || (live.torrent !== torrent && live.reseedHandle !== torrent)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      live.lastAnnounceError = message;
      live.lastError = message;
      live.announceErrorCount += 1;
    };
    torrent.on("warning", onIssue);
    torrent.on("error", onIssue);
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

  /**
   * Open WebTorrent torrent handles plus an in-flight reservation while a seed is starting
   * (after `resolvePending` is set, possibly before `reseedHandle` exists — e.g. slow `getClient()`).
   * Reseed briefly holds two handles per video: previous torrent + replacement.
   */
  private getActiveTorrentHandleCount(): number {
    let count = 0;
    for (const state of this.seeds.values()) {
      if (state.torrent) {
        count += 1;
      }
      if (state.reseedHandle) {
        count += 1;
      } else if (state.resolvePending !== null) {
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
