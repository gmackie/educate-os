import { DistrictDirectorySnapshot } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";
import { writeZip } from "@educateos/portability";
import { ZipRefusedError } from "@educateos/zip";
import { describe, expect, it } from "vitest";
import { oneroster } from "../src/index.ts";
import { loadExport } from "./fixtures/load.ts";
import { DEMOGRAPHICS_SENTINEL } from "./fixtures/northfield-export.ts";

const emptyNorthfield = () => DistrictDirectorySnapshot.parse({
  district: NORTHFIELD.district,
  schools: [],
  terms: [],
  courses: [],
  offerings: [],
  principals: [],
  enrollments: [],
  roleAssignments: [],
});

async function zipOf(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return writeZip(Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.slice() })));
}

/** Rewrites the CRC-32 a central directory record declares for `path`, so reading it would fail. */
function corruptChecksum(bytes: Uint8Array, path: string): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const name = new TextEncoder().encode(path);
  for (let at = 0; at + 46 <= copy.byteLength; at++) {
    if (view.getUint32(at, true) !== 0x02014b50 || view.getUint16(at + 28, true) !== name.byteLength) continue;
    if (copy.subarray(at + 46, at + 46 + name.byteLength).every((b, i) => b === name[i])) {
      view.setUint32(at + 16, view.getUint32(at + 16, true) ^ 0xffffffff, true);
      return copy;
    }
  }
  throw new Error(`no central record for ${path}`);
}

describe("readOneRosterZip", () => {
  it("reads the export's files and never decompresses demographics.csv", async () => {
    const files = loadExport("northfield");
    expect(new TextDecoder().decode(files["demographics.csv"])).toContain(DEMOGRAPHICS_SENTINEL);
    // Were demographics.csv inflated, its corrupted checksum would refuse the whole archive.
    const archive = corruptChecksum(await zipOf(files), "demographics.csv");

    const read = await oneroster.readOneRosterZip(archive);
    expect(Object.keys(read).toSorted()).toEqual(["manifest.csv", ...oneroster.ONEROSTER_FILES].toSorted());
    expect(JSON.stringify(Object.values(read).map((b) => new TextDecoder().decode(b as Uint8Array)))).not.toContain(DEMOGRAPHICS_SENTINEL);

    const result = await oneroster.runRosterSync({
      state: { roster: { snapshot: emptyNorthfield(), sources: oneroster.EMPTY_SOURCE_MAP } },
      source: oneroster.csvRosterSource(read),
      mode: "complete",
      config: { issuer: "https://idp.northfield.example", subject: { field: "username" } },
      runId: "zip-1",
      clock: () => new Date("2026-10-20T15:00:00Z"),
    });
    expect(result.run.outcome).toBe("succeeded");
  });

  it("refuses an archive with a traversing entry name, even one it would not read", async () => {
    const files = loadExport("northfield");
    const archive = await zipOf({ ...files, "../../users.csv": files["users.csv"]! });
    const error = await oneroster.readOneRosterZip(archive).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(ZipRefusedError);
    expect((error as ZipRefusedError).reason).toBe("unsafe-path");
  });

  it("refuses a file over the size cap before inflating it", async () => {
    const files = loadExport("northfield");
    const limits = { ...oneroster.DEFAULT_ONEROSTER_ZIP_LIMITS, maxEntryBytes: 256 };
    const error = await oneroster.readOneRosterZip(await zipOf(files), limits).then(() => undefined, (e: unknown) => e);
    expect((error as ZipRefusedError).reason).toBe("entry-too-large");
  });
});
