// One district, composed over its Durable Object's storage: the district application and its school
// tools. This module imports nothing Workers-only, so it is type-checked on the web-standard surface
// with the rest of the SchoolOS libraries it composes (ADR-0009); `district-object.ts` is the
// Durable Object shell around it.
import type { JWTVerifyGetKey } from "jose";
import { AcademicDirectory } from "@schoolos/academics";
import type { ImportFetch } from "@schoolos/content-studio";
import { createDirectoryPrincipalResolver } from "@schoolos/identity";
import { academicSchoolTools, SchoolToolRunner } from "@schoolos/policy";
import { authorityFor, createDistrictApp, type DistrictApp } from "@schoolos/district-app";
import { durableDistrictStores, DurableObjectToolApprovalStore, type DistrictSqlStorage } from "@schoolos/district-app/durable-stores";
import { createSchoolToolService, type SchoolToolService } from "@schoolos/gatekeeper";
import { accessRequestVerifier } from "./access.ts";
import { readDistrictWorkerConfig } from "./config.ts";
// Communication (SCHO-189)
import { cloudflareEmailSender, type SendEmailBinding } from "./mail.ts";

/** The district application and its school tools. */
export interface District {
  /** The application: the `/api` surface and the AI call guard's read model. */
  app: DistrictApp;
  /** The school tools the SchoolOS gatekeeper reaches. */
  tools: SchoolToolService;
}

/** The Worker's settings a district starts from: its vars, as text. */
export interface DistrictSettings {
  /** `DISTRICT_CONFIG`, the district's configuration as JSON. */
  config: string | undefined;
  /** `CF_ACCESS_ISS`, the Access team domain. */
  accessIssuer: string | undefined;
  /** `CF_ACCESS_AUD`, the Access application's audience. */
  accessAudience: string | undefined;
}

/** What a district reaches outside its storage. */
export interface DistrictSeams {
  /** The fetch the Content Studio imports URLs with, after its own URL checks. */
  importFetch: ImportFetch;
  /** The keys Access assertions are verified with. Defaults to the team's published certs. */
  accessKeys?: JWTVerifyGetKey;
  /** The Worker's Cloudflare Email Service binding (`SEND_EMAIL`), if it has one (SCHO-189). */
  sendEmail?: SendEmailBinding;
}

/** The district ID `DISTRICT_CONFIG` names, which its Durable Object is named by. */
export function configuredDistrictId(config: string | undefined): string {
  return readDistrictWorkerConfig(config).directory.district.id;
}

/**
 * Starts the district in `storage`: its stores (the directory seeded from the configuration on
 * first start), the application over them, and the directory's operations as school tools,
 * decided by the application's engine with writes queued in the same storage. Both the `/api`
 * surface and the gatekeeper's `authenticate` sign in through Cloudflare Access and resolve the
 * identity through the directory as it stands, so they cannot disagree about who a caller is.
 */
export async function startDistrict(storage: DistrictSqlStorage, settings: DistrictSettings, seams: DistrictSeams): Promise<District> {
  const config = readDistrictWorkerConfig(settings.config);
  const stores = durableDistrictStores(storage, config.directory);
  const verifyRequest = accessRequestVerifier({
    issuer: settings.accessIssuer ?? "",
    audience: settings.accessAudience ?? "",
    ...(seams.accessKeys === undefined ? {} : { keys: seams.accessKeys }),
  });
  const authority = authorityFor(config.authority);
  const app = await createDistrictApp({
    stores,
    verifyRequest,
    importFetch: seams.importFetch,
    authority,
    ...(config.fundingPools === undefined ? {} : { fundingPools: config.fundingPools }),
    ...(config.aiMonthlyDistrictCapUsdNano === undefined ? {} : { aiMonthlyDistrictCapUsdNano: config.aiMonthlyDistrictCapUsdNano }),
    ...(config.cloudflareAccount === undefined ? {} : { cloudflareAccount: config.cloudflareAccount }),
    ...(config.modelCatalog === undefined ? {} : { modelCatalog: config.modelCatalog }),
    ...(config.approvedExternalHosts === undefined ? {} : { approvedExternalHosts: config.approvedExternalHosts }),
    ...(config.retention === undefined ? {} : { retention: config.retention }),
    // Communication (SCHO-189): email only with both the binding and a configured sender. Guardian
    // relationships are not stored by this Worker yet (SCHO-188), so no family digest is sent.
    ...(seams.sendEmail === undefined || config.email === undefined
      ? {}
      : { mail: cloudflareEmailSender(seams.sendEmail, { from: config.email.from, fromName: config.email.fromName }) }),
    ...(config.email?.appUrl === undefined ? {} : { appUrl: config.email.appUrl }),
  });

  const directory = new AcademicDirectory({ store: stores.directory, authority, authorizer: app.engine });
  const runner = new SchoolToolRunner({
    engine: app.engine,
    tools: academicSchoolTools(stores.directory, directory),
    approvals: { store: new DurableObjectToolApprovalStore(storage) },
  });
  const tools = createSchoolToolService({
    districtId: app.districtId,
    runner,
    authenticate: async (request) => {
      try {
        const identity = await verifyRequest(request);
        if (identity === undefined) return null;
        const resolved = await createDirectoryPrincipalResolver((await stores.directory.load()).snapshot).resolve(identity);
        return { principalId: resolved.principalId, districtId: resolved.districtId };
      } catch {
        return null;
      }
    },
  });
  return { app, tools };
}
