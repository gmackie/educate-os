import type { LaunchMessageType } from "./claims.ts";
import type { LtiToolEndpoints } from "./broker.ts";
import { LTI_SCOPES } from "./service-client.ts";

/** The Canvas placements EducateOS offers, and the message each one sends. */
export const CANVAS_PLACEMENTS = {
  /** A course navigation tab that opens the offering. */
  course_navigation: "LtiResourceLinkRequest",
  /** Adding a EducateOS activity to a module. */
  link_selection: "LtiDeepLinkingRequest",
  /** Choosing a EducateOS activity as an assignment's external tool. */
  assignment_selection: "LtiDeepLinkingRequest",
  /** Embedding a EducateOS activity from the rich content editor. */
  editor_button: "LtiDeepLinkingRequest",
} as const satisfies Record<string, LaunchMessageType>;

/** A Canvas placement name. */
export type CanvasPlacement = keyof typeof CANVAS_PLACEMENTS;

/** One placement in a Canvas developer key's `extensions[].settings.placements`. */
export interface CanvasPlacementConfig {
  readonly placement: CanvasPlacement;
  readonly message_type: LaunchMessageType;
  readonly target_link_uri: string;
  readonly text: string;
}

/** The JSON a Canvas administrator pastes into an LTI 1.3 developer key ("Paste JSON"). */
export interface CanvasDeveloperKeyJson {
  readonly title: string;
  readonly description: string;
  readonly oidc_initiation_url: string;
  readonly target_link_uri: string;
  readonly public_jwk_url: string;
  /** The LTI Advantage scopes the tool may request: AGS line items, results and scores, and NRPS. */
  readonly scopes: readonly string[];
  readonly extensions: readonly [
    {
      readonly platform: "canvas.instructure.com";
      readonly domain: string;
      /**
       * `anonymous`: Canvas sends `sub` but no name or email. EducateOS identifies people by
       * `(district, issuer, sub)` only, so it never asks for more.
       */
      readonly privacy_level: "anonymous";
      readonly settings: { readonly text: string; readonly placements: readonly CanvasPlacementConfig[] };
    },
  ];
  readonly custom_fields: Readonly<Record<string, string>>;
}

/**
 * The Canvas developer key configuration for a EducateOS tool. Every placement launches through
 * `/lti/launch`; Canvas's key form also needs that URL under "Redirect URIs".
 */
export function canvasDeveloperKey(endpoints: LtiToolEndpoints, title = "EducateOS"): CanvasDeveloperKeyJson {
  const placements = (Object.keys(CANVAS_PLACEMENTS) as CanvasPlacement[]).map((placement) => ({
    placement,
    message_type: CANVAS_PLACEMENTS[placement],
    target_link_uri: endpoints.launch,
    text: title,
  }));
  return {
    title,
    description: "EducateOS courses and activities.",
    oidc_initiation_url: endpoints.login,
    target_link_uri: endpoints.launch,
    public_jwk_url: endpoints.jwks,
    scopes: [
      LTI_SCOPES.lineItem,
      LTI_SCOPES.lineItemReadonly,
      LTI_SCOPES.resultReadonly,
      LTI_SCOPES.score,
      LTI_SCOPES.contextMembershipReadonly,
    ],
    extensions: [
      {
        platform: "canvas.instructure.com",
        domain: new URL(endpoints.launch).host,
        privacy_level: "anonymous",
        settings: { text: title, placements },
      },
    ],
    custom_fields: {},
  };
}
