// Your devices and Connect phone (SCHO-260). Connect phone runs against the real pairing client over a
// scripted district that answers as the pairing contract says, polled on real timers.
import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { createPairingClient } from "@educateos/api-client";
import { PAIRING_POLL_MS } from "../src/devices/ConnectPhonePage.tsx";
import { fakeDistrict } from "./fakeDistrict.ts";
import { announcement, renderApp, schoolWith } from "./render.tsx";

describe("Your devices", () => {
  it("lists each device with its phone, app version, dates and status, and signs one out", async () => {
    const district = fakeDistrict();
    const user = userEvent.setup();
    await renderApp(district, "/devices");
    const table = await screen.findByRole("table", { name: "Your devices" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell").slice(0, 3).map((cell) => cell.textContent))).toStrictEqual([
      ["Amara's iPhone", "iPhone or iPad · iPhone17,3", "2.0.0"],
      ["Amara's iPad", "iPhone or iPad · iPad14,1", "2.0.0"],
      ["Old Pixel", "Android · Pixel 6", "2.0.0"],
    ]);
    expect(rows[0]!.querySelectorAll("time")[0]!.getAttribute("datetime")).toBe("2026-09-01T15:00:00.000Z");
    expect(rows[0]!.querySelectorAll("time")[1]!.getAttribute("datetime")).toBe("2026-10-27T15:00:00.000Z");
    expect(rows.map((row) => within(row).getAllByRole("cell")[5]!.textContent)).toStrictEqual(["Signed in", "Signed in", "Signed out"]);
    // Only a signed-in device can be signed out.
    expect(within(rows[2]!).queryByRole("button")).toBeNull();
    // There is no rename route yet, so no Rename is offered.
    expect(screen.queryByRole("button", { name: /Rename/ })).toBeNull();

    await user.click(within(rows[0]!).getByRole("button", { name: "Sign out Amara's iPhone" }));
    await waitFor(() => expect(announcement()).toBe("Amara's iPhone is signed out"));
    expect(district.calls.filter((call) => call.name === "me.revokeDevice").map((call) => call.input)).toStrictEqual([{ params: { deviceId: "dev_amara-iphone-0000001" } }]);
    await waitFor(() => expect(within(screen.getAllByRole("row")[1]!).getAllByRole("cell")[5]!.textContent).toBe("Signed out"));
    expect(screen.getByRole("link", { name: "Connect a phone" }).getAttribute("href")).toBe("/devices/connect");
  });

  it("signs out everywhere only once the person confirms", async () => {
    const district = fakeDistrict();
    const user = userEvent.setup();
    await renderApp(district, "/devices");
    await screen.findByRole("table", { name: "Your devices" });

    await user.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    let dialog = await screen.findByRole("alertdialog", { name: "Sign out everywhere?" });
    expect(dialog.textContent).toContain("(2 phones)");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(district.calls.some((call) => call.name === "me.revokeAllDevices")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    dialog = await screen.findByRole("alertdialog", { name: "Sign out everywhere?" });
    await user.click(within(dialog).getByRole("button", { name: "Yes, sign out everywhere" }));
    await waitFor(() => expect(announcement()).toBe("2 devices are signed out"));
    expect(district.calls.filter((call) => call.name === "me.revokeAllDevices")).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Sign out everywhere" })).toBeNull());
    expect(screen.queryAllByRole("button", { name: /^Sign out / })).toStrictEqual([]);
  });

  it("says what went wrong when a device could not be signed out", async () => {
    const district = fakeDistrict();
    const user = userEvent.setup();
    await renderApp(district, "/devices");
    await screen.findByRole("table", { name: "Your devices" });
    district.failNext("me.revokeDevice", { code: "unavailable" });
    await user.click(screen.getByRole("button", { name: "Sign out Amara's iPad" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong at your school's end.");
  });
});

const ORIGIN = "https://learn.northfield.example";
const DEVICE = { label: "Ava's iPhone 16", platform: "ios", model: "iPhone17,3", appVersion: "2.0.0" };

/** A district's pairing rooms, scripted by the test: what the next status poll answers, and every request. */
const pairingDistrict = (options: { lifetimeMs?: number; failCreate?: boolean } = {}) => {
  let rooms = 0;
  const server = {
    state: "waiting" as "waiting" | "claimed" | "approved" | "denied" | "expired",
    requests: [] as string[],
    claim() {
      server.state = "claimed";
    },
  };
  let failCreate = options.failCreate === true;
  const client = createPairingClient({
    baseUrl: ORIGIN,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      server.requests.push(`${request.method} ${path}`);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (path === "/api/pair/rooms") {
        if (failCreate) {
          failCreate = false;
          return json({ code: "unavailable", message: "Pairing is resting." }, 503);
        }
        rooms += 1;
        server.state = "waiting";
        const room = `room${String(rooms).padStart(8, "0")}`;
        return json({ room, secret: "s".repeat(30), qr: `https://mobile.educateos.io/j#o=${encodeURIComponent(ORIGIN)}&r=${room}&s=${"s".repeat(30)}`, expiresAt: new Date(Date.now() + (options.lifetimeMs ?? 120_000)).toISOString() }, 201);
      }
      if (path.endsWith("/status")) return json(server.state === "claimed" ? { state: "claimed", code: "K7Q4M2XD", device: DEVICE } : { state: server.state });
      if (path.endsWith("/approve")) {
        server.state = "approved";
        return json({ deviceId: "dev_0123456789abcdef" });
      }
      if (path.endsWith("/deny")) {
        server.state = "denied";
        return new Response(null, { status: 200 });
      }
      return json({ code: "not-found", message: "No such route." }, 404);
    },
  });
  return { client, server };
};

const statusPolls = (requests: string[]) => requests.filter((request) => request.endsWith("/status")).length;
/** Long enough for a poll or two. */
const POLLED = { timeout: PAIRING_POLL_MS * 3 };

const renderConnect = async (pairing: ReturnType<typeof pairingDistrict>) =>
  renderApp(fakeDistrict(), "/devices/connect", undefined, undefined, { school: schoolWith({ mobile: true }), pairing: pairing.client });

describe("Connect phone", () => {
  afterEach(() => {
    delete (document as { visibilityState?: unknown }).visibilityState;
  });

  it("shows the room's QR, then the claiming phone's code, and connects it on Approve", async () => {
    const pairing = pairingDistrict();
    const user = userEvent.setup();
    await renderConnect(pairing);

    // Waiting: the QR, the steps, store links and the countdown.
    const qr = await screen.findByRole("img", { name: "QR code for the EducateOS app to scan" });
    expect(qr.querySelector("path")?.getAttribute("d")).toMatch(/^M\d+,\d+h1v1h-1z/);
    expect(screen.getByText(/^This code expires in (2:00|1:59)$/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /App Store/ }).getAttribute("href")).toBe("https://mobile.educateos.io/get?platform=ios");
    expect(screen.getByRole("link", { name: /Google Play/ }).getAttribute("href")).toBe("https://mobile.educateos.io/get?platform=android");
    await waitFor(() => expect(announcement()).toBe("Scan the code with the EducateOS app on your phone."));
    expect(pairing.server.requests[0]).toBe("POST /api/pair/rooms");

    // Claimed: the code, big and spelled out for a screen reader, and who is asking.
    pairing.server.claim();
    expect(await screen.findByRole("heading", { level: 2, name: "Ava's iPhone 16 wants to connect" }, POLLED)).toBeTruthy();
    const code = screen.getByRole("group", { name: "Check that your phone shows this code" });
    expect(within(code).getByText("K 7 Q 4 M 2 X D").className).toContain("sr-only");
    expect(within(code).getByText("K7Q4·M2XD").getAttribute("aria-hidden")).toBe("true");
    await waitFor(() => expect(announcement()).toBe("Ava's iPhone 16 wants to connect. Check that it shows the code K 7 Q 4 M 2 X D, then approve it."));

    // Approved.
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Ava's iPhone 16 is connected" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Your devices" }).getAttribute("href")).toBe("/devices");
    await waitFor(() => expect(announcement()).toBe("Ava's iPhone 16 is connected"));
    expect(pairing.server.requests.filter((request) => !request.endsWith("/status"))).toStrictEqual(["POST /api/pair/rooms", "POST /api/pair/rooms/room00000001/approve"]);

    // Nothing left to watch: polling has stopped.
    const polls = statusPolls(pairing.server.requests);
    await new Promise((resolve) => setTimeout(resolve, PAIRING_POLL_MS + 300));
    expect(statusPolls(pairing.server.requests)).toBe(polls);
  });

  it("turns a phone away on Deny", async () => {
    const pairing = pairingDistrict();
    const user = userEvent.setup();
    await renderConnect(pairing);
    await screen.findByRole("img", { name: /QR code/ });
    pairing.server.claim();
    await user.click(await screen.findByRole("button", { name: "Deny" }, POLLED));
    expect(await screen.findByRole("heading", { level: 2, name: "The phone was not connected" })).toBeTruthy();
    expect(pairing.server.requests).toContain("POST /api/pair/rooms/room00000001/deny");
    expect(pairing.server.requests).not.toContain("POST /api/pair/rooms/room00000001/approve");
    await waitFor(() => expect(announcement()).toBe("The phone was not connected."));
  });

  it("says the code expired when the district does, and opens a new room on Try again", async () => {
    const pairing = pairingDistrict();
    const user = userEvent.setup();
    await renderConnect(pairing);
    await screen.findByRole("img", { name: /QR code/ });
    pairing.server.state = "expired";
    expect(await screen.findByRole("heading", { level: 2, name: "This code expired" }, POLLED)).toBeTruthy();
    await waitFor(() => expect(announcement()).toBe("The code expired. Try again to get a new one."));

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("img", { name: /QR code/ })).toBeTruthy();
    expect(pairing.server.requests.filter((request) => request === "POST /api/pair/rooms")).toHaveLength(2);
  });

  it("expires an unclaimed room when its countdown runs out, even before the district says so", async () => {
    const pairing = pairingDistrict({ lifetimeMs: 1_200 });
    await renderConnect(pairing);
    await screen.findByRole("img", { name: /QR code/ });
    expect(await screen.findByRole("heading", { level: 2, name: "This code expired" }, { timeout: 3_000 })).toBeTruthy();
  });

  it("explains a room the district would not open, and tries again", async () => {
    const pairing = pairingDistrict({ failCreate: true });
    const user = userEvent.setup();
    await renderConnect(pairing);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("We couldn't start connecting a phone");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("img", { name: /QR code/ })).toBeTruthy();
  });

  it("does not poll while the page is hidden", async () => {
    const pairing = pairingDistrict();
    await renderConnect(pairing);
    await screen.findByRole("img", { name: /QR code/ });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    const polls = statusPolls(pairing.server.requests);
    await new Promise((resolve) => setTimeout(resolve, PAIRING_POLL_MS * 2 + 200));
    expect(statusPolls(pairing.server.requests)).toBe(polls);
    delete (document as { visibilityState?: unknown }).visibilityState;
    await waitFor(() => expect(statusPolls(pairing.server.requests)).toBeGreaterThan(polls), POLLED);
  });

  it("says phones can't be connected where the app has no pairing client", async () => {
    await renderApp(fakeDistrict(), "/devices/connect");
    expect(await screen.findByText("Connecting a phone isn't available here")).toBeTruthy();
  });
});
