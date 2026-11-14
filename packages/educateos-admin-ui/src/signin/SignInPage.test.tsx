// @vitest-environment jsdom
// SCHO-376: a district administrator reads how the district signs people in, read-only, with no
// secret on the page.
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import { fakeDistrict } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";

describe("the Sign-in page", () => {
  it("shows the provider, the deployment's verifier and each trusted issuer's people", async () => {
    renderConsole(fakeDistrict().client, "sign-in");
    const issuers = await screen.findByRole("table", { name: "Trusted issuers" });
    const [, row] = within(issuers).getAllByRole("row");
    expect(within(row!).getByText("https://fake.cloudflareaccess.com")).toBeTruthy();
    expect(within(row!).getByText("96")).toBeTruthy();
    expect(screen.getByText("Cloudflare Access", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText(/signed Access assertion/)).toBeTruthy();
    expect(screen.getByText("Access applications accepted").nextElementSibling?.textContent).toBe("2");
    expect(screen.getByText("Sign-ins waiting to be linked").nextElementSibling?.textContent).toBe("1");
    // Read-only: nothing to change here.
    expect(screen.queryAllByRole("button").filter((b) => b.closest("main") !== null && /save|change|edit/i.test(b.textContent ?? ""))).toStrictEqual([]);
    expect(screen.queryAllByRole("textbox")).toStrictEqual([]);
  });
});
