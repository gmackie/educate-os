import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { findByRole, findByText, getAllByRole, getByRole, queryByRole, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DemoApp } from "./DemoApp.tsx";

let root: Root;
let container: HTMLElement;

const mount = async (url: string) => {
  window.history.replaceState(null, "", url);
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root.render(<DemoApp />));
};

beforeEach(async () => {
  await mount("/demo/");
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const BOOT = { timeout: 60_000 };
const banner = () => getByRole(container, "banner", { name: "Demo" });

/** Picks a persona on the picker by the role its card names, such as "Grade 9 student". */
const choose = async (role: string) => {
  await userEvent.click(await findByRole(container, "button", { name: new RegExp(`^${role}`) }));
};

const switchPersona = () => userEvent.click(getByRole(banner(), "button", { name: "Switch persona" }));

/** Opens EducateOS from the Clever portal's tiles, once the district is up. */
const openEducateOS = async () => {
  const tile = await findByRole(container, "button", { name: "EducateOS" });
  await waitFor(() => expect((tile as HTMLButtonElement).disabled).toBe(false), BOOT);
  await userEvent.click(tile);
};

describe("the demo", () => {
  it("offers Northfield's people by grade band, and opens each persona's own app over one shared district", async () => {
    expect(banner().textContent).toContain("Fictional district · everything stays in your browser · AI tutors are simulated");
    for (const band of ["Kindergarten to grade 2", "Grades 3 to 5", "Grades 6 to 8", "Grades 9 to 12", "Family", "District"]) {
      expect(getByRole(container, "region", { name: band })).toBeDefined();
    }
    expect(within(getByRole(container, "region", { name: "Kindergarten to grade 2" })).getByRole("button", { name: /^Grade 1 student/ }).textContent)
      .toContain("Look for: big type, the story read aloud");

    await choose("Grade 1 student");
    expect(await findByRole(container, "heading", { name: "Hi, Mateo Delgado" }, BOOT)).toBeDefined();
    expect(getByRole(banner(), "button", { name: /Things to try 0\/5/ })).toBeDefined();

    await switchPersona();
    await choose("Grade 1 teacher");
    expect(await findByRole(container, "heading", { name: "My classes" }, BOOT)).toBeDefined();
    expect(await findByText(container, "Grade 1 Reading Foundations · Room 7")).toBeDefined();
    expect(queryByRole(container, "button", { name: /^Where grades land/ })).toBeNull();

    await switchPersona();
    await choose("Guardian of Mateo");
    expect(await findByRole(container, "link", { name: "Mateo Delgado" }, BOOT)).toBeDefined();

    await switchPersona();
    await choose("District administrator");
    expect(await findByRole(container, "heading", { name: "Dashboard" }, BOOT)).toBeDefined();
  });

  it("ticks a journey step when its screen shows the thing, not when another screen reads it in passing", async () => {
    await choose("Grade 9 student");
    await userEvent.click(await findByRole(container, "link", { name: "English 9 · Period 3" }, BOOT));
    // The essay coming next has no feedback yet; the one before has its teacher's, released.
    await userEvent.click(await findByRole(container, "link", { name: "What Changes a Character?" }, BOOT));
    expect(await findByText(container, "Submit your work to get feedback.", {}, BOOT)).toBeDefined();
    expect(getByRole(banner(), "button", { name: /Things to try 0\/3/ })).toBeDefined();
    await userEvent.click(getAllByRole(container, "link", { name: "English 9 · Period 3" })[0]!);
    await userEvent.click(await findByRole(container, "link", { name: "Should Community Service Be Required to Graduate?" }, BOOT));
    expect(await findByRole(banner(), "button", { name: /Things to try 1\/3/ }, BOOT)).toBeDefined();

    await switchPersona();
    await choose("Guardian of Mateo");
    await userEvent.click(await findByRole(container, "link", { name: "Mateo Delgado" }, BOOT));
    // His page has read each class for its summary, which is not yet looking at one.
    expect(await findByRole(banner(), "button", { name: /Things to try 1\/2/ }, BOOT)).toBeDefined();
    await userEvent.click(await findByRole(container, "link", { name: "Grade 1 Reading Foundations · Room 7" }, BOOT));
    expect(await findByRole(banner(), "button", { name: /Things to try 2\/2/ }, BOOT)).toBeDefined();
  });

  it("offers a student their band's tutor, simulated and screened, which ticks its step", async () => {
    await choose("Grade 1 student");
    await userEvent.click(await findByRole(container, "link", { name: "Grade 1 Reading Foundations · Room 7" }, BOOT));
    await userEvent.click(await findByRole(container, "link", { name: "Retell The Little Seed" }, BOOT));
    const tutor = await findByRole(container, "complementary", { name: "Reading Buddy (simulated)" }, BOOT);
    expect(tutor.textContent).toContain("Simulated preview — the live district runs this on real AI with safety screening.");
    await userEvent.click(within(tutor).getByRole("button", { name: "Ask Reading Buddy" }));
    const replies = within(tutor).getByRole("group", { name: "Quick replies" });
    await userEvent.click(within(replies).getByRole("button", { name: "What happened first?" }));
    expect(await within(tutor).findByText("Something fell from the clouds. It gave the seed a drink. What was it?")).toBeDefined();
    expect(within(tutor).getByText(/Hall Monitor checked this for grades K–2: allowed/)).toBeDefined();
    expect(await findByRole(banner(), "button", { name: /Things to try 2\/5/ }, BOOT)).toBeDefined();
    await waitFor(() => expect((within(replies).getByRole("button", { name: "Tell me a scary story" }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(within(replies).getByRole("button", { name: "Tell me a scary story" }));
    expect(await within(tutor).findByText(/Not sent to the AI; Reading Buddy steers back kindly/)).toBeDefined();
    // A typed address is the tutor library's to catch: neither sent nor kept.
    await userEvent.type(within(tutor).getByRole("textbox", { name: "Your message" }), "I live at 12 Oak Street{Enter}");
    expect(await within(tutor).findByText(/Neither sent nor kept/)).toBeDefined();
  });

  it("signs a student out to the persona picker, not off the site", async () => {
    await choose("Grade 4 student");
    await findByRole(container, "heading", { name: "Hi, Abena Mensah" }, BOOT);
    await userEvent.click(getByRole(container, "button", { name: "Sign out" }));
    expect(await findByRole(container, "heading", { name: "Try EducateOS" })).toBeDefined();
    expect(window.location.pathname).toBe("/demo/");
    expect(getByRole(banner(), "link", { name: "Back to educateos.io" }).getAttribute("href")).toBe("https://educateos.io/");
  });

  it("walks the K-12 story tour, and in presenter mode the arrows step through it", async () => {
    act(() => root.unmount());
    container.remove();
    await mount("/demo/?presenter");
    const strip = getByRole(container, "region", { name: "K-12 tour" });
    const start = within(strip).getByRole("button", { name: "Start the tour" });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false), BOOT);
    await userEvent.click(start);
    expect(await findByRole(container, "heading", { name: "Retell The Little Seed" }, BOOT)).toBeDefined();
    expect(banner().textContent).toContain("You're Mateo Delgado");
    await userEvent.keyboard("{ArrowRight}");
    expect(await findByRole(container, "heading", { name: /^Submissions · Grade 1 Reading Foundations/ }, BOOT)).toBeDefined();
    expect(banner().textContent).toContain("You're Daniel Yazzie");
    // The class's later units, installed from the course package it continues.
    await userEvent.keyboard("{ArrowRight}");
    expect(await findByRole(container, "heading", { name: "Modules · Grade 1 Reading Foundations · Room 7" }, BOOT)).toBeDefined();
    expect(await findByRole(container, "heading", { name: "Animal Facts" }, BOOT)).toBeDefined();
    expect(container.textContent).toContain("Installed from educateos.io/grade-1-reading-foundations 1.0.0, an Open Course Specification package");
    expect(getByRole(container, "heading", { name: "Add a course" })).toBeDefined();
    await userEvent.keyboard("9");
    expect(await findByRole(container, "heading", { name: "All classes" }, BOOT)).toBeDefined();
    expect(within(strip).getByText("4/9")).toBeDefined();
  });

  it("starts over on reset: back to the picker, with the hash route and progress cleared", async () => {
    await choose("Grade 9 student");
    await findByRole(container, "heading", { name: "Hi, Amara Okafor" }, BOOT);
    await userEvent.click(await findByRole(container, "link", { name: "English 9 · Period 3" }, BOOT));
    await userEvent.click(await findByRole(container, "link", { name: "Should Community Service Be Required to Graduate?" }, BOOT));
    expect(await findByRole(banner(), "button", { name: /Things to try 1\/3/ }, BOOT)).toBeDefined();
    expect(window.location.hash).toMatch(/^#\/courses\/off_nf-eng9-fall-p3\/activities\//);

    await userEvent.click(getByRole(banner(), "button", { name: "Reset demo" }));
    expect(window.location.hash).toBe("");
    expect(queryByRole(banner(), "button", { name: "Switch persona" })).toBeNull();
    expect(await findByRole(container, "heading", { name: "Try EducateOS" })).toBeDefined();
    expect(container.textContent).not.toContain("things to try done");
  });
});

const CLEVER_NOTICE = "Simulated Clever district — runs on our Clever fakes, built to Clever's published v3.1 API. Not connected to Clever.";

describe("the demo's districts", () => {
  it("switches to Cedar Valley, which its administrator rosters from Clever before its teacher and student can sign in", async () => {
    expect(banner().textContent).not.toContain(CLEVER_NOTICE);
    await userEvent.click(getByRole(container, "tab", { name: "Cedar Valley · Clever + Google Classroom" }));
    expect(window.location.search).toBe("?district=cedarvalley");
    expect(banner().textContent).toContain(CLEVER_NOTICE);

    // Cedar Valley is entered through its portal: who you are in Clever, then the EducateOS tile.
    expect(await findByRole(container, "heading", { name: "Cedar Valley USD portal (simulated Clever portal)" }, BOOT)).toBeDefined();
    await choose("Grade 8 student");
    await openEducateOS();
    expect(await findByRole(container, "heading", { name: "Cedar Valley USD hasn't synced from Clever yet" }, BOOT)).toBeDefined();
    // The sign-in itself worked, and its steps are there to look at.
    await userEvent.click(await findByRole(container, "button", { name: /^Under the hood/ }));
    expect(getByRole(container, "list", { name: "Clever sign-in steps" }).children).toHaveLength(11);
    await userEvent.click(getByRole(container, "button", { name: "Sign in as Elaine Park" }));
    expect(getByRole(container, "button", { name: "Sign out of the portal" })).toBeDefined();
    await openEducateOS();
    // The administrator lands on the console's own Roster sync screen, where the first sync is run.
    expect(await findByRole(container, "heading", { name: "Roster sync" }, BOOT)).toBeDefined();
    expect(window.location.hash).toBe("#/roster-sync");
    await userEvent.click(await findByRole(container, "button", { name: "Run complete sync" }, BOOT));
    const result = await findByRole(container, "region", { name: "Complete sync just now" }, BOOT);
    expect(within(result).getByText("The roster is up to date")).toBeDefined();

    await switchPersona();
    await choose("Earth Science and Algebra teacher");
    await openEducateOS();
    expect(await findByRole(container, "heading", { name: "My classes" }, BOOT)).toBeDefined();
    expect(await findByText(container, "Earth Science 8 · Whitaker", {}, BOOT)).toBeDefined();
    // Cedar Valley passes approved grades back to a gradebook, and shows the teacher where they landed.
    expect(await findByRole(container, "button", { name: /^Where grades land/ }, BOOT)).toBeDefined();

    await switchPersona();
    await choose("Grade 8 student");
    await openEducateOS();
    expect(await findByRole(container, "heading", { name: "Hi, Rowan Ellis" }, BOOT)).toBeDefined();
    // The notice stays on every screen of the district.
    expect(banner().textContent).toContain(CLEVER_NOTICE);

    await switchPersona();
    await userEvent.click(getByRole(container, "tab", { name: "Northfield · OneRoster + Canvas" }));
    expect(window.location.search).toBe("");
    expect(banner().textContent).not.toContain(CLEVER_NOTICE);
    expect(await findByRole(container, "button", { name: /^Grade 9 student/ })).toBeDefined();
  });

  it("opens Cedar Valley from a link, and reset boots it again unrostered", async () => {
    act(() => root.unmount());
    container.remove();
    await mount("/demo/?district=cedarvalley");
    expect(banner().textContent).toContain(CLEVER_NOTICE);
    await choose("District administrator");
    await openEducateOS();
    await userEvent.click(await findByRole(container, "button", { name: "Run complete sync" }, BOOT));
    await findByRole(container, "region", { name: "Complete sync just now" }, BOOT);

    await userEvent.click(getByRole(banner(), "button", { name: "Reset demo" }));
    expect(window.location.search).toBe("?district=cedarvalley");
    await choose("Earth Science and Algebra teacher");
    await openEducateOS();
    expect(await findByRole(container, "heading", { name: "Cedar Valley USD hasn't synced from Clever yet" }, BOOT)).toBeDefined();
  });

  it("changes Cedar Valley in Clever from its Clever side, and a delta sync in Roster sync brings the changes in", async () => {
    act(() => root.unmount());
    container.remove();
    await mount("/demo/?district=cedarvalley");
    await choose("Earth Science and Algebra teacher");
    await openEducateOS();
    expect(await findByRole(container, "heading", { name: "Cedar Valley USD hasn't synced from Clever yet" }, BOOT)).toBeDefined();
    const side = getByRole(container, "complementary", { name: "Clever side" });
    await userEvent.click(getByRole(side, "button", { name: "Clever side" }));
    // Nothing can change in Clever before the first sync; the panel takes the visitor to it as the
    // administrator, signing her in through the portal's Instant Login on the way.
    await userEvent.click(getByRole(side, "button", { name: "Open Roster sync as Elaine Park" }));
    expect(await findByRole(container, "heading", { name: "Roster sync" }, BOOT)).toBeDefined();
    expect(banner().textContent).toContain("You're Elaine Park");
    await userEvent.click(await findByRole(container, "button", { name: "Run complete sync" }, BOOT));
    await findByRole(container, "region", { name: "Complete sync just now" }, BOOT);

    const earthScience = await findByRole(side, "region", { name: "Earth Science 8 - Whitaker" }, BOOT);
    await userEvent.click(getByRole(earthScience, "button", { name: "Change Bao Nguyen in Earth Science 8 - Whitaker" }));
    await userEvent.click(await findByRole(document.body, "menuitem", { name: "Withdraw from the district" }));
    await userEvent.click(getByRole(side, "button", { name: "Add a new student to Algebra I - Whitaker" }));
    const pending = getByRole(side, "region", { name: "Pending in Clever" });
    expect(within(pending).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Withdrew Bao Nguyen from the district",
      "Added Maya Chen to Algebra I - Whitaker",
    ]);
    expect(within(pending).getByText("Run a delta sync in Roster sync to bring these in.")).toBeDefined();

    await userEvent.click(getByRole(container, "button", { name: "Run delta sync" }));
    const result = await findByRole(container, "region", { name: "Delta sync just now" }, BOOT);
    // People added, updated, deactivated: Maya Chen in, Bao Nguyen out, and no one else.
    expect(within(result).getByRole("row", { name: /^People 1 0 1$/ })).toBeDefined();
    expect(await findByText(pending, "Nothing waiting: Cedar Valley has every change Clever has.", {}, BOOT)).toBeDefined();

    // The teacher's classes show it on their next load.
    await switchPersona();
    await choose("Earth Science and Algebra teacher");
    await openEducateOS();
    expect(await findByRole(container, "heading", { name: "My classes" }, BOOT)).toBeDefined();
  });
});

const tour = () => getByRole(container, "region", { name: "Clever tour" });
/** Waits for the banner's tour progress to read `n` of 7. */
const progress = (n: number) => findByRole(banner(), "button", { name: new RegExp(`^Clever tour ${n}/7$`) }, BOOT);
/** The tour's step `n`, counting from 1, once its panel is open. */
const stepItem = (n: number) => within(tour()).getAllByRole("listitem")[n - 1]!;

describe("Cedar Valley's Clever tour", () => {

  beforeEach(async () => {
    act(() => root.unmount());
    container.remove();
  });

  it("follows the visitor from the portal through the first sync, a change in Clever and the delta sync", async () => {
    await mount("/demo/?district=cedarvalley");
    expect(await progress(0)).toBeDefined();
    expect(within(tour()).getByText("Step 1: Sign in to the district portal as Elaine Park and open EducateOS")).toBeDefined();

    const showMe = within(tour()).getByRole("button", { name: "Open the portal as Elaine Park" });
    // Show me waits for the district, which boots in the page.
    await waitFor(() => expect((showMe as HTMLButtonElement).disabled).toBe(false), BOOT);
    await userEvent.click(showMe);
    expect(await findByText(container, "Signed in to the portal as Elaine Park", {}, BOOT)).toBeDefined();
    await openEducateOS();
    expect(await progress(2)).toBeDefined();
    expect(await findByRole(container, "heading", { name: "Roster sync" }, BOOT)).toBeDefined();
    await userEvent.click(await findByRole(container, "button", { name: "Run complete sync" }, BOOT));
    expect(await progress(3)).toBeDefined();

    // Open, every step is explained, the first sync with what it really brought in.
    await userEvent.click(within(tour()).getByRole("button", { name: "Clever tour" }));
    expect(stepItem(3).textContent).toMatch(/\(done\)The complete sync brought in 8 people, 4 classes/);
    expect(stepItem(4).getAttribute("aria-current")).toBe("step");
    await userEvent.click(within(stepItem(4)).getByRole("button", { name: "Show me: Open the Clever side" }));
    const side = getByRole(container, "complementary", { name: "Clever side" });
    const earthScience = await findByRole(side, "region", { name: "Earth Science 8 - Whitaker" }, BOOT);
    await userEvent.click(getByRole(earthScience, "button", { name: "Change Bao Nguyen in Earth Science 8 - Whitaker" }));
    await userEvent.click(await findByRole(document.body, "menuitem", { name: "Withdraw from the district" }));
    expect(await progress(4)).toBeDefined();

    await userEvent.click(within(stepItem(5)).getByRole("button", { name: "Show me: Open Roster sync" }));
    await userEvent.click(await findByRole(container, "button", { name: "Run delta sync" }, BOOT));
    expect(await progress(5)).toBeDefined();
    expect(stepItem(5).textContent).toContain("people 0 added, 0 updated, 1 deactivated");
    expect(stepItem(6).getAttribute("aria-current")).toBe("step");

    // Show me for the teacher's steps opens her app, signing her in through the portal, rather
    // than leaving the visitor at the portal (SCHO-284).
    await userEvent.click(within(stepItem(6)).getByRole("button", { name: "Show me: Open Dana Whitaker's Earth Science 8" }));
    expect(await findByRole(container, "heading", { name: /^Submissions · Earth Science 8/ }, BOOT)).toBeDefined();
    expect(banner().textContent).toContain("You're Dana Whitaker");
    await userEvent.click(within(stepItem(7)).getByRole("button", { name: "Show me: Open Where grades land as Dana Whitaker" }));
    expect(await findByRole(container, "region", { name: "Each class's route" }, BOOT)).toBeDefined();
  });

  it("in presenter mode keeps only the titles, jumps to a step, switches persona by key and starts over", async () => {
    await mount("/demo/?district=cedarvalley&presenter");
    await userEvent.click(within(tour()).getByRole("button", { name: "Clever tour" }));
    expect(stepItem(3).textContent).toBe("3. Run a complete Clever sync from Roster sync (not done yet)Jump");
    expect(tour().textContent).not.toContain("Cedar Valley starts empty");

    // Jumping to Dana's grading runs the first sync for real and signs her in through the portal.
    const jump = within(tour()).getByRole("button", { name: "Jump to step 6" });
    await waitFor(() => expect((jump as HTMLButtonElement).disabled).toBe(false), BOOT);
    await userEvent.click(jump);
    expect(await findByRole(container, "heading", { name: /^Submissions · Earth Science 8/ }, BOOT)).toBeDefined();
    expect(stepItem(2).textContent).toContain("(done)");
    expect(stepItem(3).textContent).toContain("(done)");
    expect(stepItem(1).textContent).toContain("(not done yet)");

    // 1 signs Elaine in through the portal: her tile, her Clever sign-in.
    await userEvent.keyboard("1");
    expect(await findByRole(container, "heading", { name: "Dashboard" }, BOOT)).toBeDefined();
    expect(banner().textContent).toContain("You're Elaine Park");
    expect(stepItem(1).textContent).toContain("(done)");

    await userEvent.keyboard("?");
    expect(await findByText(document.body, "Presenter shortcuts", {}, BOOT)).toBeDefined();
    await userEvent.keyboard("{Escape}");

    // Start over: a fresh, unrostered Cedar Valley and the tour back at step 1.
    await userEvent.click(within(tour()).getByRole("button", { name: "Start over" }));
    expect(await progress(0)).toBeDefined();
    expect(stepItem(1).getAttribute("aria-current")).toBe("step");
    expect(window.location.search).toBe("?district=cedarvalley&presenter");
    expect(await findByRole(container, "heading", { name: "Cedar Valley USD portal (simulated Clever portal)" }, BOOT)).toBeDefined();
    await waitFor(() => expect((within(tour()).getByRole("button", { name: "Jump to step 1" }) as HTMLButtonElement).disabled).toBe(false), BOOT);
    await userEvent.keyboard("2");
    expect(await findByRole(container, "heading", { name: "Cedar Valley USD hasn't synced from Clever yet" }, BOOT)).toBeDefined();
  });
});
