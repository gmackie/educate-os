/**
 * The public school manifest, `<origin>/.well-known/educateos.json` (ADR-0014). Version 1 mirrors
 * `SchoolManifest` in packages/educateos-district-worker/src/school-manifest.ts. The phone reads it
 * to learn a school's name, brand and features from one address, so it is validated strictly: one
 * exact HTTPS origin that matches the address asked for, and no fields of the wrong shape.
 */
import { strictOrigin } from './security.ts';

/** The device API version (`/api/m/*`) this app speaks. */
export const MOBILE_API_VERSION = 1;
/**
 * The first device API version whose districts let a phone sign in in the system browser (no
 * computer needed) and register itself. A district offers it when its manifest also lists sign-in methods.
 */
export const PHONE_SIGN_IN_API_VERSION = 2;
export const MANIFEST_PATH = '/.well-known/educateos.json';
const MAX_BYTES = 64 * 1024;

export type SchoolManifest = {
  v: 1;
  name: string;
  origin: string;
  brand: { logo: string | null; accent: string | null };
  signIn: { id: string; label: string }[];
  features: { ai: boolean; mobile: boolean; family: boolean };
  mobileApi: { min: number; max: number };
  release: string | null;
};

export class ManifestError extends Error {
  constructor(message: string) { super(message); this.name = 'ManifestError'; }
}

const invalid = () => new ManifestError("This address didn't return a valid EducateOS school. Check it with your school.");
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keysWithin = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((k) => allowed.includes(k));

function httpsUrl(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 2048) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password) throw invalid();
  return url.href;
}

/** Validates a parsed manifest against the origin the phone asked. */
export function parseSchoolManifest(value: unknown, expectedOrigin: string): SchoolManifest {
  if (!isObject(value) || value.v !== 1) throw invalid();
  if (!keysWithin(value, ['v', 'name', 'origin', 'brand', 'signIn', 'features', 'mobileApi', 'release'])) throw invalid();
  const { name, origin, brand, signIn, features, mobileApi, release } = value;
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 200) throw invalid();
  let canonical: string;
  try { canonical = strictOrigin(String(origin)); } catch { throw invalid(); }
  if (canonical !== origin) throw invalid();
  if (canonical !== expectedOrigin) {
    throw new ManifestError('This school uses a different address: ' + canonical + '. Use that address instead.');
  }
  if (!isObject(brand) || !keysWithin(brand, ['logo', 'accent'])) throw invalid();
  const accent = brand.accent;
  if (accent !== null && (typeof accent !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(accent))) throw invalid();
  if (!Array.isArray(signIn) || signIn.length > 10) throw invalid();
  const methods = signIn.map((m) => {
    if (!isObject(m) || !keysWithin(m, ['id', 'label']) || typeof m.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(m.id) ||
        typeof m.label !== 'string' || m.label.trim().length < 1 || m.label.length > 60) throw invalid();
    return { id: m.id, label: m.label.trim() };
  });
  if (!isObject(features) || !keysWithin(features, ['ai', 'mobile', 'family']) ||
      typeof features.ai !== 'boolean' || typeof features.mobile !== 'boolean' || typeof features.family !== 'boolean') throw invalid();
  if (!isObject(mobileApi) || !keysWithin(mobileApi, ['min', 'max']) || !Number.isInteger(mobileApi.min) || !Number.isInteger(mobileApi.max) ||
      (mobileApi.min as number) < 1 || (mobileApi.max as number) < (mobileApi.min as number)) throw invalid();
  if (release !== null && (typeof release !== 'string' || release.length < 1 || release.length > 100)) throw invalid();
  return {
    v: 1, name: name.trim(), origin: canonical,
    brand: { logo: httpsUrl(brand.logo), accent: accent as string | null },
    signIn: methods,
    features: { ai: features.ai, mobile: features.mobile, family: features.family },
    mobileApi: { min: mobileApi.min as number, max: mobileApi.max as number },
    release: release as string | null,
  };
}

/** Whether this app and the district share a device API version. */
export function speaksMobileApi(manifest: SchoolManifest): boolean {
  return manifest.mobileApi.min <= MOBILE_API_VERSION && MOBILE_API_VERSION <= manifest.mobileApi.max;
}

/** Whether the district lets a phone sign in without a computer (manifest capability). */
export function supportsPhoneSignIn(manifest: SchoolManifest): boolean {
  return manifest.features.mobile && manifest.signIn.length > 0 && manifest.mobileApi.max >= PHONE_SIGN_IN_API_VERSION;
}

/** Fetches and validates a school's manifest. Never follows redirects. */
export async function fetchSchoolManifest(origin: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<SchoolManifest> {
  const expected = strictOrigin(origin);
  const fetchImpl = options.fetch ?? fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetchImpl(expected + MANIFEST_PATH, {
      method: 'GET', redirect: 'manual', signal: options.signal, headers: { accept: 'application/json' },
    });
  } catch {
    throw new ManifestError("We couldn't reach that school. Check the address and your internet connection.");
  }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400) || response.status === 404) {
    throw new ManifestError("This address isn't an EducateOS school yet. Check it with your school.");
  }
  if (!response.ok) throw new ManifestError('That school is unavailable right now. Try again in a moment.');
  const text = await response.text().catch(() => '');
  if (text.length === 0 || text.length > MAX_BYTES) throw invalid();
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw invalid(); }
  return parseSchoolManifest(value, expected);
}
