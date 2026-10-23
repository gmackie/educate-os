// Test worker: the production fetch handler and entrypoints, and the production `DistrictObject`
// with two seams replaced. It verifies Access assertions against this run's test key rather than a
// team's published certs, and imports from a synthetic web rather than the internet. Everything else,
// storage included, is the deployed code.

import { createLocalJWKSet, type JWK, type JWTVerifyGetKey } from "jose";
import { catalogSeedRelease } from "@schoolos/catalog";
import type { PrincipalId } from "@schoolos/contracts";
import { DistrictObject as DeployedDistrictObject } from "../src/district-object.ts";

// Named rather than `export *`: the pool finds entrypoints from the module's named exports.
export { DistrictApi, DistrictGuardDirectory, DistrictSchoolTools } from "../src/worker.ts";
export { default } from "../src/worker.ts";

/** The synthetic pages teachers import, by URL. Every other URL is a 404. */
export const PAGES: Readonly<Record<string, string>> = {
  "https://open-lessons.example/persuasive-writing": "Persuasive Writing Models",
};

/** The district's object, as deployed apart from its Access keys and its web. */
export class DistrictObject extends DeployedDistrictObject {
  protected override accessKeys(): JWTVerifyGetKey {
    return createLocalJWKSet({ keys: [JSON.parse(this.env.TEST_ACCESS_PUBLIC_JWK) as JWK] });
  }

  protected override async importFetch(url: string): Promise<Response> {
    const title = PAGES[url];
    if (title === undefined) return new Response("not found", { status: 404 });
    return new Response(`<!doctype html><html lang="en"><head><title>${title}</title></head><body><p>Synthetic text.</p></body></html>`, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  /**
   * Selects, installs and approves the ELA catalog seed as `admin`, so activities can align to it.
   * The catalog has no `/api` route yet; the harness approves its seeds the same way.
   */
  async approveCatalogSeed(admin: string): Promise<{ frameworkKey: string; competencyUri: string }> {
    const { catalog } = await this.districtApp();
    const release = await catalogSeedRelease("ccss-ela");
    const actor = { by: admin as PrincipalId, at: new Date().toISOString() };
    await catalog.select("ccss-ela", actor);
    await catalog.install(release, actor);
    await catalog.approve("ccss-ela", release.version, actor);
    return { frameworkKey: "ccss-ela", competencyUri: release.content.nodes![0]!.uri };
  }
}
