import { describe, expect, it } from "vitest";
import { attributeOf, childElement, DEFAULT_XML_LIMITS, parseManifest, parseXml, textOf } from "../src/index.ts";

const refused = (source: string, reason: string, limits = DEFAULT_XML_LIMITS) =>
  expect(() => parseXml(source, limits)).toThrow(expect.objectContaining({ code: "policy-violation", reason }));

describe("the XML parser", () => {
  it.each([
    ["an external entity (XXE)", `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>`],
    ["billion laughs", `<!DOCTYPE r [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><r>&b;</r>`],
    ["an external DTD", `<!DOCTYPE r SYSTEM "https://evil.example/r.dtd"><r/>`],
    ["a lowercase, spaced doctype", `<! doctype r><r/>`],
    ["a bare entity declaration", `<r><!ENTITY a "b"></r>`],
  ])("refuses %s", (_, source) => {
    refused(source, "xml-doctype");
  });

  it("refuses any entity reference other than the predefined five", () => {
    refused("<r>&nbsp;</r>", "xml-malformed");
    refused("<r a='&x;'/>", "xml-malformed");
    refused("<r>&#0;</r>", "xml-malformed");
    refused("<r>& loose</r>", "xml-malformed");
  });

  it("enforces its depth, element and length caps", () => {
    refused(`${"<a>".repeat(65)}${"</a>".repeat(65)}`, "xml-too-deep");
    refused(`<r>${"<a/>".repeat(11)}</r>`, "xml-too-large", { ...DEFAULT_XML_LIMITS, maxElements: 10 });
    refused(`<r>${"x".repeat(101)}</r>`, "xml-too-large", { ...DEFAULT_XML_LIMITS, maxLength: 100 });
  });

  it("refuses malformed documents", () => {
    for (const source of ["<a><b></a></b>", "<a>", "<a/><b/>", "text<a/>", "<a b=c/>", "<a b='1' b='2'/>", "<a b='<'/>", ""]) {
      expect(() => parseXml(source), source).toThrow(expect.objectContaining({ reason: "xml-malformed" }));
    }
  });

  it("decodes references, CDATA and namespaces, and skips comments and processing instructions", () => {
    const root = parseXml(`\uFEFF<?xml version="1.0"?><!-- c --><r xmlns="urn:d" xmlns:p="urn:p"><p:t a="x &amp; &#x41;">&lt;b&gt;<![CDATA[<raw>&amp;]]></p:t></r>`);
    const t = childElement(root, "t")!;
    expect([root.namespace, t.namespace, t.local, t.name]).toStrictEqual(["urn:d", "urn:p", "t", "p:t"]);
    expect(attributeOf(t, "a")).toBe("x & A");
    expect(textOf(t)).toBe("<b><raw>&amp;");
  });
});

const manifest = (schema: string, version: string) =>
  `<manifest identifier="M"><metadata><schema>${schema}</schema><schemaversion>${version}</schemaversion></metadata><organizations/><resources/></manifest>`;

describe("manifest recognition", () => {
  it.each([
    ["IMS Thin Common Cartridge", "1.3.0", "thin-common-cartridge"],
    ["IMS Thin Common Cartridge", "1.2.0", "thin-common-cartridge"],
    ["IMS Common Cartridge", "1.1.0", "common-cartridge"],
    ["IMS Common Cartridge", "1.3.0", "common-cartridge"],
  ])("accepts %s %s", (schema, version, profile) => {
    expect(parseManifest(manifest(schema, version))).toMatchObject({ profile, schemaVersion: version, items: [], resources: [] });
  });

  it.each([
    ["IMS Common Cartridge", "1.0.0"],
    ["IMS Content", "1.1.4"],
  ])("refuses %s %s", (schema, version) => {
    expect(() => parseManifest(manifest(schema, version))).toThrow(expect.objectContaining({ reason: "not-a-cartridge" }));
  });

  it("refuses a document whose root is not a manifest", () => {
    expect(() => parseManifest("<webLink/>")).toThrow(expect.objectContaining({ reason: "not-a-cartridge" }));
  });
});
