// SCHO-444: a district hostname this computer looked up before it existed fails here with
// ENOTFOUND for a while; the launcher says so instead of a bare "no response".
import { describe, expect, it } from "vitest";
import { DistrictAdmin } from "../src/connect/district.ts";
import { isDnsMiss, noResponse } from "../src/dns.ts";
import { probeDistrictEndpoint } from "../src/mcp/probe.ts";

const lookupFailed = () => Object.assign(new TypeError("fetch failed"), {
  cause: Object.assign(new Error("getaddrinfo ENOTFOUND district.example.org"), { code: "ENOTFOUND" }),
});
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });

describe("DNS misses", () => {
  it("tells a failed lookup from a refused connection", () => {
    expect(isDnsMiss(lookupFailed())).toBe(true);
    expect(isDnsMiss(refused())).toBe(false);
    expect(isDnsMiss("ENOTFOUND")).toBe(false);
  });

  it("explains a failed lookup and says how to clear the cache", () => {
    expect(noResponse("https://district.example.org", lookupFailed()))
      .toMatch(/^no response from https:\/\/district\.example\.org: this computer can't look up district\.example\.org yet\..*mDNSResponder/);
    expect(noResponse("https://district.example.org", refused())).toBe("no response from https://district.example.org");
  });

  it("reaches the district client's error and the MCP probe", async () => {
    const failing = (async () => { throw lookupFailed(); }) as typeof fetch;
    await expect(new DistrictAdmin("https://district.example.org", "token", failing).call("GET", "/api/me"))
      .rejects.toThrow("can't look up district.example.org yet");
    expect(await probeDistrictEndpoint(failing, "https://district.example.org/mcp")).toEqual({ state: "unreachable", dnsMiss: true });
  });
});
