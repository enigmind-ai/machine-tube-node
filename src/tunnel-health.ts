export type TunnelProbeResult = { ok: true } | { ok: false; reason: string };

export type TunnelSnapshotLike = {
  publicBaseUrl: string | null;
  source: "env" | "cloudflared" | null;
};

export async function getHealthyTunnelSnapshot<T extends TunnelSnapshotLike>(input: {
  ensureStarted(): Promise<T>;
  restart(reason: string): Promise<T>;
  probeHeartbeat(url: string): Promise<TunnelProbeResult>;
  now?: () => number;
  logWarn?: (message: string) => void;
}): Promise<T> {
  let tunnel = await input.ensureStarted();
  if (!tunnel.publicBaseUrl || tunnel.source !== "cloudflared") {
    return tunnel;
  }

  const heartbeatUrl = `${tunnel.publicBaseUrl}/heartbeat?probe=${(input.now ?? Date.now)()}`;
  const probe = await input.probeHeartbeat(heartbeatUrl);
  if (probe.ok) {
    return tunnel;
  }

  input.logWarn?.(
    `[mt-node] sync: public tunnel probe failed for ${tunnel.publicBaseUrl} - ${probe.reason}. Restarting cloudflared.`
  );
  tunnel = await input.restart(`public heartbeat probe failed: ${probe.reason}`);
  return tunnel;
}

export async function probePublicTunnelHeartbeat(
  url: string,
  input: {
    fetchFn?: typeof fetch;
    createAbortController?: () => AbortController;
    setTimeoutFn?: typeof setTimeout;
    clearTimeoutFn?: typeof clearTimeout;
    timeoutMs?: number;
    formatError?: (error: unknown) => string;
  } = {}
): Promise<TunnelProbeResult> {
  const fetchFn = input.fetchFn ?? fetch;
  const controller = (input.createAbortController ?? (() => new AbortController()))();
  const setTimeoutFn = input.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? clearTimeout;
  const timeoutMs = input.timeoutMs ?? 5000;
  const formatError = input.formatError ?? defaultFormatError;
  const timer = setTimeoutFn(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, reason: `heartbeat returned ${response.status} ${response.statusText}` };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: formatError(error) };
  } finally {
    clearTimeoutFn(timer);
  }
}

function defaultFormatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
