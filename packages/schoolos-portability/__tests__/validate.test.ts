import { describe, expect, it } from "vitest";
import { ARCHIVE_LIMITS, readZip, validateArchive, writeArchive, writeZip, type ArchiveFile } from "../src/index.ts";
import { amarasYear } from "./scenario.ts";
import { editJson, P, RESOURCE_EXPORT_RULE, rejectsWith, rewrite, setup } from "./setup.ts";

const encoder = new TextEncoder();
const MANIFEST = encoder.encode("{}");

async function amarasArchive() {
  const env = setup({ extraRules: [RESOURCE_EXPORT_RULE] });
  await amarasYear(env);
  return (await env.exporter.exportStudentArchive(P.amara)).bytes;
}

describe("the archive writer", () => {
  it("depends only on the files, not the order they were collected in", async () => {
    const header = {
      exportId: "0123456789abcdef0123456789abcdef",
      district: { displayName: "Northfield Public Schools (synthetic)" },
      exportedAt: "2026-10-20T12:00:00.000Z",
      subject: "learner-0123456789abcdef",
    } as Parameters<typeof writeArchive>[0];
    const files: ArchiveFile[] = [
      { path: "artifacts/a1/r1.md", kind: "artifact-revision", mediaType: "text/markdown", rights: { mode: "learner-work" }, bytes: encoder.encode("one ".repeat(200)) },
      { path: "artifacts/a2/r1.png", kind: "artifact-revision", mediaType: "image/png", rights: { mode: "learner-work" }, bytes: new Uint8Array([137, 80, 78, 71]) },
      { path: "provenance.json", kind: "provenance", mediaType: "application/json", rights: { mode: "export-metadata" }, bytes: encoder.encode("{}") },
    ];
    const a = await writeArchive(header, files);
    const b = await writeArchive(header, files.toReversed());
    expect(b.bytes).toEqual(a.bytes);
    expect((await readZip(a.bytes)).map((e) => e.path)).toEqual(["manifest.json", "artifacts/a1/r1.md", "artifacts/a2/r1.png", "provenance.json"]);
  });
});

describe("bounded unzip", () => {
  it("rejects a zip bomb by its compression ratio", async () => {
    const bomb = await writeZip([{ path: "manifest.json", bytes: new Uint8Array(20 * 1024 * 1024) }]);
    expect(bomb.byteLength).toBeLessThan(100 * 1024);
    await rejectsWith(validateArchive(bomb), "validation-failed", /compressed suspiciously far/);
  });

  it("stops inflating an entry that produces more than it declares", async () => {
    const zip = await writeZip([{ path: "manifest.json", bytes: new Uint8Array(4 * 1024 * 1024) }]);
    // Claim 1000 bytes, under the ratio check's floor, in both headers.
    const view = new DataView(zip.buffer);
    const centralAt = view.getUint32(zip.byteLength - 22 + 16, true);
    view.setUint32(22, 1000, true);
    view.setUint32(centralAt + 24, 1000, true);
    await rejectsWith(validateArchive(zip), "validation-failed", /inflates to more than it declares/);
  });

  it("rejects an archive with too many entries before reading any", async () => {
    const zip = await writeZip([{ path: "manifest.json", bytes: MANIFEST }]);
    const view = new DataView(zip.buffer);
    const endAt = zip.byteLength - 22;
    view.setUint16(endAt + 8, ARCHIVE_LIMITS.maxEntries + 1, true);
    view.setUint16(endAt + 10, ARCHIVE_LIMITS.maxEntries + 1, true);
    await rejectsWith(validateArchive(zip), "validation-failed", /more than 10000 entries/);
  });

  it.each(["../evil.txt", "artifacts/../../evil.txt", "/etc/passwd", "artifacts\\evil.txt", "C:/evil.txt", "artifacts//evil.txt", ".hidden", "artifacts/./x"])(
    "rejects the entry path %j",
    async (path) => {
      const zip = await writeZip([{ path: "manifest.json", bytes: MANIFEST }, { path, bytes: encoder.encode("x") }]);
      await rejectsWith(validateArchive(zip), "validation-failed", /not a safe relative path/);
    },
  );

  it("rejects duplicate entries, trailing bytes and a corrupted entry", async () => {
    await rejectsWith(
      validateArchive(await writeZip([{ path: "manifest.json", bytes: MANIFEST }, { path: "manifest.json", bytes: MANIFEST }])),
      "validation-failed",
      /appears twice/,
    );
    const zip = await writeZip([{ path: "manifest.json", bytes: encoder.encode("{\"a\":1}") }]);
    const padded = new Uint8Array(zip.byteLength + 4);
    padded.set(zip);
    await rejectsWith(validateArchive(padded), "validation-failed", /end-of-archive/);
    const corrupt = zip.slice();
    corrupt[30 + "manifest.json".length] ^= 0xff;
    await rejectsWith(validateArchive(corrupt), "validation-failed", /checksum/);
  });
});

describe("archive validation", () => {
  it("accepts what the exporter writes", async () => {
    const archive = await validateArchive(await amarasArchive());
    expect(archive.artifacts.length).toBeGreaterThan(0);
  });

  it("rejects an entry that no longer matches its digest", async () => {
    const tampered = await rewrite(await amarasArchive(), (entries) => {
      const essay = entries.find((e) => e.path.endsWith("/r1.md"))!;
      essay.bytes = encoder.encode("Somebody else's words.");
    });
    await rejectsWith(validateArchive(tampered), "validation-failed", /does not match its digest/);
  });

  it("rejects content swapped together with its manifest digest, since the record still names the old one", async () => {
    const tampered = await rewrite(await amarasArchive(), (entries) => {
      entries.find((e) => e.path.endsWith("/r1.md"))!.bytes = encoder.encode("Somebody else's words.");
    }, { refreshManifest: true });
    await rejectsWith(validateArchive(tampered), "validation-failed", /disagrees with the manifest/);
  });

  it("rejects secret-shaped text even when every digest is consistent", async () => {
    const tampered = await rewrite(await amarasArchive(), (entries) => {
      editJson(entries, "feedback/f1.json", (f) => {
        f.body = "Use Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 to see the grades.";
      });
    }, { refreshManifest: true });
    await rejectsWith(validateArchive(tampered), "validation-failed", /secret-shaped text \(bearer-token\)/);
  });

  it("rejects third-party content whose rights forbid redistribution", async () => {
    const tampered = await rewrite(await amarasArchive(), (entries) => {
      editJson(entries, "manifest.json", (m) => {
        const items = m.items as { kind: string; rights: unknown }[];
        for (const item of items.filter((i) => i.kind === "resource-content" || i.kind === "resource")) {
          item.rights = { mode: "licensed-copy", redistribution: "forbidden" };
        }
      });
    });
    await rejectsWith(validateArchive(tampered), "validation-failed", /rights forbid redistribution/);
  });

  it("rejects link-only rights on learner content", async () => {
    const tampered = await rewrite(await amarasArchive(), (entries) => {
      editJson(entries, "manifest.json", (m) => {
        (m.items as { kind: string; rights: unknown }[]).find((i) => i.kind === "artifact-revision")!.rights = { mode: "link" };
      });
    });
    await rejectsWith(validateArchive(tampered), "validation-failed", /rights its kind cannot have/);
  });

  it.each([
    ["a district principal ID as the subject", (m: Record<string, unknown>) => { m.subject = "prn_nf-student-amara"; }],
    ["an unknown manifest field", (m: Record<string, unknown>) => { m.studentEmail = "family.okafor@northfield.example"; }],
    ["an unknown format version", (m: Record<string, unknown>) => { m.formatVersion = 2; }],
  ])("rejects %s", async (_label, change) => {
    const tampered = await rewrite(await amarasArchive(), (entries) => editJson(entries, "manifest.json", change));
    await rejectsWith(validateArchive(tampered), "validation-failed", /manifest\.json does not match its schema/);
  });

  it("rejects a record carrying a district ID or an unknown field", async () => {
    const withId = await rewrite(await amarasArchive(), (entries) => {
      editJson(entries, "submissions/s1/submission.json", (s) => {
        s.id = "sub_amara-osmosis";
      });
    }, { refreshManifest: true });
    await rejectsWith(validateArchive(withId), "validation-failed", /does not match its schema/);
    const withField = await rewrite(await amarasArchive(), (entries) => {
      editJson(entries, "feedback/f1.json", (f) => {
        f.teacherNote = "private";
      });
    }, { refreshManifest: true });
    await rejectsWith(validateArchive(withField), "validation-failed", /does not match its schema/);
  });

  it("rejects an entry the manifest does not list", async () => {
    const tampered = await rewrite(await amarasArchive(), (entries) => {
      entries.push({ path: "zz-extra.txt", bytes: encoder.encode("hello") });
    });
    await rejectsWith(validateArchive(tampered), "validation-failed", /does not list exactly/);
  });

  it("rejects a history that is not one linear chain", async () => {
    const bytes = await amarasArchive();
    const essay = (await validateArchive(bytes)).artifacts.find((a) => a.revisions.length === 2)!;
    const tampered = await rewrite(bytes, (entries) => {
      editJson(entries, `artifacts/${essay.id}/artifact.json`, (a) => {
        const revisions = a.revisions as { parent?: string }[];
        delete revisions[1]!.parent;
      });
    }, { refreshManifest: true });
    await rejectsWith(validateArchive(tampered), "validation-failed", /linear chain/);
  });
});
