import { describe, expect, it } from "vitest";
import { readZip, writeZip, zipStream, ZipRefusedError, type ZipLimits, type ZipWriteEntry } from "../src/index.ts";

const LIMITS: ZipLimits = { maxEntries: 10, maxEntryBytes: 64 * 1024, maxTotalBytes: 128 * 1024, maxCompressionRatio: 100 };
const encoder = new TextEncoder();

function zip(files: Record<string, string>) {
  return writeZip(Object.entries(files).map(([path, text]) => ({ path, bytes: encoder.encode(text) })));
}

/** Rewrites the uncompressed size a central directory record declares for `path`. */
function declareSize(bytes: Uint8Array, path: string, size: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const name = encoder.encode(path);
  for (let at = 0; at + 46 <= copy.byteLength; at++) {
    if (view.getUint32(at, true) !== 0x02014b50 || view.getUint16(at + 28, true) !== name.byteLength) continue;
    if (copy.subarray(at + 46, at + 46 + name.byteLength).every((b, i) => b === name[i])) {
      view.setUint32(at + 24, size, true);
      return copy;
    }
  }
  throw new Error(`no central record for ${path}`);
}

async function refusal(promise: Promise<unknown>): Promise<ZipRefusedError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ZipRefusedError);
  return error as ZipRefusedError;
}

describe("readZip include filter", () => {
  it("never inflates an entry it was not asked for, whatever that entry declares", async () => {
    const archive = await zip({ "users.csv": "sourcedId\nu1\n", "demographics.csv": `sourcedId,birthDate\n${"u1,2010-01-01\n".repeat(200)}` });
    // A demographics entry claiming to be enormous would refuse the archive if it were read.
    const lying = declareSize(archive, "demographics.csv", 50 * 1024 * 1024);
    await expect(readZip(lying, LIMITS)).rejects.toBeInstanceOf(ZipRefusedError);

    const read = await readZip(lying, LIMITS, { include: (path) => path !== "demographics.csv" });
    expect([...read.files.keys()]).toEqual(["users.csv"]);
    expect(read.ignored).toEqual([{ path: "demographics.csv", reason: "not-included" }]);
  });

  it("still refuses the whole archive over an unsafe name it was not asked for", async () => {
    const archive = await zip({ "users.csv": "x", "../escape.csv": "y" });
    const error = await refusal(readZip(archive, LIMITS, { include: (path) => path === "users.csv" }));
    expect(error.reason).toBe("unsafe-path");
    expect(error.code).toBe("policy-violation");
  });

  it("applies the entry and total caps to what it reads", async () => {
    const big = "a,b\n".repeat(20_000);
    expect((await refusal(readZip(await zip({ "users.csv": big }), LIMITS))).reason).toBe("entry-too-large");
    expect((await refusal(readZip(await zip({ "a.csv": "1", "b.csv": "2" }), { ...LIMITS, maxEntries: 1 }))).reason).toBe("too-many-entries");
  });
});

describe("writeZip (SCHO-186)", () => {
  it("writes the same bytes for the same entries, which the bounded reader reads back exactly", async () => {
    const files = { "imsmanifest.xml": "<manifest/>".repeat(50), "pages/one.html": "<p>One</p>" };
    const first = await zip(files);
    expect(await zip(files)).toStrictEqual(first);
    const archive = await readZip(first, LIMITS);
    expect(Object.fromEntries([...archive.files].map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]))).toStrictEqual(files);
  });
});

async function* entriesOf(entries: readonly ZipWriteEntry[], pulled?: string[]): AsyncIterable<ZipWriteEntry> {
  for (const entry of entries) {
    pulled?.push(entry.path);
    yield entry;
  }
}

describe("zipStream (SCHO-367)", () => {
  const entries = [
    { path: "manifest.json", bytes: encoder.encode("{}\n".repeat(40)) },
    { path: "content/aa", bytes: encoder.encode("held content") },
    { path: "content/bb", bytes: encoder.encode("more held content ".repeat(30)) },
  ];

  it("writes what writeZip writes for the same entries", async () => {
    const streamed = new Uint8Array(await new Response(zipStream(entriesOf(entries))).arrayBuffer());
    expect(streamed).toStrictEqual(await writeZip(entries));
  });

  it("stores the entries it is told to, and the reader reads them back", async () => {
    const streamed = new Uint8Array(await new Response(zipStream(entriesOf(entries), { store: (path) => path.startsWith("content/") })).arrayBuffer());
    const read = await readZip(streamed, LIMITS);
    expect([...read.files.keys()]).toStrictEqual(entries.map((e) => e.path));
    expect(read.files.get("content/bb")).toStrictEqual(entries[2]!.bytes);
  });

  it("pulls an entry only when the reader wants more", async () => {
    const pulled: string[] = [];
    const reader = zipStream(entriesOf(entries, pulled)).getReader();
    await reader.read();
    expect(pulled).toStrictEqual(["manifest.json"]);
    await reader.cancel();
  });

  it("errors the stream when an entry cannot be read", async () => {
    async function* failing(): AsyncIterable<ZipWriteEntry> {
      yield entries[0]!;
      throw new Error("content went missing");
    }
    await expect(new Response(zipStream(failing())).arrayBuffer()).rejects.toThrow("content went missing");
  });

  it("adds the ZIP64 end records past 65,534 entries, which the bounded reader refuses", async () => {
    const many = Array.from({ length: 0xffff }, (_, i) => ({ path: `f/${i}`, bytes: new Uint8Array([i & 0xff]) }));
    const bytes = new Uint8Array(await new Response(zipStream(entriesOf(many), { store: () => true })).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const end = bytes.byteLength - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(0xffff);
    expect(view.getUint32(end - 20, true)).toBe(0x07064b50);
    const record = Number(view.getBigUint64(end - 20 + 8, true));
    expect(view.getUint32(record, true)).toBe(0x06064b50);
    expect(view.getBigUint64(record + 32, true)).toBe(0xffffn);
    expect((await refusal(readZip(bytes, { ...LIMITS, maxEntries: 0x10000 }))).reason).toBe("zip64-unsupported");
  });
});
