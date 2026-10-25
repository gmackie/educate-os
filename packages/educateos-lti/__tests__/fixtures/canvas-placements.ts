// The id_token claims Canvas sends for each placement EducateOS registers, beyond the core claims the
// fake platform fills in (iss, aud, sub, nonce, message type, version, deployment, target link).
// Shapes follow Canvas's LTI 1.3 launches with privacy level "anonymous": no name, email or picture.
// Hosts are reserved `.example` names.
import type { CanvasPlacement } from "../../src/index.ts";

const LTI = "https://purl.imsglobal.org/spec/lti/claim/";
const DL = "https://purl.imsglobal.org/spec/lti-dl/claim/";
const ROLES = "http://purl.imsglobal.org/vocab/lis/v2/";
const CANVAS = "https://canvas.northfield.example";

/** Claims every Canvas launch carries. */
const common = (contextId: string) => ({
  "https://www.instructure.com/placement": undefined as string | undefined,
  [`${LTI}context`]: {
    id: contextId,
    label: "BIO-P2",
    title: "Biology I, Period 2",
    type: ["http://purl.imsglobal.org/vocab/lis/v2/course#CourseOffering"],
    validation_context: null,
    errors: { errors: {} },
  },
  [`${LTI}tool_platform`]: {
    guid: "canvas-platform-guid-example",
    name: "Northfield Schools",
    version: "cloud",
    product_family_code: "canvas",
    validation_context: null,
    errors: { errors: {} },
  },
  [`${LTI}launch_presentation`]: { document_target: "iframe", return_url: `${CANVAS}/courses/1/external_content/success/external_tool_redirect`, locale: "en" },
  [`${LTI}roles`]: [`${ROLES}membership#Instructor`, `${ROLES}institution/person#Instructor`],
  [`${LTI}custom`]: {},
  [`${LTI}lti11_legacy_user_id`]: "legacy-user-id-example",
  errors: { errors: {} },
  locale: "en",
});

const deepLinking = (overrides: Record<string, unknown>) => ({
  [`${DL}deep_linking_settings`]: {
    deep_link_return_url: `${CANVAS}/courses/1/deep_linking_response?modal=true`,
    accept_types: ["ltiResourceLink"],
    accept_presentation_document_targets: ["iframe", "window"],
    accept_media_types: "application/vnd.ims.lti.v1.ltilink",
    accept_multiple: true,
    auto_create: false,
    validation_context: null,
    errors: { errors: {} },
    ...overrides,
  },
});

/** The Canvas-specific claims of a launch from each placement, in the given Canvas course. */
export function canvasPlacementClaims(placement: CanvasPlacement, contextId: string): Record<string, unknown> {
  const base = { ...common(contextId), "https://www.instructure.com/placement": placement };
  switch (placement) {
    case "course_navigation":
      return {
        ...base,
        [`${LTI}resource_link`]: {
          id: "canvas-course-nav-resource-link",
          description: null,
          title: "Biology I, Period 2",
          validation_context: null,
          errors: { errors: {} },
        },
      };
    case "link_selection":
      return { ...base, ...deepLinking({}) };
    case "assignment_selection":
      return { ...base, ...deepLinking({ accept_multiple: false }) };
    case "editor_button":
      return {
        ...base,
        ...deepLinking({
          accept_types: ["link", "file", "html", "ltiResourceLink", "image"],
          accept_presentation_document_targets: ["embed", "iframe", "window"],
          accept_media_types: "image/*,text/html,application/vnd.ims.lti.v1.ltilink,*/*",
        }),
      };
  }
}
