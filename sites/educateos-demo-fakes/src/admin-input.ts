// Parses the admin surface's JSON bodies. Every field is checked, so nothing an operator sends
// reaches a fake unvalidated, and a mistake is answered with what was wrong.
import type { FaultSpec, LtiLaunchInput, LtiPrivacyLevel, LtiToolInput } from "@educateos/provider-fakes";
import { VENDORS, type Vendor } from "./layout.ts";

/** A body the admin surface refuses, with why. */
export class InputError extends Error {
  override readonly name = "InputError";
}

type Json = Record<string, unknown>;

/** The request's JSON object body. */
export async function jsonBody(request: Request): Promise<Json> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new InputError("the body is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InputError("the body is not a JSON object");
  return value as Json;
}

function optionalString(body: Json, name: string): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") throw new InputError(`${name} must be a non-empty string`);
  return value;
}

function requiredString(body: Json, name: string): string {
  const value = optionalString(body, name);
  if (value === undefined) throw new InputError(`${name} is required`);
  return value;
}

function httpsUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InputError(`${name} must be a URL`);
  }
  if (url.protocol !== "https:") throw new InputError(`${name} must be an https URL`);
  return value;
}

function stringList(body: Json, name: string): string[] | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v === "")) throw new InputError(`${name} must be a list of strings`);
  return value as string[];
}

function positiveInteger(body: Json, name: string, max: number): number | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) throw new InputError(`${name} must be an integer from 1 to ${max}`);
  return value;
}

/** A fault to inject, and which of the district's fakes it goes to (all of them by default). */
export interface FaultRequest {
  readonly vendor: Vendor | undefined;
  readonly fault: FaultSpec;
}

/**
 * A fault: `outage`, `rate-limit`, `malformed-record` or `large-removal`, with the fields
 * `FaultSpec` gives each. `match.path` is a substring (patterns do not travel as JSON). A
 * `network-error` cannot be served over HTTP, so it is not offered.
 */
export function parseFault(body: Json): FaultRequest {
  const vendor = optionalString(body, "vendor");
  if (vendor !== undefined && !(VENDORS as readonly string[]).includes(vendor)) throw new InputError(`vendor must be one of ${VENDORS.join(", ")}`);
  const kind = requiredString(body, "kind");
  const times = positiveInteger(body, "times", 1_000_000);
  const rawMatch = body["match"];
  let match: { method?: string; path?: string } | undefined;
  if (rawMatch !== undefined) {
    if (typeof rawMatch !== "object" || rawMatch === null || Array.isArray(rawMatch)) throw new InputError("match must be an object");
    const method = optionalString(rawMatch as Json, "method");
    const path = optionalString(rawMatch as Json, "path");
    match = { ...(method === undefined ? {} : { method }), ...(path === undefined ? {} : { path }) };
  }
  const limits = { ...(times === undefined ? {} : { times }), ...(match === undefined ? {} : { match }) };
  let fault: FaultSpec;
  switch (kind) {
    case "outage": {
      const status = body["status"];
      if (status !== undefined && status !== 500 && status !== 502 && status !== 503 && status !== 504) throw new InputError("status must be 500, 502, 503 or 504");
      fault = { kind, ...(status === undefined ? {} : { status }), ...limits };
      break;
    }
    case "rate-limit":
      fault = { kind, retryAfterSeconds: positiveInteger(body, "retryAfterSeconds", 3600) ?? 30, ...limits };
      break;
    case "malformed-record":
      fault = { kind, ...limits };
      break;
    case "large-removal": {
      const fraction = body["fraction"];
      if (typeof fraction !== "number" || !(fraction > 0 && fraction <= 1)) throw new InputError("fraction must be a number above 0 and at most 1");
      fault = { kind, fraction };
      break;
    }
    default:
      throw new InputError("kind must be outage, rate-limit, malformed-record or large-removal");
  }
  return { vendor: vendor as Vendor | undefined, fault };
}

const PRIVACY_LEVELS: readonly LtiPrivacyLevel[] = ["anonymous", "name_only", "email_only", "public"];

/** An LTI tool to register, as an administrator enters one: https URLs and a JWKS URL to fetch keys from. */
export function parseTool(body: Json): LtiToolInput {
  const name = optionalString(body, "name");
  const initiateLoginUri = httpsUrl(requiredString(body, "initiateLoginUri"), "initiateLoginUri");
  const redirectUris = stringList(body, "redirectUris");
  if (redirectUris === undefined || redirectUris.length === 0) throw new InputError("redirectUris is required");
  for (const uri of redirectUris) httpsUrl(uri, "redirectUris");
  const targetLinkUri = optionalString(body, "targetLinkUri");
  if (targetLinkUri !== undefined) httpsUrl(targetLinkUri, "targetLinkUri");
  const jwksUri = httpsUrl(requiredString(body, "jwksUri"), "jwksUri");
  const scopes = stringList(body, "scopes");
  const custom = body["custom"];
  if (custom !== undefined && (typeof custom !== "object" || custom === null || Array.isArray(custom) || Object.values(custom).some((v) => typeof v !== "string"))) {
    throw new InputError("custom must map strings to strings");
  }
  const privacyLevel = optionalString(body, "privacyLevel");
  if (privacyLevel !== undefined && !(PRIVACY_LEVELS as readonly string[]).includes(privacyLevel)) throw new InputError(`privacyLevel must be one of ${PRIVACY_LEVELS.join(", ")}`);
  return {
    ...(name === undefined ? {} : { name }),
    initiateLoginUri,
    redirectUris,
    ...(targetLinkUri === undefined ? {} : { targetLinkUri }),
    jwksUri,
    ...(scopes === undefined ? {} : { scopes }),
    ...(custom === undefined ? {} : { custom: custom as Record<string, string> }),
    ...(privacyLevel === undefined ? {} : { privacyLevel: privacyLevel as LtiPrivacyLevel }),
  };
}

/** A launch to start: who, in which section, and optionally which tool, message and placement. */
export function parseLaunch(body: Json): LtiLaunchInput {
  const messageType = optionalString(body, "messageType");
  if (messageType !== undefined && messageType !== "LtiResourceLinkRequest" && messageType !== "LtiDeepLinkingRequest") {
    throw new InputError("messageType must be LtiResourceLinkRequest or LtiDeepLinkingRequest");
  }
  const optional = (name: string) => {
    const value = optionalString(body, name);
    return value === undefined ? {} : { [name]: value };
  };
  return {
    personId: requiredString(body, "personId"),
    sectionId: requiredString(body, "sectionId"),
    ...(messageType === undefined ? {} : { messageType }),
    ...optional("clientId"),
    ...optional("deploymentId"),
    ...optional("placement"),
    ...optional("resourceLinkId"),
  } as LtiLaunchInput;
}

/** Starting Dynamic Registration: the tool's registration URL. */
export function parseRegistration(body: Json): string {
  return httpsUrl(requiredString(body, "toolRegistrationUrl"), "toolRegistrationUrl");
}

/** A Classroom token to mint: for whom, with which scopes. */
export function parseClassroomToken(body: Json, allScopes: readonly string[]): { personId: string; scopes: string[] } {
  const scopes = stringList(body, "scopes") ?? [...allScopes];
  const unknown = scopes.find((s) => !allScopes.includes(s));
  if (unknown !== undefined) throw new InputError(`unknown Classroom scope ${unknown}`);
  return { personId: requiredString(body, "personId"), scopes };
}
