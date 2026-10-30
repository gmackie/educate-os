import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { findByText, getAllByRole, getByRole, queryByRole } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bootCedarValley, type CedarValleyDistrict } from "../districts/cedarvalley.ts";
import { districtInfo, type PersonaId } from "../districts/index.ts";
import type { InstantLoginHop } from "./instantLogin.ts";
import { CleverPortal, type PortalSignIn } from "./Portal.tsx";

const BOOT = { timeout: 60_000 };
const info = districtInfo("cedarvalley");

let district: CedarValleyDistrict;
let root: Root;
let container: HTMLElement;

beforeAll(async () => {
  district = await bootCedarValley();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const mount = async (props: Partial<Parameters<typeof CleverPortal>[0]> & { booted?: CedarValleyDistrict } = {}) => {
  const { booted = district, ...rest } = props;
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root.render(<CleverPortal info={info} district={{ status: "ready", district: booted }} onSignedIn={() => {}} {...rest} />));
};

describe("the Cedar Valley portal", () => {
  it("is a neutral, labelled district portal: pick who you are in Clever, then see your apps", async () => {
    const onPortalSignIn = vi.fn();
    await mount({ onPortalSignIn });
    const portal = getByRole(container, "region", { name: "Cedar Valley USD portal (simulated Clever portal)" });
    expect(getByRole(portal, "heading", { name: "Who are you in Clever?" })).toBeDefined();
    expect(queryByRole(portal, "img")).toBeNull();

    await userEvent.click(getByRole(portal, "button", { name: /^Earth Science and Algebra teacher/ }));
    expect(onPortalSignIn).toHaveBeenCalledWith("teacher");
    expect(portal.textContent).toContain("Signed in to the portal as Dana Whitaker");
    const apps = getByRole(portal, "list", { name: "Apps" });
    expect(getAllByRole(apps, "listitem").map((tile) => tile.textContent)).toEqual(["EducateOS", "Reading appNot part of the demo", "Math practiceNot part of the demo"]);
    // Only EducateOS opens; the others are placeholders.
    expect(getAllByRole(apps, "button").map((button) => button.textContent)).toEqual(["EducateOS"]);

    await userEvent.click(getByRole(portal, "button", { name: "Sign out of the portal" }));
    expect(getByRole(portal, "heading", { name: "Who are you in Clever?" })).toBeDefined();
  });

  it("signs the persona in with Clever Instant Login when the EducateOS tile is clicked", async () => {
    const onTileClick = vi.fn();
    const hops: InstantLoginHop[] = [];
    let signedIn: [PersonaId, PortalSignIn] | undefined;
    await mount({ initialPersonaId: "admin", onTileClick, onHop: (hop) => hops.push(hop), onSignedIn: (id, signIn) => (signedIn = [id, signIn]) });
    await userEvent.click(getByRole(container, "button", { name: "EducateOS" }));
    await vi.waitFor(() => expect(signedIn).toBeDefined(), BOOT);

    expect(onTileClick).toHaveBeenCalledWith("admin");
    const [id, { session, hops: recorded }] = signedIn!;
    expect(id).toBe("admin");
    expect(recorded.map((hop) => hop.id)).toEqual(hops.map((hop) => hop.id));
    expect(recorded.at(-1)).toMatchObject({ id: "principal", ok: true });
    expect(await district.clientFor(session).call("me.get")).toMatchObject({ displayName: "Elaine Park" });
  });

  it("opens EducateOS by itself with launchOnOpen, once, as presenter mode's keys have it", async () => {
    const onTileClick = vi.fn();
    let signedIn: PersonaId | undefined;
    await mount({ initialPersonaId: "teacher", launchOnOpen: true, onTileClick, onSignedIn: (id) => (signedIn = id) });
    await vi.waitFor(() => expect(signedIn).toBe("teacher"), BOOT);
    expect(onTileClick).toHaveBeenCalledOnce();
  });

  it("signs no one in from a portal the visitor left while its launch ran", async () => {
    const onSignedIn = vi.fn();
    let hops = 0;
    await mount({ initialPersonaId: "admin", onSignedIn, onHop: () => (hops += 1) });
    await userEvent.click(getByRole(container, "button", { name: "EducateOS" }));
    act(() => root.unmount());
    await vi.waitFor(() => expect(hops).toBeGreaterThanOrEqual(11), BOOT);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onSignedIn).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  it("says why when the launch is refused, with its steps open", async () => {
    // A district whose Clever district the launch registry doesn't know.
    const unregistered = { ...district, cleverSso: { ...district.cleverSso, districtId: "0".repeat(24) } };
    const onSignedIn = vi.fn();
    await mount({ booted: unregistered, initialPersonaId: "teacher", onSignedIn });
    await userEvent.click(getByRole(container, "button", { name: "EducateOS" }));

    expect(await findByText(container, "EducateOS didn't sign you in", {}, BOOT)).toBeDefined();
    expect(container.textContent).toContain("Your district isn't set up for Clever launch");
    const trigger = getByRole(container, "button", { name: /^Under the hood/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const steps = getByRole(container, "list", { name: "Clever sign-in steps" });
    expect(getAllByRole(steps, "listitem").at(-1)!.textContent).toContain("Didn't pass");
    expect(onSignedIn).not.toHaveBeenCalled();

    // The drawer closes from the keyboard.
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
