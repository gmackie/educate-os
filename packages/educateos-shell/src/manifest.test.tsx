import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SCHOOL_MANIFEST_PATH,
  fallbackSchoolManifest,
  loadSchoolManifest,
  parseSchoolManifest,
  resetSchoolManifestCache,
  useSchoolManifest,
  type SchoolManifestState,
} from "./manifest.ts";

/** The plan's example manifest (§3). */
const NORTHFIELD = {
  v: 1,
  name: "Northfield Public Schools",
  origin: "https://northfield.educateos.io",
  brand: { logo: "https://northfield.educateos.io/brand/logo.svg", accent: "#2458ac" },
  signIn: [{ id: "google", label: "Google" }, { id: "clever", label: "Clever" }],
  features: { ai: true, mobile: true, family: true },
  mobileApi: { min: 1, max: 1 },
  release: "r000042-ade9299",
};

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });

/** The brand a manifest keeps once `brand` is parsed. */
const parsedBrand = (brand: unknown) => {
  const result = parseSchoolManifest({ ...NORTHFIELD, brand });
  if (!result.ok) throw new Error(result.problem);
  return result.manifest.brand;
};

describe("parseSchoolManifest", () => {
  it("accepts the v1 manifest as published", () => {
    expect(parseSchoolManifest(NORTHFIELD)).toEqual({ ok: true, manifest: NORTHFIELD });
  });

  it("refuses a document that does not identify a school", () => {
    expect(parseSchoolManifest(null)).toEqual({ ok: false, problem: "not-an-object" });
    expect(parseSchoolManifest([NORTHFIELD])).toEqual({ ok: false, problem: "not-an-object" });
    expect(parseSchoolManifest({ ...NORTHFIELD, v: 2 })).toEqual({ ok: false, problem: "unsupported-version" });
    expect(parseSchoolManifest({ ...NORTHFIELD, name: "  " })).toEqual({ ok: false, problem: "missing-name" });
    expect(parseSchoolManifest({ ...NORTHFIELD, name: "x".repeat(121) })).toEqual({ ok: false, problem: "missing-name" });
  });

  it.each([
    "http://northfield.educateos.io",
    "https://northfield.educateos.io/lms",
    "https://user@northfield.educateos.io",
    "https://northfield.educateos.io?x=1",
    "javascript:alert(1)",
    "northfield.educateos.io",
    42,
  ])("refuses the origin %s", (origin) => {
    expect(parseSchoolManifest({ ...NORTHFIELD, origin })).toEqual({ ok: false, problem: "invalid-origin" });
  });

  it("accepts a trailing slash on the origin, and plain http only on a local host", () => {
    expect(parseSchoolManifest({ ...NORTHFIELD, origin: "https://northfield.educateos.io/" })).toMatchObject({ ok: true, manifest: { origin: "https://northfield.educateos.io" } });
    expect(parseSchoolManifest({ ...NORTHFIELD, origin: "http://localhost:4801" })).toMatchObject({ ok: true, manifest: { origin: "http://localhost:4801" } });
  });

  it("drops a malformed logo or accent on its own, keeping the school", () => {
    expect(parsedBrand({ logo: "javascript:alert(1)", accent: "red" })).toEqual({});
    expect(parsedBrand({ logo: "data:image/svg+xml,<svg/>", accent: "#12345" })).toEqual({});
    expect(parsedBrand({ logo: "//evil.example/logo.svg" })).toEqual({});
    expect(parsedBrand({ logo: "http://cdn.example/logo.png" })).toEqual({});
    expect(parsedBrand({ logo: "/brand/logo.svg", accent: "#abc" })).toEqual({ logo: "/brand/logo.svg", accent: "#abc" });
    expect(parsedBrand("not an object")).toEqual({});
  });

  it("keeps only well-formed sign-in methods and turns absent or malformed features off", () => {
    const result = parseSchoolManifest({
      ...NORTHFIELD,
      signIn: [{ id: "google", label: "Google" }, { id: "Bad Id", label: "x" }, { id: "google", label: "Again" }, "clever", { id: "classlink", label: "\u0007ClassLink " }],
      features: { ai: "yes", mobile: true },
      mobileApi: { min: 2, max: 1 },
      release: "<script>",
    });
    expect(result).toEqual({
      ok: true,
      manifest: {
        v: 1,
        name: NORTHFIELD.name,
        origin: NORTHFIELD.origin,
        brand: NORTHFIELD.brand,
        signIn: [{ id: "google", label: "Google" }, { id: "classlink", label: "ClassLink" }],
        features: { ai: false, mobile: true, family: false },
      },
    });
  });
});

describe("loadSchoolManifest", () => {
  const origin = "https://northfield.educateos.io";

  it("fetches the well-known path without following redirects", async () => {
    const fetch = vi.fn(async () => json(NORTHFIELD));
    await expect(loadSchoolManifest(undefined, fetch, origin)).resolves.toEqual({ status: "ready", manifest: NORTHFIELD });
    expect(fetch).toHaveBeenCalledWith(SCHOOL_MANIFEST_PATH, expect.objectContaining({ redirect: "manual", credentials: "same-origin" }));
  });

  it("falls back, with every feature off, when the manifest is missing, refused, malformed or unreachable", async () => {
    const fallback = fallbackSchoolManifest(origin);
    expect(fallback.features).toEqual({ ai: false, mobile: false, family: false });
    await expect(loadSchoolManifest(undefined, async () => json({}, { status: 404 }), origin)).resolves.toEqual({ status: "fallback", manifest: fallback, problem: "unavailable" });
    // What `redirect: "manual"` gives a browser when Access answers with its login redirect.
    await expect(loadSchoolManifest(undefined, async () => new Response(null, { status: 302, headers: { location: "/cdn-cgi/access/login" } }), origin)).resolves.toMatchObject({ status: "fallback" });
    await expect(loadSchoolManifest(undefined, async () => new Response("<html>", { status: 200 }), origin)).resolves.toMatchObject({ status: "fallback", problem: "unavailable" });
    await expect(loadSchoolManifest(undefined, async () => json({ ...NORTHFIELD, v: 9 }), origin)).resolves.toMatchObject({ status: "fallback", problem: "unsupported-version" });
    await expect(loadSchoolManifest(undefined, async () => { throw new TypeError("offline"); }, origin)).resolves.toMatchObject({ status: "fallback", problem: "unavailable" });
  });
});

describe("useSchoolManifest", () => {
  afterEach(() => resetSchoolManifestCache());

  it("starts on the fallback, takes on the manifest when it arrives, and fetches once for every reader", async () => {
    let release!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const seen: SchoolManifestState[] = [];
    const Probe = () => {
      const state = useSchoolManifest({ fetch });
      seen.push(state);
      return <p>{state.manifest.name}</p>;
    };
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await act(async () => root.render(<><Probe /><Probe /></>));
    expect(container.textContent).toBe("EducateOSEducateOS");
    expect(seen[0]?.status).toBe("loading");

    await act(async () => release(json(NORTHFIELD)));
    expect(container.textContent).toBe(`${NORTHFIELD.name}${NORTHFIELD.name}`);
    expect(fetch).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    container.remove();
  });
});
