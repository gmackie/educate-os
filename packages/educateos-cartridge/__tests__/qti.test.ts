// QTI 2.1 and 3.0 assessments in a Common Cartridge, read as quizzes (SCHO-191). The item files are
// the committed fixtures under `fixtures/qti21` and `fixtures/qti30`; each test packages them with a
// manifest placing them in a module.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planCourseCartridge, readCartridge, readQtiItem } from "../src/index.ts";
import { buildZip } from "./zip-writer.ts";

const FIXTURES = `${import.meta.dirname}/fixtures`;

/** Every file under a fixture directory, as package entries under `prefix`. */
function filesOf(directory: string, prefix: string): { path: string; content: string }[] {
  return readdirSync(`${FIXTURES}/${directory}`).flatMap((name) => {
    const full = `${FIXTURES}/${directory}/${name}`;
    return statSync(full).isDirectory() ? filesOf(`${directory}/${name}`, `${prefix}${name}/`) : [{ path: `${prefix}${name}`, content: readFileSync(full, "utf8") }];
  });
}

const manifest = (items: string, resources: string) => `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="M1" xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imscp_v1p1">
  <metadata><schema>IMS Common Cartridge</schema><schemaversion>1.3.0</schemaversion></metadata>
  <organizations><organization identifier="O1" structure="rooted-hierarchy"><item identifier="root">
    <item identifier="W1"><title>Week 1</title>${items}</item>
  </item></organization></organizations>
  <resources>${resources}</resources>
</manifest>`;

async function plan(items: string, resources: string, extra: { path: string; content: string }[] = []) {
  const bytes = await buildZip([{ path: "imsmanifest.xml", content: manifest(items, resources) }, ...filesOf("qti21", "qti21/"), ...filesOf("qti30", "qti30/"), ...extra]);
  return planCourseCartridge(await readCartridge(bytes));
}

describe("QTI quizzes in a cartridge (SCHO-191)", () => {
  it("reads a QTI 2.1 test's supported items into a quiz in its module, and lists every item it cannot carry", async () => {
    const result = await plan(
      `<item identifier="Q1" identifierref="R1"><title>Weekly check</title></item>`,
      `<resource identifier="R1" type="imsqti_test_xmlv2p1" href="qti21/test.xml"><file href="qti21/test.xml"/></resource>`,
    );
    expect(result.modules).toHaveLength(1);
    const [quiz] = result.modules[0]!.quizzes;
    expect(quiz!.identifier).toBe("Q1");
    expect(quiz!.title).toBe("Cells check-in");
    expect(quiz!.items).toStrictEqual([
      {
        type: "multiple-choice",
        prompt: "Look at the diagram [an animal cell] carefully.\n\nWhich organelle makes most of a cell's ATP?",
        points: 2,
        choices: [{ id: "choicea", text: "Nucleus" }, { id: "choiceb", text: "Mitochondrion" }, { id: "choicec", text: "Ribosome" }],
        correctChoiceId: "choiceb",
      },
      {
        type: "multiple-select",
        prompt: "Which are found in plant cells but not animal cells?",
        points: 3,
        choices: [{ id: "wall", text: "Cell wall" }, { id: "chloro", text: "Chloroplast" }, { id: "centri", text: "Centriole" }],
        correctChoiceIds: ["wall", "chloro"],
        scoring: "partial",
      },
      { type: "true-false", prompt: "Viruses are made of cells.", points: 1, correct: false },
      { type: "numeric", prompt: "How many chromosomes are in a human body cell?", points: 1, answer: 46, tolerance: 0.5 },
      { type: "short-answer", prompt: "Plants make sugar by .", points: 1, acceptedAnswers: ["photosynthesis", "photo-synthesis"] },
      { type: "essay", prompt: "Explain osmosis in your own words.", points: 5 },
    ]);
    expect(result.skipped).toStrictEqual([
      { identifier: "Q1/order", reason: "unsupported-qti-item", type: "orderInteraction" },
      { identifier: "Q1/no-key", reason: "unsupported-qti-item", type: "choiceInteraction-without-key" },
      { identifier: "Q1/gone", reason: "missing-file" },
    ]);
  });

  it("reads QTI 3.0 tests and lone items alike, and keeps choice IDs unique", async () => {
    const result = await plan(
      `<item identifier="Q2" identifierref="R2"><title>Poetry</title></item><item identifier="Q3" identifierref="R3"><title>Warm-up</title></item>`,
      `<resource identifier="R2" type="imsqti_test_xmlv3p0"><file href="qti30/test.xml"/></resource>
       <resource identifier="R3" type="imsqti_item_xmlv3p0"><file href="qti30/items/choice.xml"/></resource>`,
    );
    const [test, lone] = result.modules[0]!.quizzes;
    expect(test!.title).toBe("Poetry terms");
    expect(test!.items.map((item) => item.type)).toStrictEqual(["multiple-choice", "short-answer", "numeric", "essay"]);
    expect(test!.items[0]).toMatchObject({ points: 2, choices: [{ id: "metaphor" }, { id: "simile" }, { id: "c3", text: "Simile (again)" }], correctChoiceId: "simile" });
    expect(test!.items[1]).toStrictEqual({ type: "short-answer", prompt: "The repetition of initial consonant sounds is called .", points: 1, acceptedAnswers: ["alliteration"] });
    // A relative tolerance becomes the absolute one it allows at the answer: 10% of 14.
    expect(test!.items[2]).toMatchObject({ type: "numeric", answer: 14, tolerance: 1.4 });
    expect(test!.items[3]).toStrictEqual({ type: "essay", prompt: "Read the poem.\n\n- Note the volta.\n- Note the couplet.\n\nExplain where the poem turns.", points: 1 });
    expect(result.skipped).toStrictEqual([{ identifier: "Q2/hotspot", reason: "unsupported-qti-item", type: "hotspotInteraction" }]);
    // A lone item is a quiz of one, named by its placement.
    expect(lone).toMatchObject({ identifier: "Q3", title: "Warm-up", items: [{ type: "multiple-choice", correctChoiceId: "simile" }] });
  });

  it("lists a quiz with nothing to carry, and still skips QTI 1.2 assessments as an unsupported type", async () => {
    const result = await plan(
      `<item identifier="Q4" identifierref="R4"><title>Order only</title></item><item identifier="Q5" identifierref="R5"><title>Old quiz</title></item><item identifier="Q6" identifierref="R6"><title>Broken</title></item>`,
      `<resource identifier="R4" type="imsqti_item_xmlv2p1"><file href="qti21/items/order.xml"/></resource>
       <resource identifier="R5" type="imsqti_xmlv1p2/imscc_xmlv1p3/assessment"><file href="old/assessment.xml"/></resource>
       <resource identifier="R6" type="imsqti_item_xmlv2p1"><file href="broken.xml"/></resource>`,
      [{ path: "old/assessment.xml", content: "<questestinterop/>" }, { path: "broken.xml", content: "<assessmentItem><itemBody>" }],
    );
    expect(result.modules).toStrictEqual([]);
    expect(result.skipped).toStrictEqual([
      { identifier: "Q4", reason: "unsupported-qti-item", type: "orderInteraction" },
      { identifier: "Q4", reason: "quiz-without-items", type: "imsqti_item_xmlv2p1" },
      { identifier: "Q5", reason: "unsupported-type", type: "imsqti_xmlv1p2/imscc_xmlv1p3/assessment" },
      { identifier: "Q6", reason: "invalid-qti" },
      { identifier: "Q6", reason: "quiz-without-items", type: "imsqti_item_xmlv2p1" },
    ]);
  });

  it("refuses the package for an item that declares a DOCTYPE or a test that reaches outside it", async () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><assessmentItem><itemBody>&e;</itemBody></assessmentItem>`;
    await expect(plan(
      `<item identifier="Q7" identifierref="R7"><title>x</title></item>`,
      `<resource identifier="R7" type="imsqti_item_xmlv2p1"><file href="xxe.xml"/></resource>`,
      [{ path: "xxe.xml", content: xxe }],
    )).rejects.toMatchObject({ reason: "xml-doctype" });
    const climbing = `<assessmentTest identifier="T" title="T"><testPart identifier="P"><assessmentSection identifier="S"><assessmentItemRef identifier="i" href="../../../etc/passwd"/></assessmentSection></testPart></assessmentTest>`;
    await expect(plan(
      `<item identifier="Q8" identifierref="R8"><title>x</title></item>`,
      `<resource identifier="R8" type="imsqti_test_xmlv2p1"><file href="t/test.xml"/></resource>`,
      [{ path: "t/test.xml", content: climbing }],
    )).rejects.toMatchObject({ reason: "unsafe-path" });
  });

  it("reduces item markup to text and keeps the key it declares, not its response processing", () => {
    const read = readQtiItem(readFileSync(`${FIXTURES}/qti21/items/choice.xml`, "utf8"), "x");
    expect(JSON.stringify(read)).not.toMatch(/<|img|cell\.png/);
  });
});
