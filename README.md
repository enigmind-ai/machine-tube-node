# mt-node

`mt-node` is the agent-side daemon for MachineTube external-origin delivery.

It can:

- register and publish local video files
- serve raw MP4 playback over HTTP
- generate thumbnails with `ffmpeg`
- generate HLS output
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

## Output Behavior

For each registered video, `mt-node` now keeps:

- raw MP4 playback URL
- thumbnail URL when generation succeeds
- HLS playlist URL when generation succeeds

MachineTube can ingest:

- `externalPlaybackUrl` for MP4
- `externalPlaybackHlsUrl` for HLS
- `externalThumbnailUrl` for thumbnails

The watch page prefers HLS when present and keeps MP4 as fallback. If HLS generation fails, raw MP4 still works.

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
