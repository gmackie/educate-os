// The guided install drives the installer's real Cloudflare client inside this Worker. In workerd
// the global fetch must not be called as a method of another object ("Illegal invocation"), which
// Node allows, so the Node suites alone missed it and the first production install stopped with
// "getAccount: no response from Cloudflare" (SCHO-206). This drives the client with no fetch of its
// own, through workerd's real fetch, to an outbound stub (vitest.config.ts `outboundService`).
import { CloudflareHttpApi, staticTokenProvider } from "@educateos/installer";
import { describe, expect, it } from "vitest";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

describe("the installer's Cloudflare client in workerd", () => {
  it("reaches the Cloudflare API through the Worker's own fetch", async () => {
    const api = new CloudflareHttpApi({ tokens: staticTokenProvider("district-run", "test-token") });
    await expect(api.getAccount(ACCOUNT_ID)).resolves.toEqual({ id: ACCOUNT_ID, name: "Stub account" });
  });
});
