import assert from "node:assert/strict";
import { test } from "node:test";
import { frontendProfile, releaseProfile } from "./frontend-profile.ts";
import { collectAssets } from "./hash-lib.ts";
import { generateManifest, readDeployablePackages, releaseAssetVariants } from "./manifest-lib.ts";
import { join } from "node:path";

test("generic releases default off, including inherited UI flags", () => {
  for (const value of [undefined, "false"]) {
    const profile = frontendProfile({ EDUCATEOS_SCHOOL_BUILD: value, VITE_EDUCATEOS_SCHOOL_MODE: "true" });
    assert.equal(profile.variant, "access");
    assert.equal(profile.env.VITE_EDUCATEOS_SCHOOL_MODE, "false");
    assert.equal(profile.env.VITE_CF_ACCESS_MODE, "true");
  }
});

test("school builds opt in explicitly and reject misspelled selectors", () => {
  const profile = frontendProfile({ EDUCATEOS_SCHOOL_BUILD: "true" });
  assert.equal(profile.variant, "access-school");
  assert.equal(profile.env.VITE_EDUCATEOS_SCHOOL_MODE, "true");
  assert.throws(() => frontendProfile({ EDUCATEOS_SCHOOL_BUILD: "1" }), /must be true or false/);
});

test("the release manifest records the selected variant and its content hashes", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const packages = readDeployablePackages(join(root, "packages")).filter(pkg => ["router", "workshop-backend", "educateos-district-worker"].includes(pkg.name));
  const assets = collectAssets(join(root, "scripts/release/testdata/fixture-assets/access"));
  for (const value of ["false", "true"]) {
    const profile = frontendProfile({ EDUCATEOS_SCHOOL_BUILD: value });
    const manifest = generateManifest({
      releaseId: "profile-test", commit: "0".repeat(40), createdAt: "2026-10-30T00:00:00Z", wranglerVersion: "test",
      profile: value === "true" ? "school" : "generic",
      workers: packages.map(pkg => ({ pkgName: pkg.name, config: pkg.config, mainModule: "index.js", modules: [] })),
      assetVariants: Object.fromEntries(Object.keys(releaseAssetVariants({ EDUCATEOS_SCHOOL_BUILD: value })).map(name => [name, assets])),
    });
    assert.deepEqual(Object.keys(manifest.workers.router.assetsConfig!.variants), Object.keys(releaseAssetVariants({ EDUCATEOS_SCHOOL_BUILD: value })));
    assert.deepEqual(manifest.workers.router.assetsConfig!.variants[profile.variant].manifest, assets.manifest);
    assert.ok(Object.keys(manifest.assets).length > 0);
  }
});

test("ForgeGraph frontend entrypoint forwards explicit profile flags to the build task", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "school-build-"));
  try {
    const output = join(dir, "invocation.json");
    writeFileSync(join(dir, "pnpm"), `#!${process.execPath}
require('node:fs').writeFileSync(process.env.PROFILE_TEST_OUTPUT, JSON.stringify({args: process.argv.slice(2), school: process.env.VITE_EDUCATEOS_SCHOOL_MODE, access: process.env.VITE_CF_ACCESS_MODE}));
`, { mode: 0o755 });
    for (const value of ["false", "true"]) {
      execFileSync(process.execPath, [new URL("./build-frontend.ts", import.meta.url).pathname], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, EDUCATEOS_SCHOOL_BUILD: value, VITE_EDUCATEOS_SCHOOL_MODE: "true", PROFILE_TEST_OUTPUT: output },
      });
      assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
        args: ["exec", "vp", "run", "-F", "@gadgets/workshop-frontend", "build"], school: value, access: "true",
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release CLI and environment select the same school assets and authority profile", () => {
  for (const [env, requested] of [
    [{}, "school"], [{ EDUCATEOS_SCHOOL_BUILD: "true" }, undefined],
    [{ EDUCATEOS_SCHOOL_BUILD: "true" }, "school"],
  ] as const) {
    const result = releaseProfile(env, requested);
    assert.equal(result.profile, "school");
    assert.equal(result.variant, "access-school");
    assert.equal(result.env.VITE_EDUCATEOS_SCHOOL_MODE, "true");
    assert.equal(result.env.EDUCATEOS_SCHOOL_BUILD, "true");
  }
  assert.equal(releaseProfile({}).profile, "generic");
  assert.equal(releaseProfile({}, "generic").variant, "access");
  assert.throws(() => releaseProfile({ EDUCATEOS_SCHOOL_BUILD: "false" }, "school"), /conflicts/);
  assert.throws(() => releaseProfile({ EDUCATEOS_SCHOOL_BUILD: "true" }, "generic"), /conflicts/);
  assert.throws(() => releaseProfile({ EDUCATEOS_SCHOOL_BUILD: "typo" }, "school"), /must be true or false/);
});
