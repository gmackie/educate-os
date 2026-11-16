// Product analytics on the district origin (SCHO-350): the student-safe way every district app
// loads the district's analytics service (Dataflare, DATFLR-7), and only when it may.
//
// Nothing here runs until all four of these hold, in this order:
//
// 1. the deployment names a service and a district administrator turned it on, which the signed-in
//    route `GET /api/me/product-analytics` reports (never the public school manifest);
// 2. the signed-in person's role is known, so nothing is sent before sign-in;
// 3. the browser sends neither Do Not Track nor Global Privacy Control;
// 4. no earlier call on this page has already loaded it.
//
// Then the SDK's script is fetched from the service and initialized in one mode for every role
// (DATFLR-2 decides any other): cookieless, so nothing is stored on the device; no `identify()`,
// so no user id; no replay; no autocaptured clicks, errors or vitals; no feature flags. Only page
// views are sent, each rewritten to the app (`surface`) and a screen category: no entity ids,
// query strings, fragments, titles or referrers, and no properties but `role` and `surface`.
import { shellRoleOf, type ShellPrincipal, type ShellRole } from "./navigation.ts";

/** Which district app a page belongs to, and where it is served on the district origin. */
export const PRODUCT_ANALYTICS_SURFACES = {
  lms: "/",
  teach: "/teach/",
  admin: "/admin/",
  ai: "/ai/",
} as const;
/** A district app. */
export type ProductAnalyticsSurface = keyof typeof PRODUCT_ANALYTICS_SURFACES;

/** What `GET /api/me/product-analytics` answers: off, or where to send events. */
export type ProductAnalyticsConfig = { enabled: false } | { enabled: true; host: string; project: string };

/** Where an app learns whether analytics is on, and who is signed in. */
export interface ProductAnalyticsSource {
  /** The signed-in person's analytics configuration (`me.productAnalytics`). */
  config(): Promise<ProductAnalyticsConfig>;
  /** The signed-in person's role, or `undefined` when no one is signed in. */
  role(): Promise<ShellRole | undefined>;
}

/**
 * A source from an app's district API calls: `me.productAnalytics` and `me.get`, through the app's
 * own client so a development sign-in token is used as for every other call.
 */
export const productAnalyticsSourceFrom = (calls: {
  productAnalytics(): Promise<ProductAnalyticsConfig>;
  me(): Promise<ShellPrincipal>;
}): ProductAnalyticsSource => ({
  config: () => calls.productAnalytics(),
  role: async () => shellRoleOf(await calls.me()),
});

const HTTPS_ORIGIN = /^https:\/\/[^/?#]+$/;

const parseConfig = (value: unknown): ProductAnalyticsConfig => {
  if (typeof value !== "object" || value === null) return { enabled: false };
  const { enabled, host, project } = value as Record<string, unknown>;
  if (enabled !== true || typeof host !== "string" || !HTTPS_ORIGIN.test(host) || typeof project !== "string" || project === "") return { enabled: false };
  return { enabled: true, host, project };
};

const parsePrincipal = (value: unknown): ShellPrincipal | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { kind, roles } = value as Record<string, unknown>;
  if (kind !== "student" && kind !== "staff" && kind !== "guardian" && kind !== "service") return undefined;
  if (!Array.isArray(roles)) return undefined;
  return { kind, roles: roles.filter((r): r is { role: string } => typeof r === "object" && r !== null && typeof (r as { role?: unknown }).role === "string") };
};

/**
 * A source over same-origin `fetch`, for an app without a district API client (the Workshop at
 * `/ai`, signed in by the district's Access session). Anything but a well-formed answer is off.
 */
export const sameOriginProductAnalyticsSource = (fetchImpl: typeof fetch = (input, init) => fetch(input, init)): ProductAnalyticsSource => {
  const get = async (path: string): Promise<unknown> => {
    const response = await fetchImpl(path, { credentials: "same-origin", redirect: "manual", headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    return response.json();
  };
  return {
    config: async () => parseConfig(await get("/api/me/product-analytics")),
    role: async () => {
      const principal = parsePrincipal(await get("/api/me"));
      return principal === undefined ? undefined : shellRoleOf(principal);
    },
  };
};

/** One event as the SDK queues it (`WireEvent` in Dataflare's web SDK). */
export interface ProductAnalyticsWireEvent {
  id: string;
  event: string;
  ts: number;
  distinct_id?: string | null;
  user_id?: string | null;
  session_id?: string | null;
  url?: string | null;
  referrer?: string | null;
  title?: string | null;
  props?: Record<string, unknown>;
  flags?: Record<string, string>;
}

/** The part of the SDK this module uses: `window.glass` once its script loads. */
interface GlassGlobal {
  init(options: Record<string, unknown>): void;
}

/** What this module reads from the browser: globals, injectable for tests. */
export interface ProductAnalyticsBrowser {
  document: Pick<Document, "createElement" | "head">;
  location: Pick<Location, "origin" | "pathname">;
  navigator: { doNotTrack?: string | null; globalPrivacyControl?: boolean };
  window: { doNotTrack?: string | null; glass?: unknown; __educateosProductAnalytics?: true };
}

/** Whether the browser asks not to be tracked: Do Not Track or Global Privacy Control. */
export const browserOptsOut = (browser: Pick<ProductAnalyticsBrowser, "navigator" | "window">): boolean =>
  browser.window.doNotTrack === "1" || browser.navigator.doNotTrack === "1" || browser.navigator.globalPrivacyControl === true;

// A path segment that names a screen: lowercase words and hyphens only. An id (`off_nf-eng9`,
// a UUID, a number) or anything else becomes `other`, so no record is ever named.
const SCREEN = /^[a-z]+(?:-[a-z]+)*$/;
const MAX_SCREEN = 32;

/** The screen category of a path on a surface: its first segment below the app, or `home`. */
export const productAnalyticsScreen = (surface: ProductAnalyticsSurface, pathname: string): string => {
  const base = PRODUCT_ANALYTICS_SURFACES[surface];
  const below = pathname.startsWith(base) ? pathname.slice(base.length) : pathname.replace(/^\//, "");
  const first = below.split("/").find((segment) => segment !== "");
  if (first === undefined) return "home";
  return first.length <= MAX_SCREEN && SCREEN.test(first) ? first : "other";
};

/**
 * Rewrites an event before the SDK queues it, or drops it (`null`): only page views leave, as the
 * app and screen category, with the role and surface and nothing else.
 */
export const productAnalyticsEvent = (
  event: ProductAnalyticsWireEvent,
  context: { surface: ProductAnalyticsSurface; role: ShellRole; location: Pick<Location, "origin" | "pathname"> },
): ProductAnalyticsWireEvent | null => {
  if (event.event !== "$pageview") return null;
  const screen = productAnalyticsScreen(context.surface, context.location.pathname);
  return {
    id: event.id,
    event: event.event,
    ts: event.ts,
    distinct_id: event.distinct_id ?? null,
    user_id: null,
    session_id: event.session_id ?? null,
    url: `${context.location.origin}/${context.surface}/${screen}`,
    referrer: null,
    title: null,
    props: { role: context.role, surface: context.surface },
  };
};

/** The SDK options every district page uses. Exported so the mode is tested, not assumed. */
export const productAnalyticsOptions = (
  config: Extract<ProductAnalyticsConfig, { enabled: true }>,
  context: { surface: ProductAnalyticsSurface; role: ShellRole; location: Pick<Location, "origin" | "pathname"> },
): Record<string, unknown> => ({
  host: config.host,
  project: config.project,
  persistence: "cookieless",
  autocapture: { pageviews: true, clicks: false, errors: false, webVitals: false },
  flags: false,
  replay: false,
  beforeSend: (event: ProductAnalyticsWireEvent) => productAnalyticsEvent(event, context),
});

/** Why `startProductAnalytics` loaded nothing, or that it did. */
export type ProductAnalyticsOutcome = "off" | "signed-out" | "opted-out" | "already-started" | "started";

/**
 * Loads and initializes the SDK if everything allows it; otherwise does nothing and says why. The
 * script is the service's own `s.js`, added without `data-project` so it initializes only here.
 */
export const startProductAnalytics = (
  config: ProductAnalyticsConfig,
  role: ShellRole | undefined,
  surface: ProductAnalyticsSurface,
  browser: ProductAnalyticsBrowser,
): ProductAnalyticsOutcome => {
  if (!config.enabled) return "off";
  if (role === undefined) return "signed-out";
  if (browserOptsOut(browser)) return "opted-out";
  if (browser.window.__educateosProductAnalytics === true) return "already-started";
  browser.window.__educateosProductAnalytics = true;

  const script = browser.document.createElement("script");
  script.src = `${config.host}/s.js`;
  script.async = true;
  script.referrerPolicy = "no-referrer";
  script.addEventListener("load", () => {
    const glass = browser.window.glass as Partial<GlassGlobal> | undefined;
    if (typeof glass?.init !== "function") return;
    glass.init(productAnalyticsOptions(config, { surface, role, location: browser.location }));
  });
  browser.document.head.append(script);
  return "started";
};

/** The real browser, for `startProductAnalytics` outside tests. */
export const currentBrowser = (): ProductAnalyticsBrowser => ({
  document,
  location: window.location,
  navigator: navigator as ProductAnalyticsBrowser["navigator"],
  window: window as unknown as ProductAnalyticsBrowser["window"],
});
