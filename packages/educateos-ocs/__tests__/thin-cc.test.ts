import { CartridgeImport, planCartridgeImport, readCartridge } from "@educateos/cartridge";
import { ResourceId } from "@educateos/contracts";
import { writeZip } from "@educateos/portability";
import { describe, expect, it } from "vitest";
import { cartridgeFromOcs, ocsFromCartridge, type OcsCodexNote, readPackage, type ReleasedLink } from "../src/index.ts";
import { activity, IDS, packageFiles, resource, unit } from "./helpers.ts";

const encoder = new TextEncoder();
const zip = (files: ReadonlyMap<string, string>) => writeZip([...files].map(([path, text]) => ({ path, bytes: encoder.encode(text) })));

/** A cartridge import record of `bytes`, as the importer stores one. */
async function imported(bytes: Uint8Array) {
  const plan = planCartridgeImport(await readCartridge(bytes));
  return CartridgeImport.parse({
    id: "cci_adapter-test",
    districtId: "dst_northfield",
    revision: 1,
    targetScope: { level: "district", districtId: "dst_northfield" },
    fileName: "course.imscc",
    importedBy: "prn_nf-morgan-lee",
    importedAt: "2026-10-21T09:00:00Z",
    ...plan,
  });
}

const LOCATORS: Record<string, string> = {
  rsc_cells: "https://open-lessons.example/cells",
  rsc_osmosis: "https://open-lessons.example/osmosis",
};
const locate = async (release: { resourceId: string }) => LOCATORS[release.resourceId];

const answerKey: OcsCodexNote = { id: "key", title: "Answer key", body: "SECRET-ANSWERS", purpose: "answer-key", visibility: "teacher-only" };

describe("OCS to Thin CC", () => {
  it("carries units and released links, lists everything else, and reads back as a Thin CC", async () => {
    const pkg = await readPackage(packageFiles({
      manifest: {
        id: IDS.course,
        version: "1.0.0",
        title: "Biology 9",
        modules: [{ name: "safety", package: IDS.safety, range: "^1.0.0" }],
        outline: [{ kind: "unit", unit: "cells" }, { kind: "unit", unit: "transport" }, { kind: "module", module: "safety" }],
      },
      units: [
        unit("cells", [{ kind: "resource", ref: "cells" }, { kind: "activity", ref: "lab" }, { kind: "codex", ref: "key" }], "Cells & membranes"),
        unit("transport", [{ kind: "resource", ref: "osmosis" }, { kind: "resource", ref: "sim" }, { kind: "resource", ref: "lost" }], "Transport"),
      ],
      resources: [
        resource("cells", "link"),
        resource("osmosis", "embed"),
        resource("lost", "link"),
        { kind: "gadget-blueprint", id: "sim", title: "Osmosis simulator", release: { resourceId: ResourceId.parse("rsc_sim"), version: "1.0.0" }, releaseCommit: "a".repeat(40), use: "link" },
      ],
      activities: [activity("lab", "adf_osmosis-lab")],
      codex: [answerKey],
    }));
    const { files, losses } = await cartridgeFromOcs(pkg, locate);
    expect(losses.toSorted((a, b) => a.at.localeCompare(b.at))).toStrictEqual([
      { kind: "activity", at: "cells#lab" },
      { kind: "codex-note", at: "cells#key" },
      { kind: "modules", at: IDS.course },
      { kind: "resource-without-locator", at: "transport#lost" },
      { kind: "rights-use", at: "transport#osmosis" },
      { kind: "gadget-blueprint", at: "transport#sim" },
    ].toSorted((a, b) => a.at.localeCompare(b.at)));
    // Nothing teacher-only or executable leaves.
    expect([...files.values()].join("\n")).not.toContain("SECRET-ANSWERS");
    expect([...files.keys()].toSorted()).toStrictEqual(["WL_1/weblink.xml", "WL_2/weblink.xml", "imsmanifest.xml"]);

    const record = await imported(await zip(files));
    expect(record.profile).toBe("thin-common-cartridge");
    expect(record.links.map((link) => [link.title, link.url])).toStrictEqual([
      ["Resource cells", "https://open-lessons.example/cells"],
      ["Resource osmosis", "https://open-lessons.example/osmosis"],
    ]);
    expect(record.outline).toStrictEqual([
      { kind: "module", identifier: "U_cells", title: "Cells & membranes", children: [{ kind: "link", identifier: "I_1", linkId: "lnk-1" }] },
      { kind: "module", identifier: "U_transport", title: "Transport", children: [{ kind: "link", identifier: "I_2", linkId: "lnk-2" }] },
    ]);
  });
});

const NESTED_CARTRIDGE = new Map([
  ["imsmanifest.xml", `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="M_1" xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imscp_v1p1" xmlns:lomimscc="http://ltsc.ieee.org/xsd/imsccv1p3/LOM/manifest">
  <metadata><schema>IMS Thin Common Cartridge</schema><schemaversion>1.3.0</schemaversion>
    <lomimscc:lom><lomimscc:general><lomimscc:title><lomimscc:string>Ecosystems (synthetic)</lomimscc:string></lomimscc:title></lomimscc:general></lomimscc:lom>
  </metadata>
  <organizations><organization identifier="O_1" structure="rooted-hierarchy"><item identifier="LearningModules">
    <item identifier="I_WEEK1"><title>Week 1</title>
      <item identifier="I_A" identifierref="WL_1"><title>Producers</title></item>
      <item identifier="I_DEEP"><title>Extra</title><item identifier="I_B" identifierref="WL_2"><title>Plants</title></item></item>
      <item identifier="I_SIM" identifierref="LTI_1"><title>Simulator</title></item>
    </item>
    <item identifier="I_WEEK2"><title>Week 2</title><item identifier="I_C" identifierref="WL_3"><title>Consumers</title></item></item>
  </item></organization></organizations>
  <resources>
    <resource identifier="WL_1" type="imswl_xmlv1p3"><file href="WL_1/weblink.xml"/></resource>
    <resource identifier="WL_2" type="imswl_xmlv1p3"><file href="WL_2/weblink.xml"/></resource>
    <resource identifier="WL_3" type="imswl_xmlv1p3"><file href="WL_3/weblink.xml"/></resource>
    <resource identifier="LTI_1" type="imsbasiclti_xmlv1p3"><file href="LTI_1/basiclti.xml"/></resource>
  </resources>
</manifest>`],
  ["WL_1/weblink.xml", `<webLink xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imswl_v1p3"><title>Producers</title><url href="https://open-lessons.example/producers"/></webLink>`],
  ["WL_2/weblink.xml", `<webLink xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imswl_v1p3"><title>&lt;script&gt;alert(1)&lt;/script&gt;</title><url href="https://open-lessons.example/plants"/></webLink>`],
  ["WL_3/weblink.xml", `<webLink xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imswl_v1p3"><title>Consumers</title><url href="https://open-lessons.example/consumers"/></webLink>`],
  ["LTI_1/basiclti.xml", `<cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p3" xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0"><blti:title>Sim</blti:title><blti:launch_url>https://sim.tools.example/launch</blti:launch_url></cartridge_basiclti_link>`],
]);

const released = (resourceId: string, use: ReleasedLink["use"] = "link"): ReleasedLink => ({ resourceId: ResourceId.parse(resourceId), version: "1.0.0", use });

describe("Thin CC to OCS", () => {
  it("makes a unit of each top-level module holding its released links, and lists what it could not carry", async () => {
    const record = await imported(await zip(NESTED_CARTRIDGE));
    const { files, pkg, losses } = await ocsFromCartridge(record, {
      packageId: "northfield.example/ecosystems",
      version: "1.0.0",
      language: "en",
      released: new Map([["lnk-1", released("rsc_producers")], ["lnk-2", released("rsc_plants", "embed")]]),
    });
    expect(pkg.manifest).toMatchObject({ id: "northfield.example/ecosystems", title: "Ecosystems (synthetic)", outline: [{ kind: "unit", unit: "u-i-week1" }] });
    expect(pkg.units.get("u-i-week1")).toMatchObject({ title: "Week 1", items: [{ kind: "resource", ref: "lnk-1" }, { kind: "resource", ref: "lnk-2" }] });
    // The hostile title is replaced, so the package stays plain text and readable.
    expect(pkg.resources.get("lnk-2")).toMatchObject({ title: "Untitled", use: "embed", release: { resourceId: "rsc_plants" } });
    expect(Object.keys(files).toSorted()).toStrictEqual(["ocs.json", "resources/lnk-1.json", "resources/lnk-2.json", "units/u-i-week1.json"]);
    expect(losses).toStrictEqual([
      { kind: "nested-module-flattened", at: "I_DEEP" },
      { kind: "title-replaced", at: "lnk-2" },
      { kind: "lti-tool", at: "I_SIM" },
      { kind: "link-not-released", at: "I_C" },
    ]);
  });

  it("refuses a cartridge none of whose links is released", async () => {
    const record = await imported(await zip(NESTED_CARTRIDGE));
    await expect(ocsFromCartridge(record, { packageId: "northfield.example/ecosystems", version: "1.0.0", language: "en", released: new Map() }))
      .rejects.toMatchObject({ code: "validation-failed" });
  });
});
