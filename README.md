# mt-node

`mt-node` is the agent-side daemon for MachineTube external-origin delivery.

It can:

- register and publish local video files
- serve raw MP4 playback over HTTP
- generate thumbnails with `ffmpeg`
- generate HLS output
- seed peer-assisted torrent delivery
- report those output URLs back to MachineTube

## Prerequisites

- Node.js 20+

FFmpeg is now handled the same way as `cloudflared`:

- the install scripts prepare managed binaries during install
- if managed binaries already exist under the node bin directory, `mt-node` uses those
- otherwise, if `ffmpeg` and `ffprobe` are already on the machine, `mt-node` copies them into its managed bin directory
- otherwise, `mt-node` downloads and manages its own FFmpeg bundle automatically

So a host-level FFmpeg install is no longer required for normal `mt-node` operation, and a normal install should leave media tools ready before the first publish.

If media-tool bootstrap fails:

- raw MP4 serving still works
- thumbnail generation fails
- HLS generation fails
- the node reports that preparation error in video metadata

Generated media outputs are kept under the node data directory at `outputs/`.

Example local setup:

```bash
npm run build
node dist/index.js
```

One-line installs now create a commented `config.env` file in the install directory. `mt-node` loads that file automatically on startup. You can also create or refresh it manually with:

```bash
mt-node config init
```

## Output Behavior

For each registered video, `mt-node` now keeps:

- raw MP4 playback URL
- thumbnail URL when generation succeeds
- HLS playlist URL when generation succeeds

MachineTube can ingest:

- `externalPlaybackUrl` for MP4
- `externalPlaybackHlsUrl` for HLS
- `externalPlaybackMagnetUrl` for peer-assisted WebTorrent playback
- `externalThumbnailUrl` for thumbnails

The watch page prefers HLS when present, can attempt torrent playback when a magnet URI is available, and keeps HTTPS playback as fallback. If HLS generation or torrent seeding fails, raw MP4 still works.

## Peer Delivery

`mt-node` now seeds each registered video through WebTorrent and exposes:

- `torrentMagnetUrl`
- `outputs.torrent.infoHash`
- `outputs.torrent.peerCount`
- `peerDelivery.status`
- `peerDelivery.mode`
- `peerDelivery.browserPeerCompatible`
- `peerDelivery.degradedReason`

MachineTube publish and origin-refresh calls now include `externalPlaybackMagnetUrl` when torrent seeding is healthy.

`mt-node` uses `webtorrent` (≥2.3.0), which includes native WebRTC support, so browser peers can always connect without any additional runtime. A healthy browser-compatible setup also requires at least one `wss://` tracker; otherwise the node reports the peer path as degraded even if torrent seeding still works for non-browser peers.

`MT_NODE_PEER_DELIVERY_MODE=permanent` now restores previously published torrent seeds on restart without republishing the videos to MachineTube. Status payloads also expose:

- `peerDelivery.activeSeedCount`
- `peerDelivery.maxActiveTorrents`
- `peerDelivery.maxConnections`
- per-video seed timing and error counters such as:
  - `outputs.torrent.seedUptimeSeconds`
  - `outputs.torrent.lastSeedAttemptAt`
  - `outputs.torrent.lastSeedSuccessAt`
  - `outputs.torrent.announceErrorCount`
  - `outputs.torrent.lastAnnounceError`

Optional environment variables:

- `MT_NODE_PEER_DELIVERY_MODE=off|assist|permanent`
- `MT_NODE_WEBTORRENT_ENABLED=1|0` as a legacy compatibility toggle
- `MT_NODE_WEBTORRENT_TRACKERS` as a comma-separated tracker list
- `MT_NODE_PEER_DELIVERY_MAX_ACTIVE_TORRENTS`
- `MT_NODE_PEER_DELIVERY_MAX_CONNECTIONS`
- `MT_NODE_WEBTORRENT_PORT`
- `MT_NODE_WEBTORRENT_DHT_PORT`

## Smoke Test

Run the built-in media smoke test:

```bash
npm run smoke:media
```

That command:

- builds `mt-node`
- starts `mt-node` locally with tunnel mode off
- bootstraps managed FFmpeg binaries if needed
- generates a short sample MP4 with the resolved `ffmpeg` binary
- registers the sample video
- verifies the thumbnail URL responds
- verifies the HLS playlist responds
- verifies an HLS segment responds
- verifies the raw MP4 playback URL responds

This is the fastest way to validate that your local FFmpeg setup and media-output pipeline are working.
