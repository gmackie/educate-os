import { describe, expect, it } from "vitest";
import { DEFAULT_CARTRIDGE_LIMITS, DEFAULT_ZIP_LIMITS, readCartridge, readZip } from "../src/index.ts";
import { validThinCc } from "./cartridges.ts";
import { BIO_SCOPE, fixture, importer, MORGAN, refusedFor } from "./helpers.ts";
import { buildZip, type ZipEntrySpec } from "./zip-writer.ts";

const zip = (entries: ZipEntrySpec[]) => buildZip(entries);

describe("malicious fixtures", () => {
  it.each([
    ["zip-bomb.imscc", "entry-too-large"],
    ["zip-bomb-lying-header.imscc", "corrupt-entry"],
    ["path-traversal.imscc", "unsafe-path"],
    ["doctype-xxe.imscc", "xml-doctype"],
  ])("refuses %s (%s) and records nothing", async (name, reason) => {
    const { importer: cc, storage, web } = importer();
    await refusedFor(cc.importPackage(MORGAN, { fileName: name, targetScope: BIO_SCOPE }, fixture(name)), reason);
    expect(await storage.listImports()).toStrictEqual([]);
    expect(web.requested).toStrictEqual([]);
  });

  it("refuses an honestly declared bomb on its ratio when the size caps would allow it", async () => {
    const limits = { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 256 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024 };
    await refusedFor(readZip(fixture("zip-bomb.imscc"), limits), "compression-ratio");
  });

  it("stops inflating a lying entry as soon as it passes its declared size", async () => {
    // The entry really inflates to 128 MiB; holding it would show in the heap.
    const before = process.memoryUsage().arrayBuffers;
    await refusedFor(readZip(fixture("zip-bomb-lying-header.imscc")), "corrupt-entry");
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(32 * 1024 * 1024);
  });
});

describe("archive checks", () => {
  it.each([
    ["/etc/cron.d/evil"],
    ["C:/Windows/evil.xml"],
    ["c:evil.xml"],
    ["dir\\..\\..\\evil.xml"],
    ["a/../../evil.xml"],
    ["./imsmanifest.xml"],
    ["a//b.xml"],
    ["bad\u0000name.xml"],
  ])("refuses the entry name %j", async (path) => {
    await refusedFor(readZip(await zip([...validThinCc(), { path, content: "<x/>" }])), "unsafe-path");
  });

  it("refuses a symbolic link with a hostile name before it could be skipped", async () => {
    await refusedFor(readZip(await zip([{ path: "../escape", content: "/etc", symlink: true, method: "store" }])), "unsafe-path");
  });

  it("ignores symbolic links and never reads their targets", async () => {
    const archive = await readZip(await zip([...validThinCc(), { path: "WL_1/alias.xml", content: "../../etc/passwd", symlink: true, method: "store" }]));
    expect(archive.files.has("WL_1/alias.xml")).toBe(false);
    expect(archive.ignored).toStrictEqual([{ path: "WL_1/alias.xml", reason: "symlink" }]);
  });

  it("caps the number of entries before reading any", async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ path: `f${i}.txt`, content: "x", method: "store" as const }));
    await refusedFor(readZip(await zip(many), { ...DEFAULT_ZIP_LIMITS, maxEntries: 10 }), "too-many-entries");
  });

  it("caps the total uncompressed size across entries", async () => {
    const entries = Array.from({ length: 3 }, (_, i) => ({ path: `f${i}.bin`, content: new Uint8Array(1000), method: "store" as const }));
    await refusedFor(readZip(await zip(entries), { ...DEFAULT_ZIP_LIMITS, maxTotalBytes: 2500 }), "package-too-large");
  });

  it("refuses duplicate entry names", async () => {
    await refusedFor(readZip(await zip([...validThinCc(), { path: "WL_1/weblink.xml", content: "<webLink/>" }])), "duplicate-entry");
  });

  it("refuses content that does not match its checksum", async () => {
    const bytes = await zip([{ path: "a.txt", content: "hello world", method: "store" }]);
    bytes[30 + "a.txt".length] ^= 0xff;
    await refusedFor(readZip(bytes), "corrupt-entry");
  });

  it("refuses encrypted entries", async () => {
    const bytes = await zip([{ path: "a.txt", content: "hello", method: "store" }]);
    const view = new DataView(bytes.buffer);
    const central = view.getUint32(bytes.byteLength - 22 + 16, true);
    view.setUint16(central + 8, view.getUint16(central + 8, true) | 1, true);
    await refusedFor(readZip(bytes), "encrypted-entry");
  });

  it("refuses entries whose data overlap, the trick behind non-recursive zip bombs", async () => {
    const bytes = await zip([{ path: "a.txt", content: "aaaa", method: "store" }, { path: "b.txt", content: "bbbb", method: "store" }]);
    const view = new DataView(bytes.buffer);
    const central = view.getUint32(bytes.byteLength - 22 + 16, true);
    const second = central + 46 + "a.txt".length;
    view.setUint32(second + 42, 0, true);
    await refusedFor(readZip(bytes), "corrupt-entry");
  });

  it("refuses bytes that are not a ZIP archive, and an archive without a manifest", async () => {
    await refusedFor(readZip(new TextEncoder().encode("<manifest/>")), "not-a-zip");
    await refusedFor(readCartridge(await zip([{ path: "readme.txt", content: "hi" }])), "manifest-missing");
  });

  it("refuses an oversized package before opening it", async () => {
    await refusedFor(readCartridge(fixture("thin-cc-valid.imscc"), { ...DEFAULT_CARTRIDGE_LIMITS, maxPackageBytes: 100 }), "package-too-large");
  });

  it("refuses a manifest that points outside the package", async () => {
    const [manifest, ...rest] = validThinCc();
    const escaping = { ...manifest!, content: (manifest!.content as string).replace("WL_1/weblink.xml", "../WL_1/weblink.xml") };
    const { importer: cc } = importer();
    await refusedFor(cc.importPackage(MORGAN, { fileName: "x.imscc", targetScope: BIO_SCOPE }, await zip([escaping, ...rest])), "unsafe-path");
  });

  it("refuses a DOCTYPE in a link file, not only in the manifest", async () => {
    const entries = validThinCc().map((entry) => entry.path === "WL_2/weblink.xml"
      ? { ...entry, content: `<!DOCTYPE webLink [<!ENTITY a "b">]><webLink><url href="https://open-lessons.example/&a;"/></webLink>` }
      : entry);
    const { importer: cc } = importer();
    await refusedFor(cc.importPackage(MORGAN, { fileName: "x.imscc", targetScope: BIO_SCOPE }, await zip(entries)), "xml-doctype");
  });
});
