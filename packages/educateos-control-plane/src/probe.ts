// A read-only look at whether an installation answers, for its operator's dashboard. It asks the
// installation's router for `/healthz`, which reads nothing and carries nothing about the instance,
// and keeps only the status code. educateos.io is never in an installation's data path: this is a
// visitor's request like any other, made only while the operator has the dashboard open.

/** What the probe saw. */
export type ProbeResult =
  /** `/healthz` answered 200. */
  | { state: "responding" }
  /** Cloudflare Access answered first (no `/healthz` bypass), so the installation's own state is unknown. */
  | { state: "behind-sign-in" }
  /** It answered with another status. */
  | { state: "failing"; status: number }
  /** No answer within the timeout, or no connection. */
  | { state: "unreachable" };

/** How long the probe waits. The dashboard waits for every probe, so keep it short. */
export const PROBE_TIMEOUT_MS = 3000;

// Only managed hostnames: the dashboard never sends a request anywhere but an installation's own
// `<slug>.educateos.io`.
const HOSTNAME = /^[a-z][a-z0-9-]{1,30}[a-z0-9]\.educateos\.io$/;

/** Probes `https://<hostname>/healthz` for a managed hostname. Never throws. */
export async function probeInstallation(hostname: string, doFetch: typeof fetch = fetch): Promise<ProbeResult> {
  if (!HOSTNAME.test(hostname)) return { state: "unreachable" };
  try {
    const response = await doFetch(`https://${hostname}/healthz`, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { "user-agent": "educateos.io dashboard probe" },
    });
    await response.body?.cancel();
    if (response.status === 200) return { state: "responding" };
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null && URL.canParse(location) &&
      new URL(location).hostname.endsWith(".cloudflareaccess.com")) {
      return { state: "behind-sign-in" };
    }
    return { state: "failing", status: response.status };
  } catch {
    return { state: "unreachable" };
  }
}
