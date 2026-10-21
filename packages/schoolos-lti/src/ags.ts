// Extracted from PlayTrek `packages/lti/src/ags/lineitems.ts` and `packages/lti/src/ags/scores.ts`
// at commit 7258e4347, then rewritten for SchoolOS. PlayTrek built the scores URL as
// `${lineitemUrl}/scores`, which breaks line item URLs with a query string (Moodle's carry
// `?type_id=`); sent the bearer token to any line item URL it was handed; returned platform error
// bodies to callers; and exported `postScore` for anyone to call. Here service URLs must stay in the
// context's line item container, error bodies are not read, and a score is published only through
// the grade passback gate (`passback.ts`).
import { z } from "zod";
import { SchoolOsError, type Principal } from "@schoolos/contracts";
import { routeOfKind, type GradeDelivery, type GradeSink, type LmsGradeRoute, type LtiGradeRoute } from "./passback.ts";
import { offeringForContext, type PlatformRegistration, type PlatformRegistrationStore } from "./registration.ts";
import {
  AGS_SCOPES,
  LTI_SCOPES,
  nextPageUrl,
  readJson,
  sameRegistration,
  serviceOrigin,
  type LtiContextServices,
  type LtiScope,
  type LtiServiceClient,
} from "./service-client.ts";

/** AGS media types. */
export const AGS_MEDIA_TYPES = {
  lineItem: "application/vnd.ims.lis.v2.lineitem+json",
  lineItemContainer: "application/vnd.ims.lis.v2.lineitemcontainer+json",
  score: "application/vnd.ims.lis.v1.score+json",
  resultContainer: "application/vnd.ims.lis.v2.resultcontainer+json",
} as const;

const HttpsUrl = z.url({ protocol: /^https$/ });
const Text = z.string().max(1024);

/**
 * A line item as the platform returns it. A stripping `z.object`: platforms add their own members
 * (Canvas adds `https://canvas.instructure.com/lti/submission_type`).
 */
export const LineItem = z.object({
  id: HttpsUrl,
  label: Text.min(1),
  scoreMaximum: z.number().positive().finite(),
  resourceLinkId: Text.optional(),
  resourceId: Text.optional(),
  tag: Text.optional(),
  startDateTime: z.string().optional(),
  endDateTime: z.string().optional(),
  gradesReleased: z.boolean().optional(),
});
/** A line item. */
export type LineItem = z.infer<typeof LineItem>;

/** A line item to create. */
export const NewLineItem = z.strictObject({
  label: Text.min(1),
  scoreMaximum: z.number().positive().finite(),
  /** The platform resource link the column belongs to. */
  resourceLinkId: Text.optional(),
  /** A SchoolOS identifier for the column, such as an activity ID. */
  resourceId: Text.optional(),
  tag: Text.optional(),
  startDateTime: z.iso.datetime({ offset: true }).optional(),
  endDateTime: z.iso.datetime({ offset: true }).optional(),
});
/** A new line item. */
export type NewLineItem = z.infer<typeof NewLineItem>;

/** Filters for {@link AgsClient.listLineItems}. */
export interface LineItemFilter {
  readonly resourceLinkId?: string;
  readonly resourceId?: string;
  readonly tag?: string;
}

/** A result (the platform's current grade for one user in one line item). A stripping `z.object`. */
export const AgsResult = z.object({
  id: HttpsUrl,
  scoreOf: HttpsUrl,
  userId: z.string().min(1).max(255),
  resultScore: z.number().finite().optional(),
  resultMaximum: z.number().positive().finite().optional(),
  comment: z.string().max(10_000).optional(),
});
/** An AGS result. */
export type AgsResult = z.infer<typeof AgsResult>;

/** The most pages of line items or results read. */
const MAX_PAGES = 50;
/** The most line items or results read. */
const MAX_ITEMS = 5_000;

/** What {@link AgsClient} is built from. */
export interface AgsClientOptions {
  readonly services: LtiServiceClient;
  readonly registrations: PlatformRegistrationStore;
}

/**
 * Assignment and Grade Services 2.0: line items and results in one context. Scores are not
 * published here; see {@link LtiAgsGradeSink}, which only the grade passback gate drives.
 */
export class AgsClient {
  readonly #services: LtiServiceClient;
  readonly #registrations: PlatformRegistrationStore;

  constructor(options: AgsClientOptions) {
    this.#services = options.services;
    this.#registrations = options.registrations;
  }

  /** The context's line items, optionally filtered. */
  async listLineItems(services: LtiContextServices, filter: LineItemFilter = {}): Promise<LineItem[]> {
    const context = await this.#context(services, [LTI_SCOPES.lineItem, LTI_SCOPES.lineItemReadonly]);
    const container = context.ags.lineItemsUrl ?? notOffered("line item container");
    const url = new URL(container);
    if (filter.resourceLinkId !== undefined) url.searchParams.set("resource_link_id", filter.resourceLinkId);
    if (filter.resourceId !== undefined) url.searchParams.set("resource_id", filter.resourceId);
    if (filter.tag !== undefined) url.searchParams.set("tag", filter.tag);
    return this.#readPages(context, url.toString(), AGS_MEDIA_TYPES.lineItemContainer, LineItem, (item) =>
      assertLineItemInContext(context.ags, item.id),
    );
  }

  /** One line item of the context. */
  async getLineItem(services: LtiContextServices, lineItemUrl: string): Promise<LineItem> {
    const context = await this.#context(services, [LTI_SCOPES.lineItem, LTI_SCOPES.lineItemReadonly]);
    assertLineItemInContext(context.ags, lineItemUrl);
    const response = await this.#call(context, lineItemUrl, { method: "GET", accept: AGS_MEDIA_TYPES.lineItem });
    const item = parseBody(LineItem, await bodyOf(response, "line item"), "line item");
    if (item.id !== lineItemUrl) throw invalid("The platform returned a different line item.");
    return item;
  }

  /** Creates a line item in the context. Requires the `lineitem` scope. */
  async createLineItem(services: LtiContextServices, input: NewLineItem): Promise<LineItem> {
    const lineItem = NewLineItem.parse(input);
    const context = await this.#context(services, [LTI_SCOPES.lineItem]);
    const container = context.ags.lineItemsUrl ?? notOffered("line item container");
    const response = await this.#call(context, container, {
      method: "POST",
      accept: AGS_MEDIA_TYPES.lineItem,
      contentType: AGS_MEDIA_TYPES.lineItem,
      body: JSON.stringify(lineItem),
    });
    const created = parseBody(LineItem, await bodyOf(response, "line item"), "line item");
    assertLineItemInContext(context.ags, created.id);
    return created;
  }

  /** The results of a line item, optionally for one platform user. Requires `result.readonly`. */
  async readResults(services: LtiContextServices, lineItemUrl: string, userId?: string): Promise<AgsResult[]> {
    const context = await this.#context(services, [LTI_SCOPES.resultReadonly]);
    assertLineItemInContext(context.ags, lineItemUrl);
    const url = serviceSubpath(lineItemUrl, "results");
    if (userId !== undefined) url.searchParams.set("user_id", userId);
    return this.#readPages(context, url.toString(), AGS_MEDIA_TYPES.resultContainer, AgsResult, (result) => {
      if (result.scoreOf !== lineItemUrl) throw invalid("The platform returned a result for another line item.");
      if (userId !== undefined && result.userId !== userId) throw invalid("The platform returned another user's result.");
    });
  }

  async #context(services: LtiContextServices, anyOf: readonly LtiScope[]): Promise<AgsContext> {
    const registration = await this.#registrations.get(services.registration);
    if (registration === undefined) throw new SchoolOsError("not-found", "No such LTI registration.");
    if (offeringForContext(registration, services.contextId) === undefined) {
      throw new SchoolOsError("forbidden", "This course is not connected to a SchoolOS offering.");
    }
    const ags = services.ags ?? notOffered("grade service");
    if (!anyOf.some((scope) => ags.scopes.includes(scope))) {
      throw new SchoolOsError("forbidden", "The platform does not grant SchoolOS this grade service in this course.");
    }
    return { registration, ags, scopes: grantedAgsScopes(ags.scopes) };
  }

  #call(context: AgsContext, url: string, init: Parameters<LtiServiceClient["call"]>[4]): Promise<Response> {
    return this.#services.call(context.registration, context.scopes, agsOrigin(context.ags), url, init);
  }

  async #readPages<T>(
    context: AgsContext,
    first: string,
    accept: string,
    schema: z.ZodType<T>,
    check: (item: T) => void,
  ): Promise<T[]> {
    const items: T[] = [];
    const visited = new Set<string>();
    let url: string | undefined = first;
    while (url !== undefined) {
      if (visited.has(url)) throw invalid("The platform's pages link back to an earlier page.");
      if (visited.size >= MAX_PAGES) throw invalid("The platform returned more pages than SchoolOS reads.");
      visited.add(url);
      const response = await this.#call(context, url, { method: "GET", accept });
      const page = parseBody(z.array(z.unknown()), await bodyOf(response, "page"), "page");
      for (const candidate of page) {
        const item = parseBody(schema, candidate, "item");
        check(item);
        if (items.length >= MAX_ITEMS) throw invalid("The platform returned more items than SchoolOS reads.");
        items.push(item);
      }
      url = nextPageUrl(response.headers.get("link"), url);
    }
    return items;
  }
}

/** A context's AGS claim, its registration, and the AGS scopes requested for its token. */
interface AgsContext {
  readonly registration: PlatformRegistration;
  readonly ags: NonNullable<LtiContextServices["ags"]>;
  readonly scopes: readonly LtiScope[];
}

/** The AGS scopes SchoolOS knows that the context grants: one token serves every AGS call. */
function grantedAgsScopes(granted: readonly string[]): LtiScope[] {
  return AGS_SCOPES.filter((scope) => granted.includes(scope));
}

function agsOrigin(ags: NonNullable<LtiContextServices["ags"]>): string {
  return serviceOrigin(ags.lineItemsUrl ?? ags.lineItemUrl ?? notOffered("grade service"));
}

/**
 * Throws `forbidden` unless `lineItemUrl` belongs to the context: inside its line item container
 * (same origin, path under the container's path), or exactly the launching link's line item when
 * the platform offered no container. This binds a line item to the offering the context maps to.
 */
export function assertLineItemInContext(ags: NonNullable<LtiContextServices["ags"]>, lineItemUrl: string): void {
  let item: URL;
  try {
    item = new URL(lineItemUrl);
  } catch {
    throw invalid("The line item URL is malformed.");
  }
  if (ags.lineItemUrl !== undefined && lineItemUrl === ags.lineItemUrl) return;
  if (ags.lineItemsUrl !== undefined) {
    const container = new URL(ags.lineItemsUrl);
    const prefix = container.pathname.replace(/\/$/, "") + "/";
    if (item.protocol === "https:" && item.origin === container.origin && item.pathname.startsWith(prefix)) return;
  }
  throw new SchoolOsError("forbidden", "The line item is not in this course's gradebook.");
}

/**
 * A line item's `scores` or `results` service URL: the segment goes on the path, before any query
 * string, as AGS 2.0 §3.4 requires.
 */
function serviceSubpath(lineItemUrl: string, segment: "scores" | "results"): URL {
  const url = new URL(lineItemUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${segment}`;
  return url;
}

/**
 * Publishes approved grades to an LTI platform's gradebook through AGS. It is a {@link GradeSink}:
 * the grade passback gate calls it only for a teacher-approved grade, in an offering whose grade
 * route names this platform, after claiming the grade version in the passback ledger.
 */
export class LtiAgsGradeSink implements GradeSink {
  readonly via = "lti-ags";
  readonly #services: LtiServiceClient;
  readonly #registrations: PlatformRegistrationStore;

  constructor(options: AgsClientOptions) {
    this.#services = options.services;
    this.#registrations = options.registrations;
  }

  async check(route: LmsGradeRoute, column: string, student: Principal): Promise<void> {
    await this.#target(routeOfKind(route, "lti-ags"), column, student);
  }

  async deliver(input: LmsGradeRoute, delivery: GradeDelivery, student: Principal): Promise<void> {
    const route = routeOfKind(input, "lti-ags");
    const { registration, userId, ags } = await this.#target(route, delivery.column, student);
    // An approved grade is final: the work is complete and fully graded. Progress-only updates
    // (`Started`, `Pending`) are never sent; SchoolOS does not narrate work in progress to the LMS.
    const score = {
      userId,
      scoreGiven: delivery.scoreGiven,
      scoreMaximum: delivery.scoreMaximum,
      activityProgress: "Completed",
      gradingProgress: "FullyGraded",
      // The approval time, not the send time: a retry carries the same timestamp, and a platform
      // drops a score older than the one it holds (AGS 2.0 §3.4.6), so a stale version cannot
      // overwrite a newer one even if two sends race.
      timestamp: delivery.approvedAt,
      ...(delivery.comment === undefined ? {} : { comment: delivery.comment }),
    };
    const response = await this.#services.call(
      registration,
      grantedAgsScopes(ags.scopes),
      agsOrigin(ags),
      serviceSubpath(delivery.column, "scores").toString(),
      { method: "POST", accept: "application/json", contentType: AGS_MEDIA_TYPES.score, body: JSON.stringify(score) },
    );
    if (!response.ok) throw new SchoolOsError("unavailable", `The platform refused the score (${response.status}).`);
  }

  async #target(route: LtiGradeRoute, column: string, student: Principal): Promise<LtiTarget> {
    const registration = await this.#registrations.get(route.services.registration);
    if (registration === undefined || !sameRegistration(registration, route.services.registration)) {
      throw new SchoolOsError("not-found", "No such LTI registration.");
    }
    if (registration.districtId !== student.districtId || offeringForContext(registration, route.services.contextId) !== route.offeringId) {
      throw new SchoolOsError("conflict", "The grade route's course is not connected to this offering.");
    }
    const ags = route.services.ags;
    if (ags === undefined || !ags.scopes.includes(LTI_SCOPES.score)) {
      throw new SchoolOsError("forbidden", "The platform does not let SchoolOS publish scores in this course.");
    }
    assertLineItemInContext(ags, column);
    const identity = student.externalIdentities.find(
      (link) => link.issuer === registration.issuer && link.districtId === registration.districtId,
    );
    if (identity === undefined) throw new SchoolOsError("not-found", "The student has no account on this platform.");
    return { registration, userId: identity.subject, ags };
  }
}

/** Where an LTI score goes: the registration, the student's platform user ID, the context's AGS claim. */
interface LtiTarget {
  readonly registration: PlatformRegistration;
  readonly userId: string;
  readonly ags: NonNullable<LtiContextServices["ags"]>;
}

async function bodyOf(response: Response, what: string): Promise<unknown> {
  if (!response.ok) throw new SchoolOsError("unavailable", `The platform refused the ${what} request (${response.status}).`);
  try {
    return await readJson(response);
  } catch {
    throw invalid(`The platform's ${what} is not readable JSON.`);
  }
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw invalid(`The platform's ${what} is malformed.`);
  return parsed.data;
}

const invalid = (message: string): SchoolOsError => new SchoolOsError("validation-failed", message);

const notOffered = (what: string): never => {
  throw new SchoolOsError("conflict", `The platform offers no ${what} in this course.`);
};
