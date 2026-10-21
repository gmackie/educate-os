import { describe, expect, it } from "vitest";
import { extractPageMetadata, interpretLicenseHints, proposeRightsMode } from "../src/index.ts";
import { BIO_SCOPE, CURRICULUM, html, LICENSED_PAGE, MORGAN, rejectsWith, studio } from "./helpers.ts";

const URL_ = "https://open-lessons.example/page";

function proposalFor(head: string, body = ""): string {
  const metadata = extractPageMetadata(`<html><head>${head}</head><body>${body}</body></html>`, URL_);
  return proposeRightsMode(interpretLicenseHints(metadata.licenseHints));
}

describe("rights proposals from license evidence", () => {
  it("proposes `link` only when license evidence is absent, unknown or conflicting", () => {
    expect(proposalFor("")).toBe("link");
    expect(proposalFor('<meta name="dc.rights" content="All rights reserved">')).toBe("link");
    expect(proposalFor('<link rel="license" href="https://licenses.example/custom-terms">')).toBe("link");
    expect(proposalFor(
      '<link rel="license" href="https://creativecommons.org/licenses/by/4.0/">',
      '<a rel="license" href="https://creativecommons.org/licenses/by-nc-nd/4.0/">CC</a>',
    )).toBe("link");
  });

  it("reads `<link rel=license>`, CC badges and license meta tags", () => {
    expect(proposalFor('<link rel="license" href="https://creativecommons.org/licenses/by-sa/4.0/">')).toBe("licensed-copy");
    expect(proposalFor("", '<img alt="CC BY-ND" src="https://i.creativecommons.org/l/by-nd/4.0/88x31.png">')).toBe("embed");
    expect(proposalFor('<meta name="dcterms.license" content="https://creativecommons.org/licenses/by-nc/4.0/">')).toBe("excerpt");
    expect(proposalFor('<meta name="license" content="CC0 1.0">')).toBe("licensed-copy");
    expect(proposalFor('<meta name="license" content="CC BY 4.0">')).toBe("licensed-copy");
  });

  it("does not take a license from a look-alike host", () => {
    expect(proposalFor('<link rel="license" href="https://creativecommons.org.attacker.example/licenses/by/4.0/">')).toBe("link");
  });

  it("proposes `link` for an imported page with no license, and for every upload", async () => {
    const page = LICENSED_PAGE.replace(/<link rel="license"[^>]*>/, "");
    const { studio: s } = await studio({ routes: { [URL_]: html(page) }, scanner: "none" });
    const item = await s.submitUrl(MORGAN, { url: URL_, targetScope: BIO_SCOPE });
    expect(item.rights).toMatchObject({ proposed: "link", current: "link" });
    expect(item.checks?.flags.map((f) => f.code)).toContain("license-absent");

    const upload = await s.submitUpload(MORGAN, { fileName: "notes.txt", mediaType: "text/plain", targetScope: BIO_SCOPE }, new TextEncoder().encode("notes"));
    expect(upload.rights.current).toBe("link");
  });
});

describe("rights changes", () => {
  it("lets a teacher narrow but not widen, and records every change", async () => {
    const { studio: s } = await studio();
    const item = await s.submitUrl(MORGAN, { url: "https://open-lessons.example/cells", targetScope: BIO_SCOPE });
    expect(item.rights.current).toBe("licensed-copy");

    const narrowed = await s.setRightsMode(MORGAN, item.id, { mode: "embed", reason: "We only need to show it in class." });
    expect(narrowed.rights.current).toBe("embed");
    await rejectsWith(s.setRightsMode(MORGAN, item.id, { mode: "excerpt", reason: "Changed my mind." }), "forbidden");
    expect((await s.getReport(MORGAN, item.id)).rights.current).toBe("embed");

    const changes = (await s.getReport(MORGAN, item.id)).rights.changes;
    expect(changes.map(({ from, to, by, widened }) => ({ from, to, by, widened }))).toStrictEqual([
      { from: undefined, to: "licensed-copy", by: "importer", widened: false },
      { from: "licensed-copy", to: "embed", by: MORGAN.principalId, widened: false },
    ]);
    const audit = (await s.listAudit(MORGAN, item.id)).filter((e) => e.type === "rights-changed");
    expect(audit).toMatchObject([{ actor: MORGAN.principalId, detail: "licensed-copy -> embed" }]);
  });

  it("lets a curriculum admin widen, and the release records them as verifying the rights", async () => {
    const page = LICENSED_PAGE.replace(/<link rel="license"[^>]*>/, "");
    const { studio: s } = await studio({ routes: { [URL_]: html(page) } });
    const item = await s.submitUrl(MORGAN, { url: URL_, targetScope: BIO_SCOPE });
    const widened = await s.setRightsMode(CURRICULUM, item.id, { mode: "licensed-copy", reason: "District license agreement 2026-14 (synthetic)." });
    expect(widened.rights.changes.at(-1)).toMatchObject({ from: "link", to: "licensed-copy", by: CURRICULUM.principalId, widened: true });

    const { descriptor } = await s.approve(MORGAN, item.id, { alignments: [] });
    expect(descriptor.license).toMatchObject({ permittedUses: ["link", "embed", "excerpt", "licensed-copy"], verification: { status: "verified", reviewer: CURRICULUM.principalId } });
  });

  it("freezes rights once an item is decided", async () => {
    const { studio: s } = await studio();
    const item = await s.submitUrl(MORGAN, { url: "https://open-lessons.example/cells", targetScope: BIO_SCOPE });
    await s.approve(MORGAN, item.id, { alignments: [] });
    await rejectsWith(s.setRightsMode(MORGAN, item.id, { mode: "link", reason: "Too late." }), "conflict");
  });
});
