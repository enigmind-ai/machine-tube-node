import { execFile } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type MediaToolPaths = {
  ffmpegPath: string;
  ffprobePath: string;
};

export type VideoProbe = {
  durationSeconds: number;
  width: number | null;
  height: number | null;
};

export type HlsOutputFile = {
  localPath: string;
  relativePath: string;
  bytes: number;
};

export async function generateThumbnail(
  inputPath: string,
  outputPath: string,
  timestampSeconds: number,
  tools: MediaToolPaths,
): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync(tools.ffmpegPath, [
    "-hide_banner",
    "-y",
    "-ss",
    String(Math.max(0, timestampSeconds)),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    outputPath,
  ]);
}

export async function probeVideo(inputPath: string, tools: MediaToolPaths): Promise<VideoProbe> {
  const { stdout } = await execFileAsync(tools.ffprobePath, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    inputPath,
  ]);

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };

  const videoStream = parsed.streams?.find((stream) => stream.codec_type === "video");
  const durationRaw = parsed.format?.duration ?? "0";
  const durationSeconds = Math.max(0, Math.round(Number.parseFloat(durationRaw) || 0));

  return {
    durationSeconds,
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
  };
}

export async function transcodeToHls(
  inputPath: string,
  outputDirectory: string,
  tools: MediaToolPaths,
): Promise<HlsOutputFile[]> {
  await mkdir(outputDirectory, { recursive: true });

  const manifestPath = path.join(outputDirectory, "index.m3u8");
  const segmentPattern = path.join(outputDirectory, "segment-%03d.ts");

  await execFileAsync(tools.ffmpegPath, [
    "-hide_banner",
    "-y",
    "-i",
    inputPath,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-hls_time",
    "2",
    "-hls_playlist_type",
    "vod",
    "-hls_segment_filename",
    segmentPattern,
    manifestPath,
  ]);

  const files = await readdir(outputDirectory);
  const outputs = await Promise.all(
    files.map(async (fileName) => {
      const localPath = path.join(outputDirectory, fileName);
      const fileStats = await stat(localPath);
      return {
        localPath,
        relativePath: fileName,
        bytes: fileStats.size,
      };
    }),
  );

  return outputs.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
