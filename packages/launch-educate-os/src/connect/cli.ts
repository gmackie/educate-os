// The connect and status commands' share of the CLI: their flags, help text and entry points, kept
// here so cli.ts only registers them.
import type { ConnectFlags } from "./district.ts";
import { ACCESS_TOKEN_ENV } from "./district.ts";
import { INTEGRATION_IDS } from "./outcome.ts";
import { CLEVER_TOKEN_ENV } from "./roster.ts";

export { connectCommand, type ConnectDeps, offerConnect, statusCommand, statusIfDistrict } from "./command.ts";

/** The flags `connect` reads, for `parseArgs`. */
export const CONNECT_OPTIONS = {
  "clever-district-id": { type: "string" },
  "service-account-key": { type: "string" },
  "workspace-admin": { type: "string" },
  "classroom-roster": { type: "string" },
  "classroom-scopes": { type: "string" },
  "csv-dir": { type: "string" },
  issuer: { type: "string" },
  "context-id": { type: "string" },
  "offering-id": { type: "string" },
  "deployment-id": { type: "string" },
} as const;

/** The connect flags from parsed values. */
export function connectFlags(values: Partial<Record<keyof typeof CONNECT_OPTIONS, string | undefined>>): ConnectFlags {
  return {
    cleverDistrictId: values["clever-district-id"],
    serviceAccountKey: values["service-account-key"],
    workspaceAdmin: values["workspace-admin"],
    classroomRoster: values["classroom-roster"],
    classroomScopes: values["classroom-scopes"],
    csvDir: values["csv-dir"],
    issuer: values.issuer,
    contextId: values["context-id"],
    offeringId: values["offering-id"],
    deploymentId: values["deployment-id"],
  };
}

/** The commands' lines in the CLI's usage. */
export const CONNECT_USAGE = `  npx launch-educate-os connect     connect the district's LMS and roster: a menu, or name one of
                                    ${INTEGRATION_IDS.join(", ")}
  npx launch-educate-os status      what the district is connected to and whether it works (no changes);
                                    doctor ends with the same report

Connect options (each also asked for on a terminal):
  --issuer <url>                canvas/moodle: approve the pending registration from this LMS issuer
  --context-id <id>             canvas/moodle: the LMS course to map; --offering-id <off_...> the offering
  --deployment-id <id>          canvas: the deployment ID Canvas shows when the app is installed
  --clever-district-id <id>     clever: the Clever district ID (the token: ${CLEVER_TOKEN_ENV})
  --service-account-key <file>  google-classroom: the service account's JSON key file
  --workspace-admin <email>     google-classroom: the Workspace administrator the sync reads as
  --classroom-roster <file>     google-classroom: the roster configuration (term, schools) as JSON
  --classroom-scopes <s>        google-classroom: readonly (default) or read-write, as delegated
  --csv-dir <dir>               oneroster: the directory holding the OneRoster CSV export
  ${ACCESS_TOKEN_ENV}=<token>  a district administrator's Access token for the district's admin API
                                (cloudflared access token --app https://<district>)`;
