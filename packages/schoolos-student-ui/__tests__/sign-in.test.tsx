// What someone sees when the district does not accept their sign-in: a person signed in whom the
// school has not added yet gets their sign-in ID to pass on, and an ended sign-in says how to sign
// in again for the way this build signs in.
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { fakeDistrict } from "./fakeDistrict.ts";
import { renderApp } from "./render.tsx";

const ISSUER = "https://northfield.cloudflareaccess.com";

const notAdded = () => {
  const district = fakeDistrict();
  district.failNext("me.get", { code: "unauthenticated", message: "This sign-in is not linked to a principal in this district.", unlinkedSignIn: { issuer: ISSUER, subject: "a1b2c3-new-student" } });
  return district;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("someone the school has not added yet", () => {
  it("sees that they are signed in, their sign-in ID, what to do with it, and a way to sign out", async () => {
    await renderApp(notAdded());
    const heading = await screen.findByRole("heading", { level: 1, name: "You're signed in, but you haven't been added to this school yet" });
    const section = heading.closest("section")!;
    const id = within(section).getByRole("group", { name: "Your sign-in ID" });
    expect(id.textContent).toContain("a1b2c3-new-student");
    expect(id.textContent).toContain("Signed in through northfield.cloudflareaccess.com");
    expect(section.textContent).toContain("Send this ID to your school's administrator. They add you, then reload this page.");
    expect(within(section).getByRole("link", { name: "Sign out" }).getAttribute("href")).toBe(`${window.location.origin}/cdn-cgi/access/logout`);
    // Nothing a signed-in student has: no navigation, no error, and no hint the sign-in ended.
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain("sign-in has ended");
  });

  it("copies the sign-in ID from the keyboard and announces it", async () => {
    const user = userEvent.setup();
    await renderApp(notAdded());
    const copy = await screen.findByRole("button", { name: "Copy your sign-in ID" });
    while (document.activeElement !== copy) await user.tab();
    await user.keyboard("{Enter}");
    expect(await navigator.clipboard.readText()).toBe("a1b2c3-new-student");
    await waitFor(() => expect([...document.querySelectorAll('[aria-live="polite"]')].some((region) => region.textContent === "Sign-in ID copied")).toBe(true));
  });
});

describe("a sign-in that ended or did not verify", () => {
  const ended = () => {
    const district = fakeDistrict();
    district.failNext("me.get", { code: "unauthenticated", message: "Sign in with this district's identity provider." });
    return district;
  };

  it("behind Access, says to reload the page", async () => {
    vi.stubEnv("VITE_CF_ACCESS_MODE", "true");
    await renderApp(ended());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your sign-in has ended. Reload this page to sign in again.");
    expect(screen.queryByRole("group", { name: "Your sign-in ID" })).toBeNull();
  });

  it("with a development sign-in link, says to open the link again", async () => {
    vi.stubEnv("VITE_CF_ACCESS_MODE", "");
    await renderApp(ended());
    expect((await screen.findByRole("alert")).textContent).toContain("Your sign-in has ended. Open your sign-in link again.");
  });
});
