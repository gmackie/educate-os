/**
 * Saved schools. Since the one-origin redesign a school is one origin: its LMS at `/`, the district
 * API at `/api` and the AI workspace at `/ai/`. Schools saved by earlier builds had two addresses
 * (portal + Workshop) and are migrated when the list is read.
 */
import type { District } from './types.ts';
import type { SchoolManifest } from './manifest.ts';
import { strictOrigin } from './security.ts';

export const MAX_SCHOOLS = 30;

export function districtFromManifest(manifest: SchoolManifest): District {
  return {
    id: manifest.origin, name: manifest.name.slice(0, 90), origin: manifest.origin,
    workshop: manifest.origin + '/ai/', brand: manifest.brand, features: manifest.features,
  };
}

/** The origin the AI workspace is served from (the school's own, or a legacy Workshop host). */
export function workspaceOrigin(district: Pick<District, 'workshop'>): string {
  return new URL(district.workshop).origin;
}

function workshopUrl(value: unknown, origin: string): string {
  if (typeof value !== 'string') throw new Error('workshop');
  const url = new URL(value);
  if (url.protocol !== 'https:' && !url.origin.startsWith('http://localhost:')) throw new Error('workshop');
  if (url.username || url.password || url.search || url.hash) throw new Error('workshop');
  // A legacy Workshop origin keeps its own host; anything else must live on the school's origin.
  if (url.origin !== origin && url.pathname !== '/') throw new Error('workshop');
  return url.href;
}

/**
 * One stored entry, in either format. Legacy `{portal, workshop}` entries become one origin (the
 * portal); a Workshop on that same origin moves to `/ai/`, and a separate Workshop host is kept.
 * The legacy `id` is kept because it keys the entry's stored sign-in.
 */
export function migrateDistrict(raw: unknown): District | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  try {
    if (typeof d.name !== 'string' || d.name.trim().length < 2 || typeof d.id !== 'string') return null;
    const name = d.name.trim().slice(0, 90);
    if (typeof d.origin === 'string') {
      const origin = strictOrigin(d.origin);
      if (origin !== d.origin) return null;
      const district: District = { id: d.id, name, origin, workshop: workshopUrl(d.workshop, origin) };
      if (d.legacy === true) district.legacy = true;
      const brand = d.brand as District['brand'] | undefined;
      if (brand && (brand.accent === null || /^#[0-9a-fA-F]{6}$/.test(String(brand.accent))) &&
          (brand.logo === null || (typeof brand.logo === 'string' && brand.logo.startsWith('https://')))) {
        district.brand = { accent: brand.accent, logo: brand.logo };
      }
      const f = d.features as District['features'] | undefined;
      if (f && typeof f.ai === 'boolean' && typeof f.mobile === 'boolean' && typeof f.family === 'boolean') {
        district.features = { ai: f.ai, mobile: f.mobile, family: f.family };
      }
      return district;
    }
    if (typeof d.portal !== 'string' || typeof d.workshop !== 'string') return null;
    const portal = strictOrigin(d.portal), workshop = strictOrigin(d.workshop);
    if (portal !== d.portal || workshop !== d.workshop || d.id !== workshop + '|' + portal) return null;
    return {
      id: d.id, name, origin: portal, legacy: true,
      workshop: workshop === portal ? portal + '/ai/' : workshop + '/',
    };
  } catch { return null; }
}

/** Reads a stored list: migrated, one entry per origin (the first wins), bounded. */
export function normalizeDistricts(value: unknown): District[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: District[] = [];
  for (const raw of value) {
    const district = migrateDistrict(raw);
    if (!district || seen.has(district.origin)) continue;
    seen.add(district.origin);
    out.push(district);
    if (out.length === MAX_SCHOOLS) break;
  }
  return out;
}

/** A school from a legacy enrollment or SCHO-256 pairing link (portal + Workshop). */
export function legacyDistrict(details: { name: string; portal: string; workshop: string }): District {
  const district = migrateDistrict({ ...details, id: details.workshop + '|' + details.portal });
  if (!district) throw new Error('The school details are not valid.');
  return district;
}
