// A Thin Common Cartridge import into a district app's own Content Studio. The district app has no
// cartridge route yet, so the importer is built here over the app's Content Studio storage and
// policy engine: whatever it submits lands in the same review queue a URL import does.
import { assertToolLaunchable, CartridgeImporter, InMemoryCartridgeImportStorage } from "@schoolos/cartridge";
import { catalogAlignmentSource, ContentStudio } from "@schoolos/content-studio";
import type { Authorizer } from "@schoolos/contracts";
import { writeZip } from "@schoolos/portability";
import { callerOf, offeringScope, type PilotDistrict } from "./support.ts";

const encoder = new TextEncoder();
const now = () => new Date().toISOString();

/** The one web link the cartridge carries: a page the synthetic web serves. */
export const CARTRIDGE_LINK = "https://open-lessons.example/osmosis-lab";

const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="M_PILOT"
    xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imscp_v1p1"
    xmlns:lomimscc="http://ltsc.ieee.org/xsd/imsccv1p3/LOM/manifest">
  <metadata>
    <schema>IMS Thin Common Cartridge</schema>
    <schemaversion>1.3.0</schemaversion>
    <lomimscc:lom>
      <lomimscc:general>
        <lomimscc:title><lomimscc:string language="en-US">Osmosis Unit (synthetic)</lomimscc:string></lomimscc:title>
      </lomimscc:general>
    </lomimscc:lom>
  </metadata>
  <organizations>
    <organization identifier="O_1" structure="rooted-hierarchy">
      <item identifier="LearningModules">
        <item identifier="I_WEEK1"><title>Week 1: Osmosis</title>
          <item identifier="I_READ" identifierref="WL_1"><title>Osmosis reading</title></item>
          <item identifier="I_SIM" identifierref="LTI_1"><title>Osmosis simulation</title></item>
        </item>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="WL_1" type="imswl_xmlv1p3"><file href="WL_1/weblink.xml"/></resource>
    <resource identifier="LTI_1" type="imsbasiclti_xmlv1p3"><file href="LTI_1/basiclti.xml"/></resource>
  </resources>
</manifest>
`;

const WEB_LINK = `<?xml version="1.0" encoding="UTF-8"?>
<webLink xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imswl_v1p3">
  <title>Osmosis reading</title>
  <url href="${CARTRIDGE_LINK}" target="_iframe"/>
</webLink>
`;

const LTI_LINK = `<?xml version="1.0" encoding="UTF-8"?>
<cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p3"
    xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0"
    xmlns:lticm="http://www.imsglobal.org/xsd/imslticm_v1p0">
  <blti:title>Osmosis simulation</blti:title>
  <blti:description>An external simulation (synthetic).</blti:description>
  <blti:launch_url>https://sim.tools.example/launch/osmosis</blti:launch_url>
  <blti:vendor>
    <lticm:code>sim-co</lticm:code>
    <lticm:name>Simulation Co (synthetic)</lticm:name>
  </blti:vendor>
</cartridge_basiclti_link>
`;

/** A Thin CC 1.3 package with one web link and one LTI link to an unregistered tool. */
export async function thinCartridge(): Promise<Uint8Array<ArrayBuffer>> {
  return writeZip([
    { path: "imsmanifest.xml", bytes: encoder.encode(MANIFEST) },
    { path: "WL_1/weblink.xml", bytes: encoder.encode(WEB_LINK) },
    { path: "LTI_1/basiclti.xml", bytes: encoder.encode(LTI_LINK) },
  ]);
}

/** Imports {@link thinCartridge} into one of a teacher's classes, through the district's Content Studio. */
export async function importThinCartridge(district: PilotDistrict, teacherId: string, offeringId: string) {
  const { app, stores } = district;
  const authorizer: Authorizer = { authorize: async (request) => (await app.engine.decide(request)).decision };
  const studio = new ContentStudio({
    districtId: app.districtId,
    storage: stores.contentStudio,
    authorizer,
    channel: "http",
    fetch: district.web.fetch,
    scanner: undefined,
    alignments: catalogAlignmentSource(app.catalog),
    now,
  });
  const importer = new CartridgeImporter({ districtId: app.districtId, storage: new InMemoryCartridgeImportStorage(), studio, authorizer, channel: "http", now });
  const teacher = callerOf(district, teacherId).principal;
  const record = await importer.importPackage(teacher, { fileName: "osmosis.imscc", targetScope: offeringScope(offeringId) }, await thinCartridge());
  return { record, importer, assertToolLaunchable, teacher };
}
