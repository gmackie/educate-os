import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { blueprintScreenshotUrl } from "@gadgets/workshop-shared/api";
import { publicBasePath, publicPath, workshopRequestPath } from "../src/public-path";
import { siteLogoImage } from "../src/site-logo";
import server from "../src/server";

const origin = "https://district.example.test";

describe("PUBLIC_BASE_PATH", () => {
  it("defaults to the origin root", () => {
    expect(publicBasePath({})).toBe("");
    expect(publicBasePath({ PUBLIC_BASE_PATH: "" })).toBe("");
    expect(publicBasePath({ PUBLIC_BASE_PATH: "/" })).toBe("");
    expect(publicPath({}, "/api/site-logo")).toBe("/api/site-logo");
  });

  it("normalises a mount to a leading slash and no trailing one", () => {
    for (let value of ["ai", "/ai", "/ai/", " /ai/ "]) {
      expect(publicBasePath({ PUBLIC_BASE_PATH: value })).toBe("/ai");
    }
    expect(publicBasePath({ PUBLIC_BASE_PATH: "/a/b/" })).toBe("/a/b");
    expect(publicPath({ PUBLIC_BASE_PATH: "/ai/" }, "/api/site-logo")).toBe("/ai/api/site-logo");
  });

  it("refuses anything but plain path segments", () => {
    for (let value of ["//evil.example", "/ai?x", "/ai#x", "/../x", "/a/./b", "/a b", "https://x"]) {
      expect(() => publicBasePath({ PUBLIC_BASE_PATH: value })).toThrow("PUBLIC_BASE_PATH");
    }
  });

  it("prefixes the browser URLs the backend hands out", () => {
    expect(siteLogoImage(true)).toEqual({ url: "/api/site-logo" });
    expect(siteLogoImage(true, "/ai")).toEqual({ url: "/ai/api/site-logo" });
    let metadata = { screenshot: true as const, lastUpdated: new Date(5) };
    expect(blueprintScreenshotUrl("bp", metadata)).toBe("/blueprint-screenshot/bp?v=5");
    expect(blueprintScreenshotUrl("bp", metadata, "/ai")).toBe("/ai/blueprint-screenshot/bp?v=5");
  });
});

describe("workshopRequestPath", () => {
  it("leaves root paths alone", () => {
    for (let path of ["/api", "/api/client-errors", "/blueprint-screenshot/x", "/", "/other"]) {
      expect(workshopRequestPath(path, {})).toBe(path);
    }
  });

  it("strips the /ai mount only in front of a path the backend serves", () => {
    expect(workshopRequestPath("/ai/api", {})).toBe("/api");
    expect(workshopRequestPath("/ai/api/device-session/callback", {}))
      .toBe("/api/device-session/callback");
    expect(workshopRequestPath("/ai/blueprint-screenshot/x", {})).toBe("/blueprint-screenshot/x");
    for (let path of ["/ai", "/ai/", "/ai/workspace/x", "/ai/apix", "/aiapi", "/ai/ai/api"]) {
      expect(workshopRequestPath(path, {})).toBe(path);
    }
  });

  it("also strips a configured PUBLIC_BASE_PATH", () => {
    expect(workshopRequestPath("/workshop/api", { PUBLIC_BASE_PATH: "/workshop" })).toBe("/api");
    expect(workshopRequestPath("/workshop/api", {})).toBe("/workshop/api");
  });
});

describe("the Worker entry point under /ai", () => {
  async function statusOf(path: string, init?: RequestInit, overrides?: Partial<Cloudflare.Env>) {
    let response = await server.fetch(
        new Request(origin + path, init), { ...env, ...overrides }, createExecutionContext());
    // Read every body: an unread one keeps the isolate's storage busy.
    let body = await response.text();
    return { status: response.status, body };
  }

  it("routes /ai/api/* exactly like /api/*", async () => {
    let screenshotId = `public-path-${crypto.randomUUID()}`;
    await env.BLUEPRINT_CONTENT.put(`screenshots/${screenshotId}`, "png-bytes",
        { httpMetadata: { contentType: "image/png" } });
    for (let [path, init] of [
      ["/api/router-tag", { method: "POST" }],
      ["/api/site-logo", { method: "POST" }],
      ["/api/client-errors", { method: "GET" }],
      [`/blueprint-screenshot/${screenshotId}`, undefined],
    ] as const) {
      let root = await statusOf(path, init);
      let mounted = await statusOf("/ai" + path, init);
      expect(mounted, path).toStrictEqual(root);
      expect(root.status, path).not.toBe(404);
    }
  });

  it("keeps the same-origin check on /ai/api under Access", async () => {
    let access = { CF_ACCESS_AUD: "audience", CF_ACCESS_ISS: "https://access.example" };
    for (let path of ["/api", "/ai/api"]) {
      let crossOrigin = await statusOf(path, { headers: { Origin: "https://other.example" } }, access);
      expect(crossOrigin, path).toStrictEqual(
          { status: 403, body: "Cross-origin API access not allowed." });
      // Same origin gets past the Origin check to the JWT check, which this request fails.
      let sameOrigin = await statusOf(path, { headers: { Origin: origin } }, access);
      expect(sameOrigin, path).toStrictEqual({ status: 403, body: "Invalid CF access JWT." });
    }
  });

  it("does not serve anything else under /ai", async () => {
    for (let path of ["/ai", "/ai/", "/ai/workspace/x", "/ai/gatekeeper/x"]) {
      expect((await statusOf(path)).status, path).toBe(404);
    }
  });
});
