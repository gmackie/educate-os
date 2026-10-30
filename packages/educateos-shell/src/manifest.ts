// The public school manifest, `/.well-known/educateos.json` (the plan's §3, schema v1): the one
// file the phone, the admin console, the directory and this shell read to learn a district's name,
// branding and features. It is public and holds no personal data.
//
// Parsing is strict about what identifies the school (the version, name and origin: a manifest
// without them is refused) and lenient about the rest: a malformed logo, accent or sign-in entry
// is dropped on its own, so one bad field never takes the school's name off the page.

import { useSyncExternalStore } from "react";
import { isLocalHost } from "./navigation.ts";

/** Where every district serves its manifest. */
export const SCHOOL_MANIFEST_PATH = "/.well-known/educateos.json";

/** One way to sign in that the district offers. */
export interface SignInMethod {
  id: string;
  label: string;
}

/** A district's manifest, validated. */
export interface SchoolManifest {
  v: 1;
  name: string;
  /** The district's canonical origin, `https://<host>`. */
  origin: string;
  brand: {
    /** An https URL or a root-relative path on the district origin. */
    logo?: string;
    /** `#rgb` or `#rrggbb`. */
    accent?: string;
  };
  signIn: SignInMethod[];
  features: { ai: boolean; mobile: boolean; family: boolean };
  mobileApi?: { min: number; max: number };
  release?: string;
}

/** Why a document is not a usable manifest. */
export type ManifestProblem = "not-an-object" | "unsupported-version" | "missing-name" | "invalid-origin";

export type ManifestParse = { ok: true; manifest: SchoolManifest } | { ok: false; problem: ManifestProblem };

const MAX_NAME = 120;
const MAX_LABEL = 60;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SIGN_IN_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const RELEASE = /^[\w.-]{1,64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cleanText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  // Control characters never belong in a name shown on the page.
  const text = [...value].filter((char) => char.charCodeAt(0) > 0x1f && char !== "\u007f").join("").trim();
  return text === "" || text.length > max ? undefined : text;
};

/** The origin `value` names, if it is exactly an https origin (http only for a local host). */
const parseOrigin = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && isLocalHost(url.hostname));
  const bare = url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "";
  return secure && bare && value.replace(/\/$/, "") === url.origin ? url.origin : undefined;
};

/** A logo the page may load: https anywhere, or a root-relative path on the district origin. */
const parseLogo = (value: unknown, origin: string): string | undefined => {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && url.origin === origin)) return url.href;
  return undefined;
};

const parseSignIn = (value: unknown): SignInMethod[] => {
  if (!Array.isArray(value)) return [];
  const methods: SignInMethod[] = [];
  for (const entry of value.slice(0, 20)) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" && SIGN_IN_ID.test(entry.id) ? entry.id : undefined;
    const label = cleanText(entry.label, MAX_LABEL);
    if (id !== undefined && label !== undefined && !methods.some((method) => method.id === id)) methods.push({ id, label });
  }
  return methods;
};

const parseMobileApi = (value: unknown): SchoolManifest["mobileApi"] => {
  if (!isRecord(value)) return undefined;
  const { min, max } = value;
  return Number.isSafeInteger(min) && Number.isSafeInteger(max) && (min as number) >= 1 && (min as number) <= (max as number)
    ? { min: min as number, max: max as number }
    : undefined;
};

/** Validates a manifest document (already JSON-parsed). */
export const parseSchoolManifest = (value: unknown): ManifestParse => {
  if (!isRecord(value)) return { ok: false, problem: "not-an-object" };
  if (value.v !== 1) return { ok: false, problem: "unsupported-version" };
  const name = cleanText(value.name, MAX_NAME);
  if (name === undefined) return { ok: false, problem: "missing-name" };
  const origin = parseOrigin(value.origin);
  if (origin === undefined) return { ok: false, problem: "invalid-origin" };

  const brand = isRecord(value.brand) ? value.brand : {};
  const logo = parseLogo(brand.logo, origin);
  const accent = typeof brand.accent === "string" && HEX_COLOR.test(brand.accent) ? brand.accent : undefined;
  const features = isRecord(value.features) ? value.features : {};
  const mobileApi = parseMobileApi(value.mobileApi);
  const release = typeof value.release === "string" && RELEASE.test(value.release) ? value.release : undefined;

  return {
    ok: true,
    manifest: {
      v: 1,
      name,
      origin,
      brand: { ...(logo === undefined ? {} : { logo }), ...(accent === undefined ? {} : { accent }) },
      signIn: parseSignIn(value.signIn),
      // Each feature is on only when the district says so: an absent or malformed flag is off.
      features: { ai: features.ai === true, mobile: features.mobile === true, family: features.family === true },
      ...(mobileApi === undefined ? {} : { mobileApi }),
      ...(release === undefined ? {} : { release }),
    },
  };
};

/**
 * What the shell shows when there is no usable manifest: the product's name, the page's own origin
 * and every optional feature off, so nothing is offered that the district may not have.
 */
export const fallbackSchoolManifest = (origin: string): SchoolManifest => ({
  v: 1,
  name: "EducateOS",
  origin,
  brand: {},
  signIn: [],
  features: { ai: false, mobile: false, family: false },
});

/** The state of the manifest for the page. */
export type SchoolManifestState =
  | { status: "loading"; manifest: SchoolManifest }
  | { status: "ready"; manifest: SchoolManifest }
  /** No usable manifest (missing, refused, malformed, offline): `manifest` is the fallback. */
  | { status: "fallback"; manifest: SchoolManifest; problem: ManifestProblem | "unavailable" };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Fetches and validates the manifest at `url`. Never throws: anything short of a valid manifest is
 * the fallback. Redirects are not followed: on a district host the only redirect is Cloudflare
 * Access sending a signed-out browser to its login, and that is not the school's manifest.
 */
export const loadSchoolManifest = async (
  url: string = SCHOOL_MANIFEST_PATH,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  origin: string = globalThis.location?.origin ?? "",
): Promise<Exclude<SchoolManifestState, { status: "loading" }>> => {
  const fallback = fallbackSchoolManifest(origin);
  try {
    const response = await fetchImpl(url, { redirect: "manual", credentials: "same-origin", headers: { accept: "application/json" } });
    if (!response.ok) return { status: "fallback", manifest: fallback, problem: "unavailable" };
    const parsed = parseSchoolManifest(await response.json());
    return parsed.ok ? { status: "ready", manifest: parsed.manifest } : { status: "fallback", manifest: fallback, problem: parsed.problem };
  } catch {
    return { status: "fallback", manifest: fallback, problem: "unavailable" };
  }
};

// One fetch per page and URL, shared by every component that asks. The manifest changes only with
// a release or a settings change, so a page keeps the copy it loaded.
interface CacheEntry {
  state: SchoolManifestState;
  listeners: Set<() => void>;
}
const cache = new Map<string, CacheEntry>();

const entryFor = (url: string, fetchImpl: FetchLike | undefined): CacheEntry => {
  const existing = cache.get(url);
  if (existing !== undefined) return existing;
  const origin = globalThis.location?.origin ?? "";
  const entry: CacheEntry = { state: { status: "loading", manifest: fallbackSchoolManifest(origin) }, listeners: new Set() };
  cache.set(url, entry);
  void loadSchoolManifest(url, fetchImpl, origin).then((state) => {
    entry.state = state;
    for (const listener of entry.listeners) listener();
  });
  return entry;
};

/** Forgets every loaded manifest, so the next reader fetches again. For tests and settings changes. */
export const resetSchoolManifestCache = (): void => cache.clear();

/**
 * The district's manifest, fetched once per page and shared. Starts `loading` with the fallback in
 * place, so the frame renders straight away and takes on the school's branding when it arrives.
 */
export const useSchoolManifest = (options: { url?: string; fetch?: FetchLike } = {}): SchoolManifestState => {
  const url = options.url ?? SCHOOL_MANIFEST_PATH;
  const entry = entryFor(url, options.fetch);
  return useSyncExternalStore(
    (listener) => {
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    () => entry.state,
    () => entry.state,
  );
};
