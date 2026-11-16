import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  productAnalyticsEvent,
  productAnalyticsOptions,
  productAnalyticsScreen,
  productAnalyticsSourceFrom,
  sameOriginProductAnalyticsSource,
  startProductAnalytics,
  type ProductAnalyticsBrowser,
  type ProductAnalyticsConfig,
  type ProductAnalyticsSource,
  type ProductAnalyticsWireEvent,
} from "./productAnalytics.ts";
import { useProductAnalytics } from "./useProductAnalytics.ts";

const ON: ProductAnalyticsConfig = { enabled: true, host: "https://glass-educateos-district.educateos-demo.workers.dev", project: "educateos-district" };
const ORIGIN = "https://harbor.educateos.io";

/** A browser over its own document, so no test touches the real page's globals. */
const fakeBrowser = (pathname = "/", opts: Partial<ProductAnalyticsBrowser["navigator"]> & { windowDnt?: string } = {}): ProductAnalyticsBrowser => {
  const doc = document.implementation.createHTMLDocument("district");
  const { windowDnt, ...nav } = opts;
  return {
    document: doc,
    location: { origin: ORIGIN, pathname },
    navigator: nav,
    window: windowDnt === undefined ? {} : { doNotTrack: windowDnt },
  };
};

const scripts = (browser: ProductAnalyticsBrowser) => [...(browser.document.head as HTMLElement).querySelectorAll("script")];

const pageview = (overrides: Partial<ProductAnalyticsWireEvent> = {}): ProductAnalyticsWireEvent => ({
  id: "evt-1",
  event: "$pageview",
  ts: 1_794_000_000_000,
  distinct_id: null,
  session_id: "s-1",
  url: `${ORIGIN}/teach/offerings/off_nf-eng9-fall-p3?tab=grades#student-amara`,
  referrer: `${ORIGIN}/teach/roster?search=amara`,
  title: "Amara Okafor: English 9",
  props: { offeringId: "off_nf-eng9-fall-p3" },
  flags: { beta: "on" },
  ...overrides,
});

describe("screen categories", () => {
  it("names a screen by its first segment below the app, and never a record", () => {
    expect(productAnalyticsScreen("lms", "/")).toBe("home");
    expect(productAnalyticsScreen("lms", "/assignments/asg_nf-essay-1")).toBe("assignments");
    expect(productAnalyticsScreen("teach", "/teach/")).toBe("home");
    expect(productAnalyticsScreen("teach", "/teach/gradebook/off_nf-bio")).toBe("gradebook");
    expect(productAnalyticsScreen("admin", "/admin/course-library")).toBe("course-library");
    expect(productAnalyticsScreen("ai", "/ai/w/3f2a9c1e-6b0d-4f7e-9d3a-2a1b0c9d8e7f")).toBe("w");
    // Ids, numbers, mixed case and long segments are never echoed.
    expect(productAnalyticsScreen("teach", "/teach/off_nf-eng9-fall-p3")).toBe("other");
    expect(productAnalyticsScreen("lms", "/3f2a9c1e-6b0d-4f7e-9d3a-2a1b0c9d8e7f")).toBe("other");
    expect(productAnalyticsScreen("lms", "/2026")).toBe("other");
    expect(productAnalyticsScreen("lms", "/Amara")).toBe("other");
    expect(productAnalyticsScreen("lms", `/${"a".repeat(33)}`)).toBe("other");
  });
});

describe("what an event may carry", () => {
  const context = { surface: "teach" as const, role: "teacher" as const, location: { origin: ORIGIN, pathname: "/teach/offerings/off_nf-eng9-fall-p3" } };

  it("sends a page view as the app and screen, with only the role and surface", () => {
    expect(productAnalyticsEvent(pageview(), context)).toStrictEqual({
      id: "evt-1",
      event: "$pageview",
      ts: 1_794_000_000_000,
      distinct_id: null,
      user_id: null,
      session_id: "s-1",
      url: `${ORIGIN}/teach/offerings`,
      referrer: null,
      title: null,
      props: { role: "teacher", surface: "teach" },
    });
  });

  it("drops everything else, and never sends a user id", () => {
    for (const event of ["$click", "$exception", "$web_vitals", "$identify", "assignment_opened"]) {
      expect(productAnalyticsEvent(pageview({ event }), context), event).toBeNull();
    }
    expect(productAnalyticsEvent(pageview({ user_id: "prn_nf-teacher-rivera" }), context)?.user_id).toBeNull();
  });

  it("runs the SDK cookieless, with page views only: no replay, flags, clicks, errors or vitals", () => {
    const options = productAnalyticsOptions(ON as Extract<ProductAnalyticsConfig, { enabled: true }>, context);
    const { beforeSend, ...rest } = options;
    expect(rest).toStrictEqual({
      host: ON.host,
      project: "educateos-district",
      persistence: "cookieless",
      autocapture: { pageviews: true, clicks: false, errors: false, webVitals: false },
      flags: false,
      replay: false,
    });
    expect((beforeSend as (e: ProductAnalyticsWireEvent) => unknown)(pageview({ event: "$click" }))).toBeNull();
  });
});

describe("starting", () => {
  it("loads nothing while analytics is off or no one is signed in", () => {
    const browser = fakeBrowser();
    expect(startProductAnalytics({ enabled: false }, "student", "lms", browser)).toBe("off");
    expect(startProductAnalytics(ON, undefined, "lms", browser)).toBe("signed-out");
    expect(scripts(browser)).toHaveLength(0);
  });

  it("loads nothing when the browser sends Do Not Track or Global Privacy Control", () => {
    for (const browser of [fakeBrowser("/", { doNotTrack: "1" }), fakeBrowser("/", { globalPrivacyControl: true }), fakeBrowser("/", { windowDnt: "1" })]) {
      expect(startProductAnalytics(ON, "student", "lms", browser)).toBe("opted-out");
      expect(scripts(browser)).toHaveLength(0);
    }
    // "0" and "unspecified" are not a request.
    expect(startProductAnalytics(ON, "student", "lms", fakeBrowser("/", { doNotTrack: "0" }))).toBe("started");
  });

  it("loads the service's script once, uninitialized, then initializes it in student-safe mode", () => {
    const browser = fakeBrowser("/assignments");
    expect(startProductAnalytics(ON, "student", "lms", browser)).toBe("started");
    expect(startProductAnalytics(ON, "student", "lms", browser)).toBe("already-started");
    const [script, ...others] = scripts(browser);
    expect(others).toHaveLength(0);
    expect(script!.src).toBe(`${ON.host}/s.js`);
    // Without data-project the script's own bootstrap does not initialize it.
    expect(script!.dataset.project).toBeUndefined();
    expect(script!.referrerPolicy).toBe("no-referrer");

    const init = vi.fn();
    browser.window.glass = { init };
    script!.dispatchEvent(new Event("load"));
    expect(init).toHaveBeenCalledOnce();
    const options = init.mock.calls[0]![0] as Record<string, unknown>;
    expect(options).toMatchObject({ host: ON.host, project: ON.project, persistence: "cookieless", replay: false, flags: false });
    expect((options.beforeSend as (e: ProductAnalyticsWireEvent) => ProductAnalyticsWireEvent | null)(pageview())).toMatchObject({
      url: `${ORIGIN}/lms/assignments`,
      props: { role: "student", surface: "lms" },
    });
  });
});

describe("sources", () => {
  const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });

  it("reads the role from me.get through the app's own client", async () => {
    const source = productAnalyticsSourceFrom({
      productAnalytics: async () => ON,
      me: async () => ({ kind: "staff", roles: [{ role: "district-admin" }] }),
    });
    expect(await source.config()).toStrictEqual(ON);
    expect(await source.role()).toBe("school-admin");
  });

  it("over same-origin fetch, treats anything but a well-formed answer as off", async () => {
    const answers: Record<string, Response> = {
      "/api/me/product-analytics": json({ enabled: true, host: "http://insecure.example", project: "p" }),
      "/api/me": json({ kind: "student", roles: [] }),
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe("same-origin");
      return answers[String(input)]!;
    }) as unknown as typeof fetch;
    const source = sameOriginProductAnalyticsSource(fetchImpl);
    expect(await source.config()).toStrictEqual({ enabled: false });
    expect(await source.role()).toBe("student");

    answers["/api/me/product-analytics"] = json({ enabled: true, host: ON.host, project: ON.project });
    expect(await source.config()).toStrictEqual(ON);
    answers["/api/me"] = json({ error: { code: "unauthenticated" } }, { status: 401 });
    await expect(source.role()).rejects.toThrow("401");
  });
});

describe("useProductAnalytics", () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };

  const Probe = ({ source, browser }: { source: ProductAnalyticsSource; browser: ProductAnalyticsBrowser }) => {
    useProductAnalytics(source, "lms", browser);
    return null;
  };

  it("starts once the source says it may", async () => {
    const browser = fakeBrowser();
    const source: ProductAnalyticsSource = { config: async () => ON, role: async () => "guardian" };
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe source={source} browser={browser} />));
    expect(scripts(browser)).toHaveLength(1);
    act(() => root.unmount());
  });

  it("starts nothing if the page leaves before the source answers, or the source fails", async () => {
    const browser = fakeBrowser();
    const config = deferred<ProductAnalyticsConfig>();
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe source={{ config: () => config.promise, role: async () => "student" }} browser={browser} />));
    act(() => root.unmount());
    await act(async () => config.resolve(ON));
    expect(scripts(browser)).toHaveLength(0);

    const failing = createRoot(document.createElement("div"));
    await act(async () => failing.render(<Probe source={{ config: async () => ON, role: async () => { throw new Error("401"); } }} browser={browser} />));
    expect(scripts(browser)).toHaveLength(0);
    act(() => failing.unmount());
  });
});
