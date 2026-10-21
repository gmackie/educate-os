// Walks a teacher's first class in a real browser against a running harness district and saves a
// screenshot of each screen, at desktop and phone widths.
//
//   pnpm schoolos:harness                 (prints a teacher token)
//   pnpm --filter @schoolos/teacher-ui dev
//   node scripts/screenshots.ts <teacher-token> [out-dir] [app-url]
//
// CHROME names a Chromium to use instead of Playwright's headless shell.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const [token, out = "/tmp/schoolos-shots/teacher-ui", app = "http://localhost:4811"] = process.argv.slice(2);
if (token === undefined) throw new Error("usage: node scripts/screenshots.ts <teacher-token> [out-dir] [app-url]");
mkdirSync(out, { recursive: true });

const heading = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name }).waitFor();

const journey = async (page: Page, prefix: string, importUrl: string) => {
  const shot = (name: string) => page.screenshot({ path: join(out, `${prefix}-${name}.png`), fullPage: true });
  await page.goto(`${app}/?token=${encodeURIComponent(token)}#/`);
  await page.getByText(/\d+ students?/).first().waitFor();
  await shot("01-my-classes");

  await page.getByRole("link", { name: /English 9/ }).click();
  await page.getByRole("table").waitFor();
  await shot("02-roster");

  await page.getByRole("link", { name: "Resources", exact: true }).click();
  await heading(page, /^Resources/);
  await page.getByText("Approved for this class").waitFor();
  await page.getByRole("textbox", { name: /Web address/ }).fill(importUrl);
  await page.getByRole("button", { name: "Send for review" }).click();
  await page.getByRole("heading", { name: "Your decision" }).waitFor();
  await shot("03-resource-report");
  await page.getByRole("button", { name: "Approve for this class" }).click();
  await page.getByText("You've decided on this resource.").waitFor();

  await page.getByRole("link", { name: "Create activity", exact: true }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Should homework be optional?");
  await page.getByRole("textbox", { name: "Overview for students" }).fill("Argue for or against optional homework.");
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Take a position on optional homework, and support it with evidence.");
  await page.getByRole("checkbox").first().click();
  await page.getByRole("button", { name: "Add a note" }).click();
  await page.getByRole("textbox", { name: "Note title" }).fill("Watch for");
  await page.getByRole("textbox", { name: "Note", exact: true }).fill("Push for a counterclaim in every essay.");
  await page.getByRole("switch", { name: "Teacher only" }).click();
  await page.getByRole("textbox", { name: "Rubric title" }).fill("Argument basics");
  await page.getByRole("textbox", { name: "Criteria" }).fill("Length\nEvidence");
  await page.getByRole("textbox", { name: /Automatic check/ }).fill("20");
  await shot("04-create-activity");
  await page.getByRole("button", { name: "Sign and use this rubric" }).click();
  await page.getByRole("radio", { name: "Argument basics" }).and(page.locator("[aria-checked=true]")).waitFor();
  await page.getByRole("button", { name: "Preview as student" }).click();
  await page.getByRole("heading", { name: "Preview as a student" }).waitFor();
  await shot("05-student-preview");
  await page.getByRole("button", { name: "Publish and assign" }).click();
  await page.getByText(/is assigned$/).waitFor();
  await shot("06-published");

  await page.getByRole("link", { name: "Submissions", exact: true }).click();
  await page.getByRole("navigation", { name: "Activities" }).getByRole("link").first().click();
  await page.getByRole("link", { name: /^Review / }).first().click();
  await heading(page, /’s work/);
  await page.getByRole("button", { name: "Run checks" }).click();
  await page.getByText(/checks? (met|passed)|of \d+/).first().waitFor().catch(() => undefined);
  await page.getByRole("group").filter({ hasText: "Suggests" }).first().waitFor();
  const firstCriterion = page.getByRole("group").filter({ hasText: "Suggests" }).first();
  await firstCriterion.getByRole("button", { name: /^Use / }).click();
  await firstCriterion.getByRole("button", { name: "Save score" }).click();
  await page.getByText(/Your score:/).first().waitFor();
  await page.getByRole("textbox", { name: "Passage you're commenting on" }).fill("Teenagers need more sleep");
  await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Which research? Name the study.");
  await page.getByRole("button", { name: "Add comment" }).click();
  await page.getByRole("listitem").filter({ hasText: "Which research? Name the study." }).last().waitFor();
  await shot("07-review");
  // The second run reviews the same seeded submission, whose feedback the first run shared.
  const share = page.getByRole("button", { name: "Share feedback with student" });
  if (await share.isVisible()) await share.click();
  await page.getByText("Shared with the student", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Approve official grade" }).click();
  await page.getByRole("dialog").waitFor();
  // Let the dialog finish fading in.
  await page.waitForTimeout(400);
  await shot("08-approve-grade-dialog");
  await page.getByRole("button", { name: "Yes, approve official grade" }).click();
  await page.getByText("Official", { exact: true }).waitFor();
  await shot("09-official-grade");
};

const browser = await chromium.launch(process.env.CHROME === undefined ? {} : { executablePath: process.env.CHROME, args: ["--headless=new"] });
try {
  for (const [prefix, viewport, url] of [
    ["desktop", { width: 1280, height: 900 }, "https://open-lessons.example/proportional-reasoning"],
    ["phone", { width: 390, height: 844 }, "https://open-lessons.example/color-wheel"],
  ] as const) {
    const page = await browser.newPage({ viewport });
    await journey(page, prefix, url);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`screenshots in ${out}`);
