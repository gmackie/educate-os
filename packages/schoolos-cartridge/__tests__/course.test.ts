import { describe, expect, it } from "vitest";
import { courseCartridgeFiles, courseCartridgePackage, pageTextFromHtml, planCourseCartridge, readCartridge, type CourseCartridgeExport } from "../src/index.ts";
import { buildZip } from "./zip-writer.ts";

const COURSE: CourseCartridgeExport = {
  title: "Biology I: Cells & Systems",
  language: "en",
  modules: [
    {
      title: "Unit 1: <Cells>",
      items: [
        { kind: "page", title: "Welcome", body: "# Welcome\n\nRead **chapter 1** & bring \"goggles\".\n\n- one\n- two <3" },
        { kind: "link", title: "Cell atlas", url: "https://open-lessons.example/cell-atlas?x=1&y=2" },
      ],
    },
    { title: "Unit 2: Osmosis", items: [{ kind: "page", title: "Lab", body: "Potato cubes in salt water." }] },
  ],
};

describe("course cartridges (SCHO-186)", () => {
  it("round-trips a course's modules, pages and links through a Common Cartridge 1.3 package", async () => {
    const bytes = await courseCartridgePackage(COURSE);
    const pkg = await readCartridge(bytes);
    expect(pkg.manifest).toMatchObject({ profile: "common-cartridge", schemaVersion: "1.3.0" });
    const plan = planCourseCartridge(pkg);
    expect(plan.title).toBe(COURSE.title);
    expect(plan.skipped).toStrictEqual([]);
    expect(plan.modules.map((m) => ({ title: m.title, items: m.items.map(({ identifier: _, ...item }) => item) }))).toStrictEqual(COURSE.modules);
  });

  it("writes the same package for the same course", async () => {
    expect(await courseCartridgePackage(COURSE)).toStrictEqual(await courseCartridgePackage(COURSE));
    expect([...courseCartridgeFiles(COURSE).keys()].toSorted()).toStrictEqual(["imsmanifest.xml", "links/link-2.xml", "pages/page-1.html", "pages/page-3.html"]);
  });

  it("reduces another LMS's HTML pages to text, skipping tools, refused links and other resources", async () => {
    const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="M1" xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imscp_v1p1" xmlns:lomimscc="http://ltsc.ieee.org/xsd/imsccv1p3/LOM/manifest">
  <metadata><schema>IMS Common Cartridge</schema><schemaversion>1.3.0</schemaversion></metadata>
  <organizations><organization identifier="O1" structure="rooted-hierarchy"><item identifier="root">
    <item identifier="W1"><title>Week 1</title>
      <item identifier="I1" identifierref="R1"><title>Intro</title></item>
      <item identifier="SUB"><title>Extra</title><item identifier="I2" identifierref="R2"><title>Unsafe link</title></item></item>
      <item identifier="I3" identifierref="R3"><title>Tool</title></item>
      <item identifier="I4" identifierref="R4"><title>Quiz</title></item>
    </item>
    <item identifier="I5" identifierref="R5"><title>Loose link</title></item>
  </item></organization></organizations>
  <resources>
    <resource identifier="R1" type="webcontent" href="web/intro.html"><file href="web/intro.html"/></resource>
    <resource identifier="R2" type="imswl_xmlv1p3"><file href="l2.xml"/></resource>
    <resource identifier="R3" type="imsbasiclti_xmlv1p3"><file href="t3.xml"/></resource>
    <resource identifier="R4" type="imsqti_xmlv1p2/imscc_xmlv1p3/assessment"><file href="q4.xml"/></resource>
    <resource identifier="R5" type="imswl_xmlv1p3"><file href="l5.xml"/></resource>
  </resources>
</manifest>`;
    const link = (url: string) => `<webLink xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imswl_v1p3"><title>L</title><url href="${url}"/></webLink>`;
    const bytes = await buildZip([
      { path: "imsmanifest.xml", content: manifest },
      { path: "web/intro.html", content: `<html><head><style>p{}</style><script>alert(1)</script></head><body><h2>Hello</h2><p>Plants &amp; <b>light</b>.</p><ul><li>One</li></ul></body></html>` },
      { path: "l2.xml", content: link("http://10.0.0.1/admin") },
      { path: "t3.xml", content: `<cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p3" xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0"><blti:title>T</blti:title><blti:launch_url>https://tool.example/launch</blti:launch_url></cartridge_basiclti_link>` },
      { path: "q4.xml", content: "<questestinterop/>" },
      { path: "l5.xml", content: link("https://open-lessons.example/loose") },
    ]);
    const plan = planCourseCartridge(await readCartridge(bytes));
    expect(plan.modules.map((m) => [m.title, m.items.map((i) => i.title)])).toStrictEqual([
      ["Untitled", ["Loose link"]],
      ["Week 1", ["Intro"]],
    ]);
    const intro = plan.modules[1]!.items[0]!;
    expect(intro).toMatchObject({ kind: "page", body: "## Hello\n\nPlants & light.\n\n- One" });
    expect(plan.skipped.map((s) => [s.identifier, s.reason])).toStrictEqual([
      ["I2", "link-refused"],
      ["I3", "lti-tool"],
      ["I4", "unsupported-type"],
    ]);
    expect(plan.flattened).toStrictEqual(["SUB"]);
  });

  it("keeps Markdown SchoolOS wrote verbatim, entities and all", () => {
    expect(pageTextFromHtml(`<pre class="schoolos-markdown">a &#60;b&#62; &#38; c</pre>`)).toBe("a <b> & c");
  });
});
