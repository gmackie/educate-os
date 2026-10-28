// One district, composed over its Durable Object's storage: the district application and its school
// tools. This module imports nothing Workers-only, so it is type-checked on the web-standard surface
// with the rest of the EducateOS libraries it composes (ADR-0009); `district-object.ts` is the
// Durable Object shell around it.
import type { JWTVerifyGetKey } from "jose";
import { AcademicDirectory } from "@educateos/academics";
import { checkDirectoryIntegrity, DistrictDirectorySnapshot } from "@educateos/contracts";
import type { ImportFetch } from "@educateos/content-studio";
import { createDirectoryPrincipalResolver } from "@educateos/identity";
import { academicSchoolTools, SchoolToolRunner } from "@educateos/policy";
import { authorityFor, createDistrictApp, type DistrictApp, type RosterSourceFactory } from "@educateos/district-app";
import { clever, googleclassroom } from "@educateos/integrations";
import { durableDistrictStores, DurableObjectToolApprovalStore, type DistrictSqlStorage } from "@educateos/district-app/durable-stores";
import { createSchoolToolService, type SchoolToolService } from "@educateos/gatekeeper";
import { accessAudiences, accessRequestVerifier } from "./access.ts";
import { readDistrictWorkerConfig, type DistrictWorkerConfig } from "./config.ts";
// Communication (SCHO-189)
import { cloudflareEmailSender, type SendEmailBinding } from "./mail.ts";
// LTI 1.3 Tool (SCHO-177)
import { startDistrictLti, type DistrictLti } from "./lti.ts";

/** The district application and its school tools. */
export interface District {
  /** The application: the `/api` surface and the AI call guard's read model. */
  app: DistrictApp;
  /** The school tools the EducateOS gatekeeper reaches. */
  tools: SchoolToolService;
  /** The district's LTI 1.3 Tool, when the deployment names its origin (SCHO-177). */
  lti: DistrictLti | undefined;
}

/** The Worker's settings a district starts from: its vars, as text. */
export interface DistrictSettings {
  /** `DISTRICT_CONFIG`, the district's configuration as JSON. */
  config: string | undefined;
  /** `CF_ACCESS_ISS`, the Access team domain. */
  accessIssuer: string | undefined;
  /** `CF_ACCESS_AUD`, the audiences of the Access applications it accepts, comma-separated (see `accessAudiences`). */
  accessAudiences: string | undefined;
  /** `LTI_TOOL_ORIGIN`, the LTI Tool's public https origin. Without it the district serves no LTI routes. */
  ltiToolOrigin?: string | undefined;
  /** `CLEVER_DISTRICT_TOKEN`, the district-app token Clever issued for the district (SCHO-203). Without it no Clever roster syncs. */
  cleverDistrictToken?: string | undefined;
  /** `GOOGLE_CLASSROOM_SERVICE_ACCOUNT_KEY`, a JSON service-account key with district-authorized DWD. */
  classroomServiceAccountKey?: string | undefined;
  /** `DEVICE_TOKEN_SECRET`, the key device access tokens are MACed with (SCHO-261). Without it no device signs in. */
  deviceTokenSecret?: string | undefined;
}

/** What a district reaches outside its storage. */
export interface DistrictSeams {
  /** The fetch the Content Studio imports URLs with, after its own URL checks. */
  importFetch: ImportFetch;
  /** The keys Access assertions are verified with. Defaults to the team's published certs. */
  accessKeys?: JWTVerifyGetKey;
  /** The Worker's Cloudflare Email Service binding (`SEND_EMAIL`), if it has one (SCHO-189). */
  sendEmail?: SendEmailBinding;
  /** Told the ID of a configuration revision policy cannot read and passes over (SCHO-232), to log it. */
  onUnreadableConfigRevision?: (revisionId: string) => void;
  /** The fetch LTI platform calls go through (SCHO-177). Defaults to the global fetch. */
  platformFetch?: typeof fetch;
  /** The fetch roster syncs reach their provider with (SCHO-203). Defaults to the global fetch. */
  rosterFetch?: typeof fetch;
}

/** The district ID `DISTRICT_CONFIG` names, which its Durable Object is named by. */
export function configuredDistrictId(config: string | undefined): string {
  return readDistrictWorkerConfig(config).directory.district.id;
}

/**
 * Builds a Clever or Classroom roster source using deployment credentials. Other providers
 * return an explicit unavailable reason; credentials never come from configuration revisions.
 */
export function workerRosterSource(
  token: string | undefined,
  rosterFetch: typeof fetch,
  classroom?: { config: NonNullable<DistrictWorkerConfig["classroom"]>; key: string | undefined },
): RosterSourceFactory {
  return (rostering) => {
    if (rostering.provider === "google-classroom") {
      if (classroom === undefined) return { reason: "no Classroom connection is configured" };
      if (!classroom.key) return { reason: "no GOOGLE_CLASSROOM_SERVICE_ACCOUNT_KEY secret is set" };
      const tokens = googleclassroom.serviceAccountTokens({
        key: classroom.key,
        scopes: classroom.config.rosterScopes === "read-write"
          ? googleclassroom.CLASSROOM_ROSTER_SCOPES_READ_WRITE
          : googleclassroom.CLASSROOM_ROSTER_SCOPES,
        fetch: rosterFetch,
      });
      return { source: googleclassroom.classroomRosterSource(new googleclassroom.GoogleClassroomClient({
        tokens, admin: classroom.config.admin, fetch: rosterFetch,
      }), classroom.config.roster) };
    }
    if (rostering.provider !== "clever") return { reason: `the district Worker has no roster source for ${rostering.provider}` };
    if (rostering.clever === undefined) return { reason: "the roster names no Clever district" };
    if (token === undefined || token === "") return { reason: "no CLEVER_DISTRICT_TOKEN secret is set" };
    return { source: clever.cleverRosterSource(new clever.CleverDataClient({ connection: rostering.clever, token, fetch: rosterFetch })) };
  };
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
  if (config.additionalTrustedIssuers !== undefined) {
    const { snapshot, version } = await stores.directory.load();
    const trustedIssuers = [...new Set([...snapshot.district.trustedIssuers, ...config.additionalTrustedIssuers])];
    if (JSON.stringify(snapshot.district.trustedIssuers) !== JSON.stringify(trustedIssuers)) {
      const next = DistrictDirectorySnapshot.parse({ ...snapshot, district: { ...snapshot.district, trustedIssuers } });
      if (checkDirectoryIntegrity(next).length > 0) {
        throw new Error("Deployment issuer trust would invalidate existing district identity links.");
      }
      await stores.directory.commit(next, version);
    }
  }
  const verifyRequest = accessRequestVerifier({
    issuer: settings.accessIssuer ?? "",
    audiences: accessAudiences(settings.accessAudiences),
    ...(seams.accessKeys === undefined ? {} : { keys: seams.accessKeys }),
    ...(config.cleverSso === undefined ? {} : { clever: config.cleverSso }),
  });
  const authority = authorityFor(config.authority);
  const app = await createDistrictApp({
    stores,
    verifyRequest,
    importFetch: seams.importFetch,
    ...(seams.onUnreadableConfigRevision === undefined ? {} : { onUnreadableConfigRevision: seams.onUnreadableConfigRevision }),
    authority,
    // Scheduled roster sync (SCHO-203)
    rosterSource: workerRosterSource(settings.cleverDistrictToken, seams.rosterFetch ?? ((input, init) => fetch(input, init)),
      config.classroom === undefined ? undefined : { config: config.classroom, key: settings.classroomServiceAccountKey }),
    ...(config.rosterServicePrincipalId === undefined ? {} : { rosterServicePrincipalId: config.rosterServicePrincipalId }),
    ...(config.fundingPools === undefined ? {} : { fundingPools: config.fundingPools }),
    ...(config.aiMonthlyDistrictCapUsdNano === undefined ? {} : { aiMonthlyDistrictCapUsdNano: config.aiMonthlyDistrictCapUsdNano }),
    ...(config.cloudflareAccount === undefined ? {} : { cloudflareAccount: config.cloudflareAccount }),
    ...(config.modelCatalog === undefined ? {} : { modelCatalog: config.modelCatalog }),
    ...(config.approvedExternalHosts === undefined ? {} : { approvedExternalHosts: config.approvedExternalHosts }),
    ...(config.retention === undefined ? {} : { retention: config.retention }),
    // Communication (SCHO-189): email only with both the binding and a configured sender. The family
    // digest goes out over the guardian relationships this object stores (SCHO-188).
    ...(seams.sendEmail === undefined || config.email === undefined
      ? {}
      : { mail: cloudflareEmailSender(seams.sendEmail, { from: config.email.from, fromName: config.email.fromName }) }),
    ...(config.email?.appUrl === undefined ? {} : { appUrl: config.email.appUrl }),
    // Devices (SCHO-261)
    ...(settings.deviceTokenSecret === undefined ? {} : { deviceTokenSecret: settings.deviceTokenSecret }),
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
    serveAs: (principal, request) => app.serveAs(principal, request),
  });
  const lti = settings.ltiToolOrigin === undefined || settings.ltiToolOrigin === ""
    ? undefined
    : startDistrictLti({
      storage,
      app,
      stores,
      verifyRequest,
      toolOrigin: settings.ltiToolOrigin,
      platformFetch: seams.platformFetch ?? ((input, init) => fetch(input, init)),
    });
  return { app, tools, lti };
}
