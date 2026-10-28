import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@gadgets/ui/theme";
import type { SchoolManifest } from "./manifest.ts";
import { SchoolShell, type SchoolShellProps } from "./SchoolShell.tsx";
import { EDUCATEOS_THEME_STORAGE_KEY, educateosThemeMode } from "./theme.ts";
import { setViewport } from "./testing/viewport.ts";

const NORTHFIELD: SchoolManifest = {
  v: 1,
  name: "Northfield",
  origin: "https://northfield.educateos.io",
  brand: { logo: "/brand/logo.svg", accent: "#2458ac" },
  signIn: [],
  features: { ai: true, mobile: true, family: true },
};

let mounted: { root: Root; container: HTMLElement } | undefined;

const render = (props: Partial<SchoolShellProps> = {}, children: ReactNode = <p>Due today</p>) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const announced: string[] = [];
  act(() =>
    root.render(
      <ThemeProvider source={educateosThemeMode()}>
        <SchoolShell
          school={NORTHFIELD}
          role="student"
          user={{ name: "Ava Chen" }}
          location={{ pathname: "/", hash: "" }}
          onAnnounce={(message) => announced.push(message)}
          {...props}
        >
          {children}
        </SchoolShell>
      </ThemeProvider>,
    ),
  );
  mounted = { root, container };
  return { container, announced, user: userEvent.setup() };
};

afterEach(() => {
  if (mounted !== undefined) {
    const { root, container } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = undefined;
  }
});

const nav = () => screen.getByRole("navigation", { name: "Main" });

describe("SchoolShell on a wide screen", () => {
  it("draws the school's brand, the role's navigation, the user and the content in landmarks", () => {
    const { container } = render();
    expect(container.querySelector("[data-layout]")?.getAttribute("data-layout")).toBe("wide");
    const banner = screen.getByRole("banner");
    expect(within(banner).getByRole("link", { name: "Northfield" }).getAttribute("href")).toBe("/");
    expect(within(nav()).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Home", "Classes", "Calendar", "Inbox", "Grades", "AI workspace", "My Space",
    ]);
    expect(within(nav()).getByRole("list", { name: "Workspace" })).toBeTruthy();
    expect(screen.getByRole("main").textContent).toBe("Due today");
    expect(screen.getByRole("button", { name: /Ava Chen.*Student/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main");
  });

  it("marks exactly the entry for where the browser is as the current page", () => {
    render({ location: { pathname: "/courses/bio-9", hash: "" } });
    const current = within(nav()).getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.textContent)).toEqual(["Classes"]);
  });

  it("names a badge's count to assistive technology", () => {
    render({ badges: { inbox: 3 } });
    expect(within(nav()).getByRole("link", { name: /^Inbox,? ?3 new$|^Inbox , 3 new$/ }).getAttribute("href")).toBe("/notifications");
  });

  it("offers no AI entry when the district has no AI", () => {
    render({ school: { ...NORTHFIELD, features: { ...NORTHFIELD.features, ai: false } } });
    expect(within(nav()).queryByRole("link", { name: /AI/ })).toBeNull();
  });

  it("waits for the role before offering any place", () => {
    render({ role: undefined, user: undefined });
    expect(within(nav()).queryAllByRole("link")).toEqual([]);
  });

  it("puts the school's accent in force and takes it away again", () => {
    render();
    expect(document.documentElement.style.getPropertyValue("--color-kumo-brand")).toContain("#2458ac");
    act(() => mounted?.root.unmount());
    mounted?.container.remove();
    mounted = undefined;
    expect(document.documentElement.style.getPropertyValue("--color-kumo-brand")).toBe("");
  });

  it("opens the user menu from the keyboard with Connect phone, Your devices and sign out, and closes it on Escape", async () => {
    const { user } = render();
    const account = screen.getByRole("button", { name: /Ava Chen/ });
    expect(account.getAttribute("aria-expanded")).toBe("false");
    account.focus();
    await user.keyboard("{Enter}");
    expect(account.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("list", { name: "Account" });
    expect(within(menu).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Connect phone", "/devices/connect"],
      ["Your devices", "/devices"],
      ["Sign out", "/cdn-cgi/access/logout"],
    ]);
    within(menu).getByRole("link", { name: "Connect phone" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("list", { name: "Account" })).toBeNull();
    expect(document.activeElement).toBe(account);
  });

  it("offers phone pairing only where the district has the mobile app", async () => {
    const { user } = render({ school: { ...NORTHFIELD, features: { ...NORTHFIELD.features, mobile: false } } });
    await user.click(screen.getByRole("button", { name: /Ava Chen/ }));
    expect(within(screen.getByRole("list", { name: "Account" })).getAllByRole("link").map((link) => link.textContent)).toEqual(["Sign out"]);
  });

  it("switches the one shared theme, remembering it under the EducateOS key", async () => {
    const { user, announced } = render();
    await user.click(screen.getByRole("button", { name: /^Theme: system/ }));
    expect(EDUCATEOS_THEME_STORAGE_KEY).toBe("educateos:theme-mode");
    expect(localStorage.getItem(EDUCATEOS_THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.getAttribute("data-mode")).toBe("light");
    expect(announced).toEqual(["Theme: light"]);
  });

  it("opens an Operations link in a new tab for a school admin", () => {
    render({ role: "school-admin", features: { ai: true, operationsUrl: "https://admin.educateos.io/" }, location: { pathname: "/admin/", hash: "#/roster" } });
    const operations = within(nav()).getByRole("link", { name: /Operations/ });
    expect(operations.getAttribute("target")).toBe("_blank");
    expect(operations.getAttribute("rel")).toBe("noopener noreferrer");
    expect(within(nav()).getByRole("link", { name: "Roster" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Northfield" }).getAttribute("href")).toBe("/teach/");
  });

  it("draws links with the SPA's own link component", () => {
    render({ renderLink: ({ children, ...props }) => <a data-routed="yes" {...props}>{children}</a> });
    expect(within(nav()).getAllByRole("link").every((link) => link.getAttribute("data-routed") === "yes")).toBe(true);
  });

  it("gives a fill layout's content the whole pane and leaves the main landmark to it", () => {
    const { container } = render({ layout: "fill" }, <main>Threads</main>);
    const frame = container.querySelector("[data-content]");
    expect(frame?.getAttribute("data-content")).toBe("fill");
    expect(frame?.classList.contains("h-full")).toBe(true);
    expect(frame?.classList.contains("min-h-dvh")).toBe(false);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("main").textContent).toBe("Threads");
    expect(container.querySelector("#main")?.classList.contains("max-w-5xl")).toBe(false);
  });
});

describe("SchoolShell on a narrow screen", () => {
  it("folds the sidebar into a top bar whose drawer traps focus, closes on Escape and returns focus", async () => {
    setViewport("narrow");
    const { container, user } = render();
    expect(container.querySelector("[data-layout]")?.getAttribute("data-layout")).toBe("narrow");
    expect(screen.queryByRole("navigation")).toBeNull();
    const open = within(screen.getByRole("banner")).getByRole("button", { name: "Open menu" });
    expect(open.getAttribute("aria-expanded")).toBe("false");

    open.focus();
    await user.keyboard("{Enter}");
    const drawer = screen.getByRole("dialog", { name: "Menu" });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(within(drawer).getByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.getByRole("main", { hidden: true }).closest("[inert]")).not.toBeNull();

    // Tab and Shift+Tab stay inside the drawer.
    for (let step = 0; step < 15; step += 1) {
      await user.tab();
      expect(drawer.contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(drawer.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it("closes the drawer when one of its links is followed", async () => {
    setViewport("narrow");
    const { user } = render({ renderLink: ({ children, onClick, ...props }) => <a {...props} onClick={(event) => { event.preventDefault(); onClick?.(event); }}>{children}</a> });
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("link", { name: "Grades" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
