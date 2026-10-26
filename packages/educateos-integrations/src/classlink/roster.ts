// ClassLink rostering: ClassLink's Roster Server serves OneRoster 1.2 REST under OAuth 2.0 client
// credentials, so a ClassLink roster is the OneRoster REST client and source with ClassLink's
// token endpoint and defaults. Nothing here forks the client: a district that is not on ClassLink
// (riverbend) configures the client directly and is unaffected.
import { ClassLinkRosterConnection, type ClassLinkRosterConnectionInput } from "@educateos/contracts";
import { z } from "zod";
import { RosterSyncError } from "../sync-run.ts";
import { OneRosterRestClient, type OneRosterRestClientOptions, type OneRosterRestConfigInput } from "../oneroster/rest/client.ts";
import { restRosterSource } from "../oneroster/rest/source.ts";
import type { RosterSource } from "../oneroster/sync.ts";

/**
 * The OneRoster REST client configuration for a ClassLink Roster Server: the rostering service
 * below `serverUrl`, and the token endpoint at `serverUrl` plus `tokenPath`.
 */
export function classLinkRosterConfig(connection: ClassLinkRosterConnectionInput, pageSize?: number): OneRosterRestConfigInput {
  const parsed = ClassLinkRosterConnection.safeParse(connection);
  if (!parsed.success) {
    throw new RosterSyncError("internal-error", `ClassLink roster connection is invalid: ${z.prettifyError(parsed.error)}`);
  }
  const { serverUrl, tokenPath, scopes, clientAuthentication } = parsed.data;
  const tokenUrl = new URL(serverUrl);
  tokenUrl.pathname = `${tokenUrl.pathname.replace(/\/+$/, "")}${tokenPath}`;
  tokenUrl.search = "";
  tokenUrl.hash = "";
  return { baseUrl: serverUrl, tokenUrl: tokenUrl.href, scopes, clientAuthentication, ...(pageSize === undefined ? {} : { pageSize }) };
}

/** Everything a ClassLink roster source needs: the connection in place of a client configuration. */
export interface ClassLinkRosterOptions extends Omit<OneRosterRestClientOptions, "config"> {
  /** The connection, from the district's configuration revision. */
  connection: ClassLinkRosterConnectionInput;
  /** Records asked for per page, when not the client's default. */
  pageSize?: number;
}

/** A roster source reading a district's ClassLink Roster Server, complete or as a delta. */
export function classLinkRosterSource(options: ClassLinkRosterOptions): RosterSource {
  const { connection, pageSize, ...client } = options;
  return restRosterSource(new OneRosterRestClient({ ...client, config: classLinkRosterConfig(connection, pageSize) }));
}
