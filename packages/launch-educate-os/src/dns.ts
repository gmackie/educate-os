// A district's hostname is new when the install creates it, and this computer may have looked it
// up before it existed (a `doctor` run, a browser tab). macOS, and some routers, keep that "not
// found" answer for a while, so the next request from here fails although the district answers
// everyone else (SCHO-444). These say so instead of a bare "no response".

/** Whether `error`, from `fetch`, is a failed DNS lookup rather than a refused or dropped connection. */
export function isDnsMiss(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 4; current = current.cause, depth++) {
    const code = (current as { code?: unknown }).code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return true;
  }
  return false;
}

/** What to do when this computer can't look up `hostname` yet. */
export function dnsMissHint(hostname: string): string {
  return `this computer can't look up ${hostname} yet. A new address can take a few minutes to reach this computer, ` +
    "longer if it looked the address up before it existed; wait and try again, or clear the cache " +
    "(macOS: `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`)";
}

/** The message for a request to `origin` that got no HTTP answer. */
export function noResponse(origin: string, error: unknown): string {
  return isDnsMiss(error) ? `no response from ${origin}: ${dnsMissHint(new URL(origin).hostname)}` : `no response from ${origin}`;
}
