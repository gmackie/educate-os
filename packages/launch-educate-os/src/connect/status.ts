// `launch-educate-os status`: what the installed district is connected to and whether each part
// works, with the fix for anything that doesn't. Reads only: the district's public paths, the
// district Worker's secret names (never values) with the install token, the answers file, and,
// with a district administrator's Access token, the district's own LTI and roster status.
import { adminSession, type ConnectContext, probe } from "./district.ts";
import { readDistrictConfig } from "./district-config.ts";
import type { StatusRow } from "./outcome.ts";
import { CLASSROOM_KEY_SECRET, CLEVER_TOKEN_SECRET, rosterSyncStatus } from "./roster.ts";

export type { StatusRow };

interface Registrations {
  registrations: { provider: string; issuer: string; offerings: unknown[] }[];
  pending: { issuer: string }[];
}

/** Every row of the status report. Never throws for a failing check: the row says what failed. */
export async function districtStatus(context: ConnectContext, options: { cloudflare: boolean }): Promise<StatusRow[]> {
  const { district, fetch: fetchImpl } = context;
  const rows: StatusRow[] = [];

  const health = await probe(fetchImpl, district.origin, "/healthz");
  rows.push(health.status === 200
    ? { area: "district", state: "ok", detail: `${district.origin} answers` }
    : { area: "district", state: "failing", detail: health.status === 0 ? `no response from ${district.origin}` : `${district.origin}/healthz answered HTTP ${health.status}`, fix: "Run `npx launch-educate-os plan`: it shows anything missing from the install." });

  const home = await probe(fetchImpl, district.origin, "/");
  const toAccess = home.status >= 300 && home.status < 400 && (home.location ?? "").includes(district.accessTeamDomain);
  rows.push(toAccess
    ? { area: "sign-in", state: "ok", detail: `Cloudflare Access (${district.accessTeamDomain}) asks people to sign in` }
    : home.status === 0
      ? { area: "sign-in", state: "failing", detail: "no response" }
      : { area: "sign-in", state: "failing", detail: `${district.origin}/ answered HTTP ${home.status} without sending people to ${district.accessTeamDomain}`, fix: "Run `npx launch-educate-os`: it restores the Access application in front of the district." });

  const jwks = await probe(fetchImpl, district.ltiOrigin, "/lti/jwks");
  const keys = (jwks.body as { keys?: unknown[] } | undefined)?.keys;
  const toolOk = jwks.status === 200 && Array.isArray(keys) && keys.length > 0;
  rows.push(toolOk
    ? { area: "lti-tool", state: "ok", detail: `the LTI 1.3 Tool publishes ${keys!.length} key(s) at ${district.ltiOrigin}/lti/jwks` }
    : { area: "lti-tool", state: "failing", detail: `${district.ltiOrigin}/lti/jwks answered HTTP ${jwks.status}`, fix: jwks.status >= 300 && jwks.status < 400 ? "Access is in front of /lti/*: run `npx launch-educate-os` to restore the bypass." : "Run `npx launch-educate-os plan` and apply what it shows." });

  let secrets: string[] | undefined;
  if (options.cloudflare) {
    try {
      secrets = await (await context.cloudflare()).api.listWorkerSecrets(district.accountId, district.scriptName);
    } catch {
      secrets = undefined;
    }
  }
  // The administrator's token from the environment only: a status report asks nothing.
  const admin = context.admin ?? await adminSession({ ...context, prompter: undefined });

  // The LMSs: the district's registrations, which only an administrator can read.
  if (admin) {
    try {
      const { registrations, pending } = await admin.call<Registrations>("GET", "/api/lti/registrations");
      for (const lms of ["canvas", "moodle"] as const) {
        const approved = registrations.filter((r) => r.provider === lms);
        rows.push(approved.length > 0
          ? { area: lms, state: "ok", detail: `${approved.length} registration(s): ${approved.map((r) => `${r.issuer} (${r.offerings.length} course(s))`).join(", ")}` }
          : { area: lms, state: "not configured", detail: "no approved registration", fix: `npx launch-educate-os connect ${lms}` });
      }
      if (pending.length > 0) {
        rows.push({ area: "lti-pending", state: "failing", detail: `${pending.length} registration(s) waiting for approval: ${pending.map((p) => p.issuer).join(", ")}`, fix: "npx launch-educate-os connect <canvas|moodle> --issuer <issuer>" });
      }
    } catch (error) {
      rows.push({ area: "lms", state: "failing", detail: `the district's LTI registrations couldn't be read: ${error instanceof Error && error.name === "EducateOsError" ? error.message : "unexpected error"}` });
    }
  } else {
    rows.push({ area: "lms", state: "unknown", detail: "registrations need a district administrator's Access token", fix: "set EDUCATEOS_ACCESS_TOKEN (cloudflared access token --app <origin>) and run again" });
  }

  // The roster: credentials on the Worker, the configuration, then the district's own view.
  const config = readDistrictConfig(context.answers) ?? {};
  const secretRow = (area: string, name: string, configured: boolean, fix: string): StatusRow => {
    if (secrets === undefined) return { area, state: "unknown", detail: "Worker secrets need the Cloudflare API token", fix: "set CLOUDFLARE_API_TOKEN and run again" };
    if (!secrets.includes(name)) return { area, state: "not configured", detail: `no ${name} on ${district.scriptName}`, fix };
    return configured
      ? { area, state: "ok", detail: `${name} is set` }
      : { area, state: "failing", detail: `${name} is set but the district configuration is incomplete`, fix };
  };
  rows.push(secretRow("clever", CLEVER_TOKEN_SECRET, true, "npx launch-educate-os connect clever"));
  rows.push(secretRow("google-classroom", CLASSROOM_KEY_SECRET, config.classroom !== undefined, "npx launch-educate-os connect google-classroom"));
  if (admin) {
    try {
      const sync = await rosterSyncStatus(admin);
      const last = sync.runs.at(-1);
      rows.push(sync.runnable
        ? { area: "roster-sync", state: "ok", detail: `${sync.provider}: ready${last ? `; last run ${last.status ?? "?"} at ${last.finishedAt ?? last.startedAt ?? "?"}` : "; no run yet"}` }
        : sync.provider === "none" || sync.provider === "manual" || sync.provider === "oneroster-csv"
          ? { area: "roster-sync", state: "not configured", detail: `provider ${sync.provider}${sync.reason ? `: ${sync.reason}` : ""}`, fix: "npx launch-educate-os connect (choose a roster)" }
          : { area: "roster-sync", state: "failing", detail: `${sync.provider} can't sync: ${sync.reason ?? "no reason given"}`, fix: `npx launch-educate-os connect ${sync.provider}` });
    } catch (error) {
      rows.push({ area: "roster-sync", state: "failing", detail: `the roster status couldn't be read: ${error instanceof Error && error.name === "EducateOsError" ? error.message : "unexpected error"}` });
    }
  }
  rows.push({ area: "oneroster-api", state: "not available", detail: "scheduled OneRoster API and ClassLink sync aren't wired into the district yet; import OneRoster CSV with `connect oneroster`" });
  return rows;
}
