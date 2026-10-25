// Extracted from PlayTrek `packages/lti/src/deep-linking/content-items.ts` at commit 7258e4347.
// PlayTrek delegated signing to `@gmacko/lti` and returned an empty `jwt`; this version signs the
// response itself with the tool key, and its content items carry an opaque EducateOS link ID instead
// of product IDs the platform could edit to point anywhere.
import { SignJWT } from "jose";
import type { ActivityId } from "@educateos/contracts";
import { LTI_CLAIM, LTI_VERSION, EDUCATEOS_LINK_PARAMETER } from "./claims.ts";
import type { ToolKey } from "./tool-keys.ts";

/** A content item that launches one EducateOS activity, as Deep Linking 2.0 `ltiResourceLink`. */
export interface ActivityContentItem {
  readonly type: "ltiResourceLink";
  readonly title: string;
  readonly text?: string;
  /** The tool's launch URL. */
  readonly url: string;
  readonly custom: { readonly [EDUCATEOS_LINK_PARAMETER]: string };
}

/** An activity a principal chose to place, and how the platform should label it. */
export interface DeepLinkSelection {
  readonly activityId: ActivityId;
  readonly title: string;
  readonly text?: string;
}

/** The content item for an activity, given the link ID recorded for it. */
export function activityContentItem(selection: DeepLinkSelection, launchUrl: string, linkId: string): ActivityContentItem {
  return {
    type: "ltiResourceLink",
    title: selection.title,
    ...(selection.text === undefined ? {} : { text: selection.text }),
    url: launchUrl,
    custom: { [EDUCATEOS_LINK_PARAMETER]: linkId },
  };
}

/** What a signed deep linking response is built from. */
export interface DeepLinkingResponseInput {
  /** The tool's client ID: the response's `iss`. */
  readonly clientId: string;
  /** The platform issuer: the response's `aud`. */
  readonly platformIssuer: string;
  readonly deploymentId: string;
  readonly items: readonly ActivityContentItem[];
  /** The request's opaque `data`, echoed back unchanged. */
  readonly data: string | undefined;
  readonly signingKey: ToolKey;
  /** Seconds since the epoch. */
  readonly issuedAt: number;
  readonly nonce: string;
}

/** Lifetime of a deep linking response JWT. It is posted to the platform immediately. */
const RESPONSE_LIFETIME_SECONDS = 5 * 60;

/** Signs an `LtiDeepLinkingResponse` JWT with the tool's signing key. */
export async function signDeepLinkingResponse(input: DeepLinkingResponseInput): Promise<string> {
  return new SignJWT({
    nonce: input.nonce,
    [LTI_CLAIM.messageType]: "LtiDeepLinkingResponse",
    [LTI_CLAIM.version]: LTI_VERSION,
    [LTI_CLAIM.deploymentId]: input.deploymentId,
    [LTI_CLAIM.contentItems]: input.items,
    ...(input.data === undefined ? {} : { [LTI_CLAIM.data]: input.data }),
  })
    .setProtectedHeader({ alg: "RS256", kid: input.signingKey.kid, typ: "JWT" })
    .setIssuer(input.clientId)
    .setAudience(input.platformIssuer)
    .setIssuedAt(input.issuedAt)
    .setExpirationTime(input.issuedAt + RESPONSE_LIFETIME_SECONDS)
    .sign(input.signingKey.privateKey);
}

const escapeAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * An HTML page that form-posts `jwt` to the platform's `deep_link_return_url` as the spec requires.
 * It submits itself; the button covers browsers with scripts disabled.
 */
export function deepLinkingReturnPage(returnUrl: string, jwt: string): string {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><title>Returning to your course</title></head><body>',
    `<form id="lti-return" method="post" action="${escapeAttribute(returnUrl)}">`,
    `<input type="hidden" name="JWT" value="${escapeAttribute(jwt)}">`,
    '<button type="submit">Continue</button>',
    "</form>",
    '<script>document.getElementById("lti-return").submit();</script>',
    "</body></html>",
  ].join("");
}
