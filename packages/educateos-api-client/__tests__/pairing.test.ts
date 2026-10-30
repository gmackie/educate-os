// The browser side of phone pairing (SCHO-260) against a scripted district that answers as the
// pairing contract says, and Your devices against the district app itself.
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { createDistrictApp, inMemoryDistrictStores } from "@educateos/district-app";
import { createDistrictApiClient, createPairingClient, DistrictApiError } from "../src/index.ts";

const ORIGIN = "https://northfield.educateos.io";
const ROOM = "rm_AbCdEfGh1234";
const SECRET = "s".repeat(30);
const QR = `https://mobile.educateos.io/j#o=${encodeURIComponent(ORIGIN)}&r=${ROOM}&s=${SECRET}`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A pairing client whose district answers with `answer`, recording each request. */
const scripted = (answer: (request: Request) => Response | Promise<Response>) => {
  const seen: { method: string; path: string; redirect: RequestRedirect; authorization: string | null }[] = [];
  const client = createPairingClient({
    baseUrl: ORIGIN,
    token: "tok",
    fetch: async (request) => {
      seen.push({ method: request.method, path: new URL(request.url).pathname, redirect: request.redirect, authorization: request.headers.get("authorization") });
      return answer(request);
    },
  });
  return { client, seen };
};

describe("the pairing client", () => {
  it("opens a room, reads its status, and approves or denies the phone at the contract's paths", async () => {
    const { client, seen } = scripted((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/pair/rooms") return json({ room: ROOM, secret: SECRET, qr: QR, expiresAt: "2026-10-28T12:02:00.000Z" }, 201);
      if (path.endsWith("/status")) return json({ state: "claimed", code: "K7Q4M2XD", device: { label: "Ava's iPhone 16", platform: "ios", model: "iPhone17,3", appVersion: "2.0.0" } });
      if (path.endsWith("/approve")) return json({ deviceId: "dev_0123456789abcdef" });
      return new Response(null, { status: 200 });
    });
    expect(await client.createRoom()).toStrictEqual({ room: ROOM, secret: SECRET, qr: QR, expiresAt: "2026-10-28T12:02:00.000Z" });
    expect(await client.status(ROOM)).toMatchObject({ state: "claimed", code: "K7Q4M2XD", device: { label: "Ava's iPhone 16" } });
    expect(await client.approve(ROOM)).toStrictEqual({ deviceId: "dev_0123456789abcdef" });
    await expect(client.deny(ROOM)).resolves.toBeUndefined();
    expect(seen.map(({ method, path }) => `${method} ${path}`)).toStrictEqual([
      "POST /api/pair/rooms",
      `GET /api/pair/rooms/${ROOM}/status`,
      `POST /api/pair/rooms/${ROOM}/approve`,
      `POST /api/pair/rooms/${ROOM}/deny`,
    ]);
    expect(seen.every((request) => request.redirect === "manual" && request.authorization === "Bearer tok")).toBe(true);
  });

  it("refuses an answer that is not the contract's: a QR that is not https, or a malformed code", async () => {
    const insecure = scripted(() => json({ room: ROOM, secret: SECRET, qr: "javascript:alert(1)", expiresAt: "2026-10-28T12:02:00.000Z" }, 201));
    await expect(insecure.client.createRoom()).rejects.toMatchObject({ code: "unavailable" });
    const badCode = scripted(() => json({ state: "claimed", code: "k7q4" }));
    await expect(badCode.client.status(ROOM)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("rejects with the district's error, or one its status stands for", async () => {
    const district = scripted(() => json({ code: "forbidden", message: "Not your room." }, 403));
    await expect(district.client.status(ROOM)).rejects.toMatchObject({ name: "DistrictApiError", code: "forbidden", message: "Not your room." });
    const gone = scripted(() => new Response("gone", { status: 410 }));
    await expect(gone.client.status(ROOM)).rejects.toMatchObject({ code: "not-found", status: 410 });
    // Access sending an ended session to its login page arrives as an opaque redirect.
    const signedOut = scripted(() => new Response(null, { status: 302, headers: { location: "https://northfield.cloudflareaccess.com/login" } }));
    await expect(signedOut.client.createRoom()).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("never puts a room id that is not one into a path", async () => {
    const { client, seen } = scripted(() => json({}));
    await expect(client.approve("../../me/devices/revoke-all")).rejects.toBeInstanceOf(DistrictApiError);
    expect(seen).toStrictEqual([]);
  });
});

describe("Your devices through the district client (SCHO-261)", () => {
  it("lists, signs out one and signs out every device, by route name", async () => {
    const issuer = NORTHFIELD.district.trustedIssuers[0]!;
    const app = await createDistrictApp({
      stores: inMemoryDistrictStores(NORTHFIELD),
      importFetch: async () => new Response("not found", { status: 404 }),
      verifyRequest: async (request) => request.headers.get("authorization") === "Bearer token-nf-s-2001" ? { issuer, subject: "nf-s-2001", credential: "person" } : undefined,
    });
    const client = createDistrictApiClient({ baseUrl: "https://learn.northfield.example", token: "token-nf-s-2001", fetch: (request) => app.fetch(request) });
    expect(await client.call("me.devices")).toStrictEqual({ devices: [] });
    expect(await client.call("me.revokeAllDevices")).toStrictEqual({ revoked: 0 });
    await expect(client.call("me.revokeDevice", { params: { deviceId: "dev_0123456789abcdefgh" as never } })).rejects.toMatchObject({ code: "not-found" });
  });
});
