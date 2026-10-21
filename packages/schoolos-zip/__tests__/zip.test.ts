import { writeZip } from "@schoolos/portability";
import { describe, expect, it } from "vitest";
import { readZip, ZipRefusedError, type ZipLimits } from "../src/index.ts";

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
