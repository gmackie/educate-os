// Test worker: the production fetch handler and entrypoints, and the production `DistrictObject`
// with two seams replaced. It verifies Access assertions against this run's test key rather than a
// team's published certs, and imports from a synthetic web rather than the internet. Everything else,
// storage included, is the deployed code.

import { createLocalJWKSet, type JWK, type JWTVerifyGetKey } from "jose";
import { catalogSeedRelease } from "@educateos/catalog";
import type { PrincipalId } from "@educateos/contracts";
import { DistrictObject as DeployedDistrictObject } from "../src/district-object.ts";
import type { SendEmailBinding } from "../src/mail.ts";
import { LMS_ISSUER } from "./fixtures.ts";

// Named rather than `export *`: the pool finds entrypoints from the module's named exports.
export { DistrictPrincipalResolver, DistrictApi, DistrictGuardDirectory, DistrictSchoolTools } from "../src/worker.ts";
export { default } from "../src/worker.ts";

/** The synthetic pages teachers import, by URL. Every other URL is a 404. */
export const PAGES: Readonly<Record<string, string>> = {
  "https://open-lessons.example/persuasive-writing": "Persuasive Writing Models",
};

/** The district's object, as deployed apart from its Access keys and its web. */
export class DistrictObject extends DeployedDistrictObject {
  /** What the district handed its Email Service binding, since this instance started (SCHO-189). */
  readonly #sent: Parameters<SendEmailBinding["send"]>[0][] = [];

  /** Records email instead of sending it: the deployed sender is unchanged, only the binding is a recorder. */
  protected override sendEmail(): SendEmailBinding {
    return {
      send: async (message) => {
        this.#sent.push(structuredClone(message));
        return { messageId: `test-${this.#sent.length}` };
      },
    };
  }

  /** Runs the hourly roster sync as the Cron Trigger does, and says what it did (SCHO-203). */
  async scheduledRosterSync(): Promise<{ ran: boolean; reason?: string }> {
    const outcome = await (await this.districtApp()).rostering.runScheduledSync();
    return outcome.ran ? { ran: true } : { ran: false, reason: outcome.reason };
  }

  /** The email recorded so far. */
  async sentEmail(): Promise<Parameters<SendEmailBinding["send"]>[0][]> {
    return structuredClone(this.#sent);
  }

  protected override accessKeys(): JWTVerifyGetKey {
    return createLocalJWKSet({ keys: [JSON.parse(this.env.TEST_ACCESS_PUBLIC_JWK) as JWK] });
  }

  /**
   * A synthetic LMS (SCHO-177): its OpenID configuration, a registration endpoint that assigns a
   * client and deployment, and the JWKS of the key the tests sign launches with.
   */
  protected override async platformFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    if (request.url === `${LMS_ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: LMS_ISSUER,
        authorization_endpoint: `${LMS_ISSUER}/api/lti/authorize_redirect`,
        token_endpoint: `${LMS_ISSUER}/login/oauth2/token`,
        jwks_uri: `${LMS_ISSUER}/api/lti/security/jwks`,
        registration_endpoint: `${LMS_ISSUER}/api/lti/registrations`,
      });
    }
    if (request.url === `${LMS_ISSUER}/api/lti/registrations` && request.method === "POST") {
      return Response.json({ client_id: "lms-client-1", "https://purl.imsglobal.org/spec/lti-tool-configuration": { deployment_id: "lms-deploy-1" } });
    }
    if (request.url === `${LMS_ISSUER}/api/lti/security/jwks`) return Response.json({ keys: [JSON.parse(this.env.TEST_PLATFORM_PUBLIC_JWK) as JWK] });
    return new Response("not found", { status: 404 });
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
